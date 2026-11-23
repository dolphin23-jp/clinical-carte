// 段K6：結果待ちを追う（CA-058 の A3・CA-065。docs/04 の 18）。提出・依頼と書かれた検査の候補ごとに、結果の記載があるかを AI が記号だけで返し、
// core の checkPending が確かめて、患者ごとに1つ残す（pending_results）。先生の印（結果を確かめた・外す）は、組み直しても引き継ぎ、
// 印を付けるたびに pending_result_edits に残す（印の前後だけ。打った文はない）。
//
// AI（Anthropic）に送るのは、記録から決定論で作った資料（core の pendingMaterial。識別情報を置き換えた後の記録から）だけ。外の検索はしない。
// 保存するのは、確かめた後の一覧だけ（名前は記録に書かれたもの。場所は文の id と字の範囲）。AI の答えそのものは残さない。
import {
  applyPendingMark,
  carryPendingMarks,
  checkPending,
  hasPendingCandidates,
  japanDateTime,
  orderPendingCandidates,
  type PendingBody,
  pendingBasis,
  type PendingInput,
  pendingMaterial,
  type PendingPatch,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';

import type { Db } from './db.ts';
import type { CallGate } from './documents.ts';
import type { Organizer } from './organizer.ts';
import { PENDING_PROMPT_VERSION } from './prompt.ts';
import { getRecord, type PatientRecord, pendingOf } from './records.ts';
import type { Runtime } from './runtime.ts';
import type { SelectorFailure } from './selector.ts';

/** 資料の入力を、記録から作る：外した事実・字に見つからない AI の数は除く。指示簿の検査の予定（段K11）も候補にする */
export function pendingInputOf(record: PatientRecord): PendingInput {
  const at = new Map(record.sources.map((s) => [s.id, s.at]));
  return {
    encounters: record.encounters,
    sources: record.sources,
    events: record.events.filter((e) => !e.excluded),
    course: record.course,
    observations: record.observations.filter((o) => !o.excluded && o.unseen !== true),
    orders: orderPendingCandidates(record.orders, (id) => at.get(id) ?? null),
  };
}

export type PendingOutcome =
  | { readonly ok: true; readonly body: PendingBody }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'ai_limit' }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure };

async function save(db: Db, patientId: string, runtime: Runtime, basis: string, body: PendingBody): Promise<void> {
  await db
    .prepare(
      'INSERT INTO pending_results (patient_id, made_at, prompt_version, basis, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(patient_id) DO UPDATE SET made_at = excluded.made_at, prompt_version = excluded.prompt_version, basis = excluded.basis, body = excluded.body',
    )
    .bind(patientId, japanDateTime(runtime.now()), PENDING_PROMPT_VERSION, basis, JSON.stringify(body))
    .run();
}

export async function generatePending(db: Db, patientId: string, organizer: Organizer, gate: CallGate, runtime: Runtime): Promise<PendingOutcome> {
  const record = await getRecord(db, patientId);
  if (record === null) return { ok: false, reason: 'not_found' };
  const input = pendingInputOf(record);
  const basis = pendingBasis(record.sources, input.orders ?? []);
  // 提出の候補がなければ、AI を呼ばない（空の一覧を、記録の印つきで残す。決定論）
  if (!hasPendingCandidates(input)) {
    const body: PendingBody = { items: [], orders: [], notSubmission: 0, rejected: {}, dropped: { candidates: 0, results: 0 } };
    await save(db, patientId, runtime, basis, body);
    return { ok: true, body };
  }
  const material = pendingMaterial(input);
  if (!(await gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await organizer.pending(JSON.stringify(material.payload));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  const checked = checkPending(answered.answer, material);
  const body: PendingBody = {
    items: carryPendingMarks(checked.items, record.pending?.body.items ?? []),
    orders: [...checked.orders],
    notSubmission: checked.notSubmission,
    rejected: checked.rejected,
    dropped: material.dropped,
  };
  await save(db, patientId, runtime, basis, body);
  return { ok: true, body };
}

/** 先生の印（結果を確かめた・外す・戻す）。どの項目の、どの印からどの印へを残す */
export async function markPending(db: Db, patientId: string, patch: PendingPatch, runtime: Runtime): Promise<boolean> {
  const current = pendingOf(await db.prepare('SELECT made_at, prompt_version, basis, body FROM pending_results WHERE patient_id = ?').bind(patientId).first());
  if (current === null) return false;
  const item = current.body.items.find((x) => x.key === patch.key);
  const items = applyPendingMark(current.body.items, patch);
  if (item === undefined || items === null) return false;
  await db.batch([
    db.prepare('UPDATE pending_results SET body = ? WHERE patient_id = ?').bind(JSON.stringify({ ...current.body, items }), patientId),
    db
      .prepare('INSERT INTO pending_result_edits (id, patient_id, at, item_key, before, after) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)), patientId, japanDateTime(runtime.now()), patch.key, item.mark, patch.mark),
  ]);
  return true;
}
