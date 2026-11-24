// 仕事を通信から切り離す（段N2。CA-087）と、保存しない答えを受け取るまで預かる（CA-088）。決まりは core の jobs/jobs.ts。
// - 仕事の係（createJobHost）：頼み（道・本文）をメモリで受け取り、いつもの記録の道（routes.ts の recordApi）を、通信と切り離して動かす。
//   本番は Durable Objects の中（entry.ts の CarteJobs）で動く：Cloudflare の資料（2026-11 確認）では、Durable Objects は、出ている通信
//   （AI の答えを待っているあいだ）がある限り動き続ける。頼みの字は、メモリにだけ持ち、ディスク（Durable Objects の保存先・D1）に書かない
// - 終わったら、答えを job_results に預ける（保存しない答えの種類は、確かめた後の答え。保存する種類は、成否の名前だけ。core の heldOutcome）。
//   動いているあいだの様子（相談の段階と、確かめた後の文）は、メモリだけ
// - 保存する種類（整理など）は、同じ相手に同じ種類の仕事が動いていれば、新しく始めずに、その仕事につなぐ（二重に AI を呼ばない）
// - 画面への道（handler.ts）：仕事として頼む（x-carte-job: 1）→ 番号をすぐ返す。GET /api/jobs/:id で様子と答え。DELETE で受け取った印（消す）。
//   GET /api/patients/:id/jobs で、その患者の動いている仕事と、受け取っていない答えの一覧（中身は含めない）
// ログを出さない。誤りの答えは名前だけ。
import { heldOutcome, japanDateTime, JOB_HOLD_HOURS, JOB_KINDS, type JobKind, type JobOutcome, type JobProgress, type JobSummary, SHARED_JOB_KINDS } from '@clinical-carte/core';

import { type Db, int, text } from './db.ts';
import { recordApi, type RecordDeps } from './routes.ts';

/** 仕事を始める頼み（メモリだけ。body は、頼みの本文そのもの：ディスクに書かない） */
export interface JobStart {
  readonly id: string;
  readonly path: string;
  readonly body: string;
  readonly patientId: string;
  readonly kind: JobKind;
  readonly target: string;
}

/** 仕事の係への頼み方（手元はそのまま、本番は Durable Objects を通して） */
export interface JobRunner {
  /** 始める。保存する種類で、同じ相手に動いている仕事があれば、その番号を返す */
  start(job: JobStart): Promise<{ readonly id: string }>;
  /** 様子を聞く。after は、もう受け取った出来事の数。waitMs のあいだ、新しい出来事か終わりを待つ（長く待つ聞き方） */
  progress(id: string, after: number, waitMs: number): Promise<JobProgress>;
  /** その患者の、動いている仕事と、受け取っていない答えの一覧（中身は含めない） */
  list(patientId: string): Promise<readonly JobSummary[]>;
  /** 受け取った：預かった答えを消す（メモリと保存先の両方） */
  remove(id: string): Promise<void>;
}

interface Running {
  readonly job: JobStart;
  readonly events: unknown[];
  done: JobOutcome | null;
  /** 終わった時刻（預かる時間を、メモリの側でも守る） */
  finishedAt: number | null;
  readonly waiters: Set<() => void>;
}

/** 終わった仕事を、メモリに残しておく時間（ミリ秒）：頼んだ画面が、中身ごと受け取れるように */
export const FINISHED_KEEP_MS = 120_000;

const isKind = (value: string | null): value is JobKind => value !== null && (JOB_KINDS as readonly string[]).includes(value);

/** 預かる時間を過ぎた答えを消す（仕事を始めるとき・一覧を読むとき） */
async function expire(db: Db, now: number): Promise<void> {
  await db.prepare('DELETE FROM job_results WHERE made_at < ?').bind(japanDateTime(now - JOB_HOLD_HOURS * 3_600_000)).run();
}

