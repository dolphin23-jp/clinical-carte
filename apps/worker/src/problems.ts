// 問題の筋（段3a。CA-024。docs/04 の 9）：記載ごとの問題を、患者ごとの筋につなぐ。本人の直す操作（移す・分ける・統合・表示の名前）と、その履歴。
// つなぎの計算と、AI の答えの確かめは core（problems/threads.ts）。ここは、読み書きだけ。
// AI に送るのは、保存した問題の名前と、保存した文の行だけ（core の linkRequest）。AI の答えそのものは、保存もログもしない。
import {
  japanDateTime,
  type LinkReportReason,
  linkRequest,
  liveThreadId,
  planLinks,
  type ProblemMove,
  resolveLinks,
  type ThreadMention,
  type ThreadPatch,
  type ThreadRow,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';

import type { Db, Statement } from './db.ts';
import type { Organizer } from './organizer.ts';
import { type Problem, PROBLEM_COLUMNS, problemOf, type ProblemThread, threadOf } from './records.ts';
import type { Runtime } from './runtime.ts';
import type { SelectorFailure } from './selector.ts';

const present = <T>(value: T | null): value is T => value !== null;

async function threadsOf(db: Db, patientId: string): Promise<ProblemThread[]> {
  const rows = await db.prepare('SELECT id, display_name, merged_into FROM problem_threads WHERE patient_id = ? ORDER BY id').bind(patientId).all();
  return rows.results.map(threadOf).filter(present);
}

async function problemsOf(db: Db, patientId: string): Promise<Problem[]> {
  const rows = await db.prepare(`SELECT ${PROBLEM_COLUMNS} FROM problems WHERE patient_id = ? ORDER BY source_id, span_start`).bind(patientId).all();
  return rows.results.map(problemOf).filter(present);
}

const mentionOf = (p: Problem): ThreadMention => ({
  id: p.id,
  sourceId: p.sourceId,
  threadId: p.threadId,
  name: p.name,
  status: p.status,
  activity: p.activity,
  at: p.at,
  start: p.start,
  end: p.end,
});

export interface LinkOutcome {
  /** AI を呼んだか（呼んだら、1日の回数に数える） */
  readonly usedAi: boolean;
  /** AI に聞くべきだったが、聞けなかった・失敗した（つないでいない記載が残る） */
  readonly pendingLeft: number;
  readonly failure: SelectorFailure | null;
  /** AI の答えのうち、使えなかったもの（理由ごとの件数） */
  readonly report: Partial<Record<LinkReportReason, number>>;
}

/**
 * 患者の、まだ筋につないでいない記載をつなぐ。名前が同じなら決定論で。それ以外は、linker（AI）があれば AI に聞く。
 * linker がない（鍵がない・1日の上限）・AI が失敗したときは、決定論でつなげなかった記載を、つながないまま残す（あとで、つなぎ直せる）。
 */
export async function linkPatient(db: Db, patientId: string, linker: Organizer | null, runtime: Runtime): Promise<LinkOutcome> {
  const [threads, problems] = await Promise.all([threadsOf(db, patientId), problemsOf(db, patientId)]);
  const rows: ThreadRow[] = threads;
  const mentions = problems.map(mentionOf);
  const plan = planLinks(rows, mentions);
  const id = (): string => ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));
  const statements: Statement[] = [];
  const setThread = (mentionId: string, threadId: string, origin: 'rule' | 'ai'): Statement =>
    db.prepare('UPDATE problems SET thread_id = ?, thread_origin = ? WHERE id = ? AND patient_id = ?').bind(threadId, origin, mentionId, patientId);
  for (const [mentionId, threadId] of plan.rule) statements.push(setThread(mentionId, threadId, 'rule'));

  let usedAi = false;
  let failure: SelectorFailure | null = null;
  let report: Partial<Record<LinkReportReason, number>> = {};
  let pendingLeft = 0;
  if (plan.pending.length > 0) {
    let resolved: ReturnType<typeof resolveLinks> | null = null;
    if (!plan.needsAi) resolved = resolveLinks({ threadRefs: new Map(), groupRefs: new Map() }, plan.pending, null);
    else if (linker !== null) {
      const texts = new Map<string, string>();
      const needed = [...new Set(plan.pending.map((g) => g.mentions[0]?.sourceId ?? ''))];
      for (const sourceId of needed) {
        const row = await db.prepare('SELECT text FROM sources WHERE id = ? AND patient_id = ?').bind(sourceId, patientId).first();
        const body = row?.['text'];
        if (typeof body === 'string') texts.set(sourceId, body);
      }
      const request = linkRequest(rows, mentions, plan.pending, (sourceId) => texts.get(sourceId) ?? null);
      usedAi = true;
      const answered = await linker.link(request.message);
      if (answered.ok) {
        resolved = resolveLinks(request, plan.pending, answered.answer);
        report = resolved.report;
      } else failure = answered.reason;
    }
    if (resolved === null) pendingLeft = plan.pending.reduce((n, g) => n + g.mentions.length, 0);
    else {
      for (const group of resolved.groups) {
        let threadId = group.threadId;
        if (threadId === null) {
          threadId = id();
          statements.push(db.prepare('INSERT INTO problem_threads (id, patient_id) VALUES (?, ?)').bind(threadId, patientId));
        }
        for (const m of group.mentions) statements.push(setThread(m.id, threadId, plan.needsAi ? 'ai' : 'rule'));
      }
    }
  }
  if (statements.length > 0) await db.batch(statements);
  return { usedAi, pendingLeft, failure, report };
}

