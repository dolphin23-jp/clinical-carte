// AI の仕事を、通信から切り離す（段N2。CA-087）と、保存しない答えを受け取るまで預かる（CA-088）。
// - 仕事として頼むと、番号をすぐ返し、仕事は係が続ける。様子（相談の段階と確かめた後の文）は、メモリだけ。終わったら、答えを job_results に預ける
// - 預かるのは、保存しない答えの種類の、確かめた後の答えだけ（保存する種類は成否だけ）。問い・頼みの字は、どの表にも入らない
// - 受け取ったら消す。預かる時間を過ぎたら消す。患者を消すと消える。保存する種類は、同じ相手に動いていれば、その仕事につなぐ（二重に呼ばない）
// - 本番の Durable Objects の包み（entry.ts の CarteJobs）も、同じ係を通す
// AI は試験の代役。文はすべて架空（synthetic）。
import type { ConsultReply, JobProgress, JobSummary, OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { CarteJobs } from '../src/entry.ts';
import { createJobHost, durableRunner, type JobNamespace, type JobRunner } from '../src/jobs.ts';

const fail = (): never => {
  throw new Error('係がない');
};
import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '五郎'].join('');
const NOTE = `${NAME}さん。\n【現病歴】\n3日前から発熱あり。\n#1 発熱\nA) 肺炎を疑う\nP) 抗菌薬を検討`;
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'present_illness', start: '【現病歴】', when: null },
    { label: 'problem_heading', start: '#1 発熱', when: null },
    { label: 'assessment', start: 'A) 肺炎', when: null },
    { label: 'plan', start: 'P) 抗菌薬', when: null },
  ],
  problems: [{ name: '#1 発熱', status: 'problem', activity: null }],
};
const QUESTION = '方針は？（架空の問い・照合用）';

