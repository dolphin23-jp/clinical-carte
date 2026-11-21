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
  reorder,
  threadViews,
  ulid,
  type UserEditField,
  type UserEditTarget,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';

import type { Db, Statement } from './db.ts';
import type { Organizer } from './organizer.ts';
import { type Problem, PROBLEM_COLUMNS, problemOf, type ProblemThread, THREAD_COLUMNS, threadOf } from './records.ts';
import type { Runtime } from './runtime.ts';
import type { SelectorFailure } from './selector.ts';

const present = <T>(value: T | null): value is T => value !== null;

async function threadsOf(db: Db, patientId: string): Promise<ProblemThread[]> {
  const rows = await db.prepare(`SELECT ${THREAD_COLUMNS} FROM problem_threads WHERE patient_id = ? ORDER BY id`).bind(patientId).all();
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
  const row = await db.prepare(`SELECT patient_id, ${THREAD_COLUMNS} FROM problem_threads WHERE id = ?`).bind(id).first();
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

/** 本人の調節の記録（CA-029。history に入らない分） */
export function userEdit(db: Db, runtime: Runtime, patientId: string, targetType: UserEditTarget, target: string, field: UserEditField, before: string | null, after: string | null): Statement {
  return db
    .prepare('INSERT INTO user_edits (id, patient_id, at, target_type, target, field, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)), patientId, japanDateTime(runtime.now()), targetType, target, field, before, after);
}

/**
 * 筋を直す：統合する・統合を解く・表示の名前を書かれた名前から選ぶ・確からしさ・状態・並び・外す（CA-029）。
 * 打って直す名前（typedName）は、ここでは受けない（選別を通す setTypedName だけ）。
 */
export async function patchThread(db: Db, threadId: string, body: ThreadPatch, runtime: Runtime): Promise<EditOutcome> {
  const thread = await threadRow(db, threadId);
  if (thread === null) return { ok: false, error: 'not_found' };
  if (thread.mergedInto !== null) return { ok: false, error: 'bad_request' };
  const patientId = thread.patientId;

  if ('typedName' in body) return { ok: false, error: 'bad_request' };

  if ('mergeInto' in body) {
    const into = await threadRow(db, body.mergeInto);
    if (into === null || into.patientId !== patientId) return { ok: false, error: 'not_found' };
    // 統合先は、統合していない、別の筋（輪を作らない）
    const all = new Map((await threadsOf(db, patientId)).map((t) => [t.id, t]));
    if (into.id === thread.id || liveThreadId(all, into.id) !== into.id) return { ok: false, error: 'bad_request' };
    // 記載は動かさず、統合先を持つだけ（統合を解けるように）。見方は統合先にまとめる
    await db.batch([db.prepare('UPDATE problem_threads SET merged_into = ? WHERE id = ?').bind(into.id, thread.id), history(db, runtime, patientId, 'merge', thread.id, null, into.id)]);
    return { ok: true };
  }

  if ('unmerge' in body) {
    const child = await threadRow(db, body.unmerge);
    if (child === null || child.patientId !== patientId) return { ok: false, error: 'not_found' };
    if (child.mergedInto !== thread.id) return { ok: false, error: 'bad_request' };
    await db.batch([db.prepare('UPDATE problem_threads SET merged_into = NULL WHERE id = ?').bind(child.id), userEdit(db, runtime, patientId, 'thread', child.id, 'unmerge', thread.id, null)]);
    return { ok: true };
  }

  if ('displayName' in body) {
    // 表示の名前：その筋（と、統合した筋）に書かれた名前のどれか。打った名前は setTypedName（選別を通す）
    if (body.displayName !== null) {
      const written = await db
        .prepare('SELECT 1 AS hit FROM problems WHERE name = ? AND thread_id IN (SELECT id FROM problem_threads WHERE id = ? OR merged_into = ?) LIMIT 1')
        .bind(body.displayName, thread.id, thread.id)
        .first();
      if (written === null) return { ok: false, error: 'bad_request' };
    }
    await db.batch([
      db.prepare('UPDATE problem_threads SET display_name = ? WHERE id = ?').bind(body.displayName, thread.id),
      history(db, runtime, patientId, 'name', thread.id, thread.displayName, body.displayName),
    ]);
    return { ok: true };
  }

  if ('status' in body) {
    await db.batch([
      db.prepare('UPDATE problem_threads SET status_override = ? WHERE id = ?').bind(body.status, thread.id),
      userEdit(db, runtime, patientId, 'thread', thread.id, 'status', thread.statusOverride, body.status),
    ]);
    return { ok: true };
  }

  if ('activity' in body) {
    await db.batch([
      db.prepare('UPDATE problem_threads SET activity_override = ? WHERE id = ?').bind(body.activity, thread.id),
      userEdit(db, runtime, patientId, 'thread', thread.id, 'activity', thread.activityOverride, body.activity),
    ]);
    return { ok: true };
  }

  if ('excluded' in body) {
    await db.batch([
      db.prepare('UPDATE problem_threads SET excluded = ? WHERE id = ?').bind(body.excluded ? 1 : 0, thread.id),
      userEdit(db, runtime, patientId, 'thread', thread.id, 'excluded', thread.excluded ? '1' : '0', body.excluded ? '1' : '0'),
    ]);
    return { ok: true };
  }

  // 並び：いまの並び（本人の番号・最初の記載の順）で1つ上・下へ。外した筋は並びに入らない
  const [threads, problems] = await Promise.all([threadsOf(db, patientId), problemsOf(db, patientId)]);
  const order = reorder(threadViews(threads, problems.map(mentionOf)).threads, thread.id, body.move);
  if (order === null) return { ok: false, error: 'bad_request' };
  const before = order.findIndex((o) => o.id === thread.id);
  await db.batch([
    ...order.map((o) => db.prepare('UPDATE problem_threads SET ord = ? WHERE id = ?').bind(o.ord, o.id)),
    userEdit(db, runtime, patientId, 'thread', thread.id, 'ord', String(body.move === 'up' ? before + 1 : before - 1), String(before)),
  ]);
  return { ok: true };
}

/** 打って直した名前（C-1）：選別を通した後の字だけを受ける（routes.ts が intake を通す）。null は、打った名前をやめる */
export async function setTypedName(db: Db, threadId: string, selected: string | null, runtime: Runtime): Promise<EditOutcome> {
  const thread = await threadRow(db, threadId);
  if (thread === null) return { ok: false, error: 'not_found' };
  if (thread.mergedInto !== null) return { ok: false, error: 'bad_request' };
  await db.batch([
    db.prepare('UPDATE problem_threads SET typed_name = ? WHERE id = ?').bind(selected, thread.id),
    userEdit(db, runtime, thread.patientId, 'thread', thread.id, 'typed_name', thread.typedName, selected),
  ]);
  return { ok: true };
}