// ---------------------------------------------------------------------------
// 本人の操作（どれも、履歴を残す）

export type EditOutcome = { readonly ok: true } | { readonly ok: false; readonly error: 'not_found' | 'conflict' | 'bad_request' };

function history(db: Db, runtime: Runtime, patientId: string, action: 'move' | 'merge' | 'name', target: string, before: string | null, after: string | null): Statement {
  return db
    .prepare('INSERT INTO history (id, patient_id, at, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)), patientId, japanDateTime(runtime.now()), action, target, before, after);
}

async function threadRow(db: Db, id: string): Promise<(ProblemThread & { patientId: string }) | null> {
  const row = await db.prepare('SELECT id, patient_id, display_name, merged_into FROM problem_threads WHERE id = ?').bind(id).first();
  const thread = row === null ? null : threadOf(row);
  const patientId = row?.['patient_id'];
  return thread === null || typeof patientId !== 'string' ? null : { ...thread, patientId };
}

/** 記載を、別の筋へ移す（new：新しい筋に分ける）。いまの筋が expected と違えば、直さない（ほかの端末が先に直した） */
export async function moveMention(db: Db, problemId: string, body: ProblemMove, runtime: Runtime): Promise<EditOutcome> {
  const row = await db.prepare('SELECT patient_id, thread_id FROM problems WHERE id = ?').bind(problemId).first();
  const patientId = row?.['patient_id'];
  if (row === null || typeof patientId !== 'string') return { ok: false, error: 'not_found' };
  const current = typeof row['thread_id'] === 'string' ? row['thread_id'] : null;
  if (current !== body.expected) return { ok: false, error: 'conflict' };
  const statements: Statement[] = [];
  let target: string;
  if (body.thread === 'new') {
    target = ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));
    statements.push(db.prepare('INSERT INTO problem_threads (id, patient_id) VALUES (?, ?)').bind(target, patientId));
  } else {
    const thread = await threadRow(db, body.thread);
    if (thread === null || thread.patientId !== patientId) return { ok: false, error: 'not_found' };
    if (thread.mergedInto !== null || body.thread === current) return { ok: false, error: 'bad_request' };
    target = thread.id;
  }
  statements.push(db.prepare("UPDATE problems SET thread_id = ?, thread_origin = 'self' WHERE id = ?").bind(target, problemId));
  statements.push(history(db, runtime, patientId, 'move', problemId, current, target));
  await db.batch(statements);
  return { ok: true };
}

/** 筋を直す：別の筋へ統合する、または、表示の名前を、その筋に書かれた名前から選ぶ */
export async function patchThread(db: Db, threadId: string, body: ThreadPatch, runtime: Runtime): Promise<EditOutcome> {
  const thread = await threadRow(db, threadId);
  if (thread === null) return { ok: false, error: 'not_found' };
  if (thread.mergedInto !== null) return { ok: false, error: 'bad_request' };

  if ('mergeInto' in body) {
    const into = await threadRow(db, body.mergeInto);
    if (into === null || into.patientId !== thread.patientId) return { ok: false, error: 'not_found' };
    // 統合先は、統合していない、別の筋（輪を作らない）
    const all = new Map((await threadsOf(db, thread.patientId)).map((t) => [t.id, t]));
    if (into.id === thread.id || liveThreadId(all, into.id) !== into.id) return { ok: false, error: 'bad_request' };
    await db.batch([
      db.prepare("UPDATE problems SET thread_id = ?, thread_origin = 'self' WHERE thread_id = ? AND patient_id = ?").bind(into.id, thread.id, thread.patientId),
      db.prepare('UPDATE problem_threads SET merged_into = ? WHERE id = ?').bind(into.id, thread.id),
      history(db, runtime, thread.patientId, 'merge', thread.id, null, into.id),
    ]);
    return { ok: true };
  }

  // 表示の名前：その筋に書かれた名前のどれか（打った名前は使わない：打った文は選別を通す決まりのため。docs/01 の 2）
  if (body.displayName !== null) {
    const written = await db.prepare('SELECT 1 AS hit FROM problems WHERE thread_id = ? AND name = ? LIMIT 1').bind(thread.id, body.displayName).first();
    if (written === null) return { ok: false, error: 'bad_request' };
  }
  await db.batch([
    db.prepare('UPDATE problem_threads SET display_name = ? WHERE id = ?').bind(body.displayName, thread.id),
    history(db, runtime, thread.patientId, 'name', thread.id, thread.displayName, body.displayName),
  ]);
  return { ok: true };
}