/** 終わった仕事の答え（預かった答え）を読む */
async function storedOutcome(db: Db, id: string, now: number): Promise<JobProgress> {
  const row = await db.prepare('SELECT kind, status, body, made_at FROM job_results WHERE id = ?').bind(id).first();
  const kind = text(row, 'kind');
  const status = int(row, 'status');
  const body = text(row, 'body');
  const madeAt = text(row, 'made_at');
  if (!isKind(kind) || status === null || body === null || madeAt === null) return { state: 'unknown' };
  if (madeAt < japanDateTime(now - JOB_HOLD_HOURS * 3_600_000)) return { state: 'unknown' };
  try {
    return { state: 'done', kind, outcome: { status, body: JSON.parse(body) as unknown } };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * 仕事の係（メモリ）。deps は、記録の道の依存（保存先・AI・書籍の検索）。本番は Durable Objects の中で、試験と手元のサーバーはそのまま使う。
 * 終わった仕事は、預けたあと、メモリから外す（預かった答えは job_results から読む）
 */
export function createJobHost(deps: () => RecordDeps): JobRunner {
  const jobs = new Map<string, Running>();

  const wake = (r: Running): void => {
    for (const w of [...r.waiters]) w();
    r.waiters.clear();
  };

  const run = async (r: Running): Promise<void> => {
    const d = deps();
    let outcome: JobOutcome;
    try {
      const request = new Request(`https://carte.internal${r.job.path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: r.job.body });
      const reply = await recordApi(request, r.job.path, d);
      if (reply === null) outcome = { status: 404, body: { error: 'not_found' } };
      else if (reply.lines !== undefined) {
        // 少しずつ返す答え（相談）：段階と確かめた後の文は、様子としてメモリに。最後の答え（done）か誤りの名前（error）が、仕事の答え
        let last: unknown = null;
        await reply.lines((event) => {
          if (typeof event === 'object' && event !== null && ('done' in event || 'error' in event)) last = event;
          else {
            r.events.push(event);
            wake(r);
          }
        });
        const end = last as { done?: unknown; error?: unknown } | null;
        outcome = end !== null && 'done' in end ? { status: 200, body: { answer: end.done } } : { status: 400, body: { error: typeof end?.error === 'string' ? end.error : 'server' } };
      } else outcome = { status: reply.status, body: reply.body };
    } catch {
      outcome = { status: 500, body: { error: 'server' } };
    }
    const held = heldOutcome(r.job.kind, outcome);
    // 先に預けてから、終わったと知らせる（知らせたあとに預けると、画面が受け取って消したあとに、預け直してしまう）
    let stored = false;
    try {
      await d.db
        .prepare('INSERT INTO job_results (id, patient_id, kind, target, status, body, made_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(r.job.id, r.job.patientId, r.job.kind, r.job.target, held.status, JSON.stringify(held.body), japanDateTime(d.runtime.now()))
        .run();
      stored = true;
    } catch {
      // 預けられなかった（患者が消えた など）：メモリの答えを、このまま返す
    }
    // メモリには、答えの中身ごと持つ（保存する種類でも、頼んだ画面は、整理した文などを受け取れる）。保存先に預けるのは held だけ
    r.done = outcome;
    r.finishedAt = d.runtime.now();
    wake(r);
    // 預けたので、しばらくしてメモリから外す（そのあいだは、頼んだ画面が中身ごと受け取れる。外したあとは、預かった答えから返す）
    if (stored) {
      setTimeout(() => {
        jobs.delete(r.job.id);
      }, FINISHED_KEEP_MS);
    }
  };

  return {
    start(job) {
      if (SHARED_JOB_KINDS.includes(job.kind)) {
        for (const r of jobs.values()) if (r.done === null && r.job.kind === job.kind && r.job.target === job.target) return Promise.resolve({ id: r.job.id });
      }
      const r: Running = { job, events: [], done: null, finishedAt: null, waiters: new Set() };
      jobs.set(job.id, r);
      const d = deps();
      void expire(d.db, d.runtime.now())
        .catch(() => undefined)
        .then(() => run(r));
      return Promise.resolve({ id: job.id });
    },

    async progress(id, after, waitMs) {
      const r = jobs.get(id);
      if (r === undefined) {
        const d = deps();
        return storedOutcome(d.db, id, d.runtime.now());
      }
      // 預かる時間を過ぎた答えは、メモリからも外す
      if (r.finishedAt !== null && deps().runtime.now() - r.finishedAt >= JOB_HOLD_HOURS * 3_600_000) {
        jobs.delete(id);
        return { state: 'unknown' };
      }
      if (r.done === null && r.events.length <= after && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            r.waiters.delete(done);
            resolve();
          }, waitMs);
          const done = (): void => {
            clearTimeout(timer);
            resolve();
          };
          r.waiters.add(done);
        });
      }
      if (r.done !== null) return { state: 'done', kind: r.job.kind, outcome: r.done };
      return { state: 'running', kind: r.job.kind, events: r.events.slice(Math.max(0, after)), next: r.events.length };
    },

    async list(patientId) {
      const d = deps();
      await expire(d.db, d.runtime.now()).catch(() => undefined);
      const running: JobSummary[] = [...jobs.values()]
        .filter((r) => r.job.patientId === patientId && r.done === null)
        .map((r) => ({ id: r.job.id, kind: r.job.kind, target: r.job.target, state: 'running', status: null, madeAt: null }));
      const rows = await d.db.prepare('SELECT id, kind, target, status, made_at FROM job_results WHERE patient_id = ? ORDER BY made_at, id').bind(patientId).all();
      const done = rows.results.flatMap((row): JobSummary[] => {
        const id = text(row, 'id');
        const kind = text(row, 'kind');
        const target = text(row, 'target');
        if (id === null || !isKind(kind) || target === null) return [];
        return [{ id, kind, target, state: 'done', status: int(row, 'status'), madeAt: text(row, 'made_at') }];
      });
      return [...running, ...done.filter((x) => !running.some((y) => y.id === x.id))];
    },

    async remove(id) {
      jobs.delete(id);
      await deps().db.prepare('DELETE FROM job_results WHERE id = ?').bind(id).run();
    },
  };
}

// ---------------------------------------------------------------------------
// 本番：Durable Objects を通して頼む（Worker の側）と、Durable Objects の中の受け口（entry.ts の CarteJobs が使う）

/** Durable Objects の名前空間（使うのは、名前から1つを選ぶことと、その fetch だけ） */
export interface JobNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

const JOBS_ORIGIN = 'https://carte-jobs.internal';

/** Worker の側：Durable Objects（1つ。名前 jobs）に頼む */
export function durableRunner(namespace: JobNamespace): JobRunner {
  const stub = () => namespace.get(namespace.idFromName('jobs'));
  const ask = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await stub().fetch(new Request(`${JOBS_ORIGIN}${path}`, init));
    if (!response.ok) throw new Error('jobs');
    return (await response.json()) as T;
  };
  return {
    start: (job) => ask<{ id: string }>('/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) }),
    progress: (id, after, waitMs) => ask<JobProgress>(`/progress?id=${encodeURIComponent(id)}&after=${String(after)}&wait=${String(waitMs)}`),
    list: (patientId) => ask<readonly JobSummary[]>(`/list?patient=${encodeURIComponent(patientId)}`),
    remove: async (id) => {
      await ask<{ removed: string }>(`/remove?id=${encodeURIComponent(id)}`, { method: 'POST' });
    },
  };
}

/** Durable Objects の中の受け口：Worker からの頼みを、仕事の係に渡す（Worker の側の durableRunner と組） */
export async function jobHostFetch(host: JobRunner, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  try {
    if (url.pathname === '/start' && request.method === 'POST') {
      const job = (await request.json()) as JobStart;
      if (typeof job.id !== 'string' || typeof job.path !== 'string' || typeof job.body !== 'string' || typeof job.patientId !== 'string' || !isKind(job.kind) || typeof job.target !== 'string') return json({ error: 'bad_request' }, 400);
      return json(await host.start(job));
    }
    if (url.pathname === '/progress' && request.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const wait = Math.min(25_000, Math.max(0, Number(url.searchParams.get('wait') ?? '0')));
      return json(await host.progress(url.searchParams.get('id') ?? '', Number.isFinite(after) ? after : 0, Number.isFinite(wait) ? wait : 0));
    }
    if (url.pathname === '/list' && request.method === 'GET') return json(await host.list(url.searchParams.get('patient') ?? ''));
    if (url.pathname === '/remove' && request.method === 'POST') {
      const id = url.searchParams.get('id') ?? '';
      await host.remove(id);
      return json({ removed: id });
    }
    return json({ error: 'not_found' }, 404);
  } catch {
    return json({ error: 'server' }, 500);
  }
}
