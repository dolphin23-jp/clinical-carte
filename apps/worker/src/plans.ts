// 段K9：予定と実施の突き合わせ（CA-058 の B2・CA-071。CA-026 の改訂。docs/04 の 21）。A/P に書いた予定の行ごとに、その後の記録に行ったことの記載があるかを、
// AI が記号だけで返し、core の checkPlans が確かめて、患者ごとに1つ残す（plan_checks）。先生の印（実施を確かめた・中止・不要・外す）は、組み直しても引き継ぎ、
// 印を付けるたびに plan_check_edits に残す（印の前後だけ。打った文はない）。
//
// AI（Anthropic）に送るのは、記録から決定論で作った資料（core の planMaterial。識別情報を置き換えた後の記録から）だけ。外の検索はしない。
// 保存するのは、確かめた後の一覧だけ（予定の字は記録に書かれたもの。場所は文の id と字の範囲。予定の日は、AI の手がかりから決定論で計算した日）。AI の答えそのものは残さない。
import { applyPlanMark, carryPlanMarks, checkPlans, hasPlanCandidates, japanDateTime, type PlanBody, planBasis, type PlanInput, planMaterial, type PlanPatch, ulid, ULID_RANDOM_BYTES } from '@clinical-carte/core';

import type { Db } from './db.ts';
import type { CallGate } from './documents.ts';
import type { Organizer } from './organizer.ts';
import { PLAN_PROMPT_VERSION } from './prompt.ts';
import { getRecord, type PatientRecord, planOf } from './records.ts';
import type { Runtime } from './runtime.ts';
import type { SelectorFailure } from './selector.ts';

/** 資料の入力を、記録から作る：外した事実・字に見つからない AI の数は除く */
export function planInputOf(record: PatientRecord): PlanInput {
  return {
    encounters: record.encounters,
    sources: record.sources,
    segments: record.segments,
    events: record.events.filter((e) => !e.excluded),
    medications: record.medications.filter((m) => !m.excluded),
    course: record.course,
    observations: record.observations.filter((o) => !o.excluded && o.unseen !== true),
  };
}

export type PlanOutcome =
  | { readonly ok: true; readonly body: PlanBody }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'ai_limit' }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure };

async function save(db: Db, patientId: string, runtime: Runtime, basis: string, body: PlanBody): Promise<void> {
  await db
    .prepare(
      'INSERT INTO plan_checks (patient_id, made_at, prompt_version, basis, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(patient_id) DO UPDATE SET made_at = excluded.made_at, prompt_version = excluded.prompt_version, basis = excluded.basis, body = excluded.body',
    )
    .bind(patientId, japanDateTime(runtime.now()), PLAN_PROMPT_VERSION, basis, JSON.stringify(body))
    .run();
}

export async function generatePlans(db: Db, patientId: string, organizer: Organizer, gate: CallGate, runtime: Runtime): Promise<PlanOutcome> {
  const record = await getRecord(db, patientId);
  if (record === null) return { ok: false, reason: 'not_found' };
  const input = planInputOf(record);
  const basis = planBasis(record.sources);
  // 予定の行がなければ、AI を呼ばない（空の一覧を、記録の印つきで残す。決定論）
  if (!hasPlanCandidates(input)) {
    const body: PlanBody = { items: [], notPlan: 0, rejected: {}, dropped: { candidates: 0, done: 0 } };
    await save(db, patientId, runtime, basis, body);
    return { ok: true, body };
  }
  const material = planMaterial(input);
  if (!(await gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await organizer.plans(JSON.stringify(material.payload));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  const checked = checkPlans(answered.answer, material);
  const body: PlanBody = {
    items: carryPlanMarks(checked.items, record.plans?.body.items ?? []),
    notPlan: checked.notPlan,
    rejected: checked.rejected,
    dropped: material.dropped,
  };
  await save(db, patientId, runtime, basis, body);
  return { ok: true, body };
}

/** 先生の印（実施を確かめた・中止・不要・外す・戻す）。どの項目の、どの印からどの印へを残す */
export async function markPlan(db: Db, patientId: string, patch: PlanPatch, runtime: Runtime): Promise<boolean> {
  const current = planOf(await db.prepare('SELECT made_at, prompt_version, basis, body FROM plan_checks WHERE patient_id = ?').bind(patientId).first());
  if (current === null) return false;
  const item = current.body.items.find((x) => x.key === patch.key);
  const items = applyPlanMark(current.body.items, patch);
  if (item === undefined || items === null) return false;
  await db.batch([
    db.prepare('UPDATE plan_checks SET body = ? WHERE patient_id = ?').bind(JSON.stringify({ ...current.body, items }), patientId),
    db
      .prepare('INSERT INTO plan_check_edits (id, patient_id, at, item_key, before, after) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)), patientId, japanDateTime(runtime.now()), patch.key, item.mark, patch.mark),
  ]);
  return true;
}