async function setup(docs: FakeDocAnswers = {}, gate?: Promise<void>) {
  const base = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, {
    consult: (message) => {
      const m = JSON.parse(message) as { records: { ref: string }[] };
      return { ok: true, answer: { statements: [{ section: 'summary', text: '発熱があり、肺炎を疑っている段階。', support: [m.records[0]?.ref ?? ''], citations: [] }], unknown: '' } };
    },
    ...docs,
  });
  // gate があれば、整理の答えをそこまで待たせる（動いているあいだを、試験で見るため）
  const organizer = gate === undefined ? base : { ...base, organize: async (...args: Parameters<typeof base.organize>) => (await gate, base.organize(...args)) };
  // 仕事の係は、試験の世界と同じ保存先・時計を使う（世界を作ってから、係をつなぐ）
  const holder: { jobs: JobRunner | null } = { jobs: null };
  const through: JobRunner = {
    start: (job) => (holder.jobs ?? fail()).start(job),
    progress: (id, after, wait) => (holder.jobs ?? fail()).progress(id, after, wait),
    list: (patientId) => (holder.jobs ?? fail()).list(patientId),
    remove: (id) => (holder.jobs ?? fail()).remove(id),
  };
  const w = world({ selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer, jobs: through });
  holder.jobs = createJobHost(() => ({ db: w.db, runtime: w.deps.runtime, selector: w.deps.selector, dailyAiLimit: 0, model: 'test-model', organizer, books: null }));
  const jobs = holder.jobs;
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 70, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'admission_note', authorRole: 'self', at: '2026-11-20T10:30', text: NOTE } });
  const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
  const asJob = (path: string, body: unknown) => w.call('POST', path, { cookie, body, headers: { 'x-carte-job': '1' } });
  const progress = async (id: string, after = 0, wait = false): Promise<JobProgress> => (await (await w.call('GET', `/api/jobs/${id}?after=${String(after)}${wait ? '&wait=1' : ''}`, { cookie })).json()) as JobProgress;
  const until = async (id: string): Promise<JobProgress> => {
    for (let i = 0; i < 50; i += 1) {
      const p = await progress(id);
      if (p.state !== 'running') return p;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('終わらない');
  };
  return { w, cookie, jobs, organizer: base, patientId: created.patient.id, encounterId: created.encounter.id, sourceId, asJob, progress, until };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const everything = (s: Setup): string => {
  const tables = (s.w.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  return JSON.stringify(tables.map((t) => s.w.db.raw.prepare(`SELECT * FROM ${t}`).all()));
};

describe('仕事を通信から切り離す（CA-087）・答えを預かる（CA-088）', () => {
  test('相談：番号をすぐ返し、様子（段階と、確かめた後の文）を聞ける。答えは預かり、受け取ったら消える。問いの字は、どの表にも入らない', async () => {
    const s = await setup();
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    const started = await s.asJob(`/api/patients/${s.patientId}/consult`, { question: QUESTION, turns: [], web: false, past: false, stream: true });
    expect(started.status).toBe(202);
    const { job } = (await started.json()) as { job: string };
    const done = await s.until(job);
    expect(done.state).toBe('done');
    if (done.state !== 'done') throw new Error('終わっていない');
    expect(done.kind).toBe('consult');
    expect(done.outcome.status).toBe(200);
    const reply = (done.outcome.body as { answer: ConsultReply }).answer;
    expect(reply.statements.map((x) => x.text)).toEqual(['発熱があり、肺炎を疑っている段階。（推論）']);
    // 預かっている：答えだけ（問いの字は、どの表にもない）
    const rows = s.w.db.raw.prepare('SELECT * FROM job_results').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['body', 'id', 'kind', 'made_at', 'patient_id', 'status', 'target']);
    expect(rows[0]).toMatchObject({ id: job, kind: 'consult', target: s.patientId, patient_id: s.patientId, status: 200 });
    expect(everything(s)).not.toContain('照合用');
    expect(String(rows[0]?.['body'])).toContain('肺炎を疑っている段階');
    // 読み込み直したあとでも、患者の一覧から拾える（中身は含めない）
    const list = ((await (await s.w.call('GET', `/api/patients/${s.patientId}/jobs`, { cookie: s.cookie })).json()) as { jobs: JobSummary[] }).jobs;
    expect(list).toEqual([{ id: job, kind: 'consult', target: s.patientId, state: 'done', status: 200, madeAt: expect.any(String) as string }]);
    // 受け取った → 消える。もう一度聞くと「知らない仕事」
    expect((await s.w.call('DELETE', `/api/jobs/${job}`, { cookie: s.cookie })).status).toBe(200);
    expect(s.w.db.raw.prepare('SELECT count(*) AS n FROM job_results').get()).toEqual({ n: 0 });
    expect(await s.progress(job)).toEqual({ state: 'unknown' });
  });

  test('保存する種類（整理）：結果は記録に入り、預かるのは成否だけ（中身は預からない）。動いているあいだに同じ整理を頼むと、同じ仕事につなぐ', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const s = await setup({}, gate);
    const first = ((await (await s.asJob(`/api/sources/${s.sourceId}/organize`, {})).json()) as { job: string }).job;
    const second = ((await (await s.asJob(`/api/sources/${s.sourceId}/organize`, {})).json()) as { job: string }).job;
    expect(second).toBe(first);
    const running = await s.progress(first);
    expect(running).toMatchObject({ state: 'running', kind: 'organize' });
    // 動いている仕事も、患者の一覧に出る
    const list = ((await (await s.w.call('GET', `/api/patients/${s.patientId}/jobs`, { cookie: s.cookie })).json()) as { jobs: JobSummary[] }).jobs;
    expect(list).toEqual([{ id: first, kind: 'organize', target: s.sourceId, state: 'running', status: null, madeAt: null }]);
    open();
    const done = await s.until(first);
    // 頼んだ画面は、メモリから、整理した文ごと受け取る。保存先に預けるのは、成否だけ（中身なし）
    expect(done).toMatchObject({ state: 'done', kind: 'organize', outcome: { status: 200 } });
    if (done.state !== 'done') throw new Error('終わっていない');
    expect((done.outcome.body as { source: { organized: string } }).source.organized).toBe('done');
    expect(s.organizer.seen).toHaveLength(1);
    expect(s.w.db.raw.prepare('SELECT organized FROM sources').get()).toEqual({ organized: 'done' });
    expect(s.w.db.raw.prepare('SELECT body FROM job_results').get()).toEqual({ body: '{}' });
  });

  test('長く待つ聞き方：新しい出来事か終わりまで待つ。誤りは、名前だけを預かる', async () => {
    const s = await setup({ consult: () => ({ ok: false, reason: 'unavailable' }) });
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    const job = ((await (await s.asJob(`/api/patients/${s.patientId}/consult`, { question: QUESTION, turns: [], web: false, past: false, stream: true })).json()) as { job: string }).job;
    const waited = await s.progress(job, 0, true);
    // 段階の出来事か、終わりのどちらか（待たずに空で返さない）
    expect(waited.state === 'done' || (waited.state === 'running' && waited.events.length > 0)).toBe(true);
    const done = await s.until(job);
    expect(done).toEqual({ state: 'done', kind: 'consult', outcome: { status: 400, body: { error: 'ai_unavailable' } } });
    expect(everything(s)).not.toContain('照合用');
  });

  test('仕事にできない頼み・知らない相手・形の違う番号は、仕事にしない（これまでどおり、要求の中で動く・断る）', async () => {
    const s = await setup();
    // 仕事にできない道は、これまでどおり（文を入れる）
    const plain = await s.asJob(`/api/encounters/${s.encounterId}/sources`, { kind: 'memo', authorRole: 'self', at: null, text: '架空のメモ' });
    expect(plain.status).toBe(200);
    // 知らない相手
    expect((await s.asJob('/api/sources/01HZZZZZZZZZZZZZZZZZZZZZZZ/organize', {})).status).toBe(404);
    expect((await s.w.call('GET', '/api/jobs/not-an-id', { cookie: s.cookie })).status).toBe(400);
    expect(await s.progress('01HZZZZZZZZZZZZZZZZZZZZZZZ')).toEqual({ state: 'unknown' });
    // 印のない頼みは、これまでどおり要求の中で動く
    const inline = await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    expect(inline.status).toBe(200);
    expect(s.w.db.raw.prepare('SELECT count(*) AS n FROM job_results').get()).toEqual({ n: 0 });
  });

  test('預かる時間を過ぎた答えは消える。患者を消すと、預かった答えも消える', async () => {
    const s = await setup();
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    const job = ((await (await s.asJob(`/api/patients/${s.patientId}/consult`, { question: QUESTION, turns: [], web: false, past: false, stream: true })).json()) as { job: string }).job;
    await s.until(job);
    expect(s.w.db.raw.prepare('SELECT count(*) AS n FROM job_results').get()).toEqual({ n: 1 });
    // 25 時間たつ
    s.w.clock.ms += 25 * 3_600_000;
    expect(await s.progress(job)).toEqual({ state: 'unknown' });
    await s.w.call('GET', `/api/patients/${s.patientId}/jobs`, { cookie: s.cookie });
    expect(s.w.db.raw.prepare('SELECT count(*) AS n FROM job_results').get()).toEqual({ n: 0 });

    const again = ((await (await s.asJob(`/api/patients/${s.patientId}/consult`, { question: QUESTION, turns: [], web: false, past: false, stream: true })).json()) as { job: string }).job;
    await s.until(again);
    expect(s.w.db.raw.prepare('SELECT count(*) AS n FROM job_results').get()).toEqual({ n: 1 });
    expect((await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie })).status).toBe(200);
    expect(s.w.db.raw.prepare('SELECT count(*) AS n FROM job_results').get()).toEqual({ n: 0 });
  });

  test('本番の包み（Durable Objects の CarteJobs）も、同じ係を通す：Worker の側（durableRunner）からの頼みを受ける', async () => {
    const s = await setup();
    const env = { DB: s.w.db, CARTE_KEY: 'x', ANTHROPIC_API_KEY: '' } as unknown as ConstructorParameters<typeof CarteJobs>[1];
    const object = new CarteJobs(null, env);
    const namespace: JobNamespace = { idFromName: (name) => name, get: () => ({ fetch: (request) => object.fetch(request) }) };
    const runner = durableRunner(namespace);
    // 鍵のない設定では、AI が要る仕事は「鍵がない」で終わる（係は、記録の道をそのまま動かしている）
    const started = await runner.start({ id: '01HZZZZZZZZZZZZZZZZZZZZZZY', path: `/api/sources/${s.sourceId}/organize`, body: '{}', patientId: s.patientId, kind: 'organize', target: s.sourceId });
    expect(started).toEqual({ id: '01HZZZZZZZZZZZZZZZZZZZZZZY' });
    let p: JobProgress = { state: 'unknown' };
    for (let i = 0; i < 50 && p.state !== 'done'; i += 1) {
      p = await runner.progress(started.id, 0, 0);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(p).toEqual({ state: 'done', kind: 'organize', outcome: { status: 503, body: { error: 'no_ai' } } });
    expect(await runner.list(s.patientId)).toEqual([{ id: started.id, kind: 'organize', target: s.sourceId, state: 'done', status: 503, madeAt: expect.any(String) as string }]);
    // 形の違う頼みは断る
    expect((await object.fetch(new Request('https://carte-jobs.internal/start', { method: 'POST', body: JSON.stringify({ id: 1 }) }))).status).toBe(400);
  });
});
