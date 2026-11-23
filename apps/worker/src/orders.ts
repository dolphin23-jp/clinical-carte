// 段K11：指示簿（CA-074〜CA-079。docs/04 の 23）。受診ごとに1つの指示簿（order_sheets）と、直した記録（order_edits。文は入らない）、
// 全患者に共通のスケールのテンプレ（order_templates。患者に付かない）。
//
// 字の扱い（CA-079）：
// - 写した項目の欄のうち、元の記載のその場所の字にそのままあるものは、保存した文の字（識別情報を置き換えた後）なので、選別を通さない
// - それ以外の字（先生が打った・直した字、AI の案の字、AI の案の根拠の短い名前）は、まとめて1回の選別（intake。C-1）を通した後の字を残す。選別が要るときだけ AI の 1 回に数える
// - テンプレの字は、患者の情報ではない施設の内容なので、選別には通さず、識別情報の形（電話・メール・郵便番号・長い数字）があれば断る（core の templateProblem）
//
// AI（Anthropic）に送るもの：写すときは、選んだ記載の保存した字だけ。案を出すときは、記録から決定論で作った資料（臨床支援と同じ）・確かめた後の臨床支援・テンプレ・いまの指示。
// 外の検索はしない。AI の答えは保存しない（画面に案として返すだけ。先生が採用した項目だけを、足す要求で保存する）。病院のカルテへ戻す向きはない（CA-001・CA-033）。
import {
  checkPropose,
  checkTranscribe,
  editOrderItem,
  type OrderAdd,
  type OrderCategory,
  type OrderFields,
  type OrderItem,
  ORDER_ITEMS_MAX,
  ORDER_TEXT_FIELDS,
  type OrderNew,
  newOrderItem,
  orderFieldsProblem,
  orderNewProblem,
  orderNumbersIn,
  type OrderPatch,
  type OrderProposal,
  type OrderTextField,
  proposeMaterial,
  proposeMessage,
  type ProposeRejectReason,
  type ScaleTemplateBody,
  setOrderScale,
  setOrderStatus,
  supportMaterial,
  type TranscribeRejectReason,
  templateProblem,
  transcribeMessage,
  verbatimFields,
  japanDateTime,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';

import { selectTexts } from './ap.ts';
import { supportInputOf } from './clinicalsupport.ts';
import type { Db, Statement } from './db.ts';
import type { CallGate } from './documents.ts';
import type { Organizer } from './organizer.ts';
import { type Encounter, getEncounter, getRecord, listOrderTemplates, orderSheetOf, orderTemplateOf, type PatientRecord } from './records.ts';
import type { Runtime } from './runtime.ts';
import type { Selector, SelectorFailure } from './selector.ts';

const newId = (runtime: Runtime): string => ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));

async function sheetOf(db: Db, encounterId: string): Promise<OrderItem[]> {
  const row = await db.prepare('SELECT encounter_id, items, updated_at FROM order_sheets WHERE encounter_id = ?').bind(encounterId).first();
  return orderSheetOf(row)?.items ?? [];
}

function saveSheet(db: Db, encounter: Encounter, items: readonly OrderItem[], now: string): Statement {
  return db
    .prepare('INSERT INTO order_sheets (encounter_id, patient_id, items, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(encounter_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at')
    .bind(encounter.id, encounter.patientId, JSON.stringify(items), now);
}

function edit(db: Db, runtime: Runtime, encounter: Encounter, itemId: string, action: 'add' | 'edit' | 'stop' | 'restart' | 'scale' | 'delete', origin: OrderItem['origin']): Statement {
  return db
    .prepare('INSERT INTO order_edits (id, patient_id, encounter_id, at, item_id, action, origin) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(runtime), encounter.patientId, encounter.id, japanDateTime(runtime.now()), itemId, action, origin);
}

export type OrderOutcome =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly error: 'not_found' | 'bad_request' | 'too_many' | 'no_ai' | 'ai_limit' | 'selection' }
  | { readonly ok: false; readonly error: 'ai'; readonly failure: SelectorFailure };

/** 元の字（写した記載のその場所の字）。その患者の文で、場所が字の中のときだけ。場所がない項目は null、その患者の文の外なら undefined */
async function spanOf(db: Db, patientId: string, from: { sourceId: string; start: number; end: number } | null): Promise<string | null | undefined> {
  if (from === null) return null;
  const row = await db.prepare('SELECT patient_id, text FROM sources WHERE id = ?').bind(from.sourceId).first();
  const text = row?.['text'];
  if (row === null || row['patient_id'] !== patientId || typeof text !== 'string' || from.end > text.length) return undefined;
  return text.slice(from.start, from.end);
}

interface Pending {
  readonly index: number;
  readonly field: OrderTextField | 'basis';
  readonly basisIndex?: number;
  readonly text: string;
}

/**
 * 欄の字を、選別に通す（そのままの写した字は通さない）。選別が要らなければ AI を呼ばない。
 * 返すのは、置き換えた後の欄（同じ並び）
 */
async function selectFields<T extends Pick<OrderNew, OrderTextField | 'basis'>>(
  items: readonly T[],
  verbatim: readonly Set<OrderTextField>[],
  deps: { readonly selector: Selector | null; readonly gate: CallGate },
): Promise<{ ok: true; items: T[] } | Exclude<OrderOutcome, { ok: true }>> {
  const pending: Pending[] = [];
  items.forEach((item, index) => {
    for (const field of ORDER_TEXT_FIELDS) {
      const v = item[field];
      if (v.trim() !== '' && !(verbatim[index]?.has(field) ?? false)) pending.push({ index, field, text: v });
    }
    item.basis.forEach((b, basisIndex) => {
      pending.push({ index, field: 'basis', basisIndex, text: b.label });
    });
  });
  if (pending.length === 0) return { ok: true, items: [...items] };
  if (deps.selector === null) return { ok: false, error: 'no_ai' };
  if (!(await deps.gate.take())) return { ok: false, error: 'ai_limit' };
  const selected = await selectTexts(
    pending.map((p) => p.text),
    deps.selector,
  );
  if (!selected.ok) return selected.error === 'ai' ? { ok: false, error: 'ai', failure: selected.failure } : selected.error === 'empty' ? { ok: false, error: 'bad_request' } : { ok: false, error: 'selection' };
  const out = items.map((item) => ({ ...item, basis: [...item.basis] }));
  pending.forEach((p, i) => {
    const text = selected.texts[i] ?? '';
    const target = out[p.index];
    if (target === undefined) return;
    if (p.field === 'basis') {
      const b = target.basis[p.basisIndex ?? 0];
      if (b !== undefined) target.basis[p.basisIndex ?? 0] = { ...b, label: text };
    } else target[p.field] = text;
  });
  return { ok: true, items: out };
}

/** 項目を足す（先生が打った・テンプレから・AI の案を採用した・記録の文から写した）。字は選別を通す（そのままの写した字を除く） */
export async function addOrders(db: Db, encounterId: string, body: OrderAdd, deps: { readonly selector: Selector | null; readonly gate: CallGate; readonly runtime: Runtime }): Promise<OrderOutcome> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return { ok: false, error: 'not_found' };
  if (body.items.some((i) => orderNewProblem(i) !== null)) return { ok: false, error: 'bad_request' };
  const current = await sheetOf(db, encounterId);
  if (current.length + body.items.length > ORDER_ITEMS_MAX) return { ok: false, error: 'too_many' };
  const verbatim: Set<OrderTextField>[] = [];
  for (const item of body.items) {
    const span = await spanOf(db, encounter.patientId, item.from);
    if (span === undefined) return { ok: false, error: 'bad_request' };
    verbatim.push(item.origin === 'transcribed' ? verbatimFields(item, span) : new Set());
  }
  const selected = await selectFields(body.items, verbatim, deps);
  if (!selected.ok) return selected;
  const now = japanDateTime(deps.runtime.now());
  const added = selected.items.map((item) => newOrderItem(newId(deps.runtime), item, now));
  await db.batch([saveSheet(db, encounter, [...current, ...added], now), ...added.map((a) => edit(db, deps.runtime, encounter, a.id, 'add', a.origin))]);
  return { ok: true, ids: added.map((a) => a.id) };
}

/** 項目を直す：欄（字は選別を通す。元の字にそのままある写した字は通さない）・中止／再開・スケールの体重と段（数だけ） */
export async function patchOrder(db: Db, encounterId: string, itemId: string, patch: OrderPatch, deps: { readonly selector: Selector | null; readonly gate: CallGate; readonly runtime: Runtime }): Promise<OrderOutcome> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return { ok: false, error: 'not_found' };
  const items = await sheetOf(db, encounterId);
  const index = items.findIndex((i) => i.id === itemId);
  const item = items[index];
  if (item === undefined) return { ok: false, error: 'not_found' };
  const now = japanDateTime(deps.runtime.now());
  let next: OrderItem | null;
  let action: 'edit' | 'stop' | 'restart' | 'scale';
  if ('fields' in patch) {
    if (orderFieldsProblem(patch.fields) !== null) return { ok: false, error: 'bad_request' };
    const span = await spanOf(db, encounter.patientId, item.from);
    // 元の字の文が消えていたら、写した字も選別を通す
    const verbatim = item.origin === 'transcribed' && span !== undefined ? verbatimFields(patch.fields, span) : new Set<OrderTextField>();
    const selected = await selectFields([{ ...patch.fields, basis: [] }], [verbatim], deps);
    if (!selected.ok) return selected;
    const chosen = selected.items[0];
    if (chosen === undefined) return { ok: false, error: 'selection' };
    const rest: OrderFields = { ...patch.fields };
    for (const f of ORDER_TEXT_FIELDS) rest[f] = chosen[f];
    next = editOrderItem(item, rest, now, orderNumbersIn);
    action = 'edit';
  } else if ('status' in patch) {
    next = setOrderStatus(item, patch.status, now);
    action = patch.status === 'stopped' ? 'stop' : 'restart';
  } else {
    next = setOrderScale(item, patch.weightKg, patch.step, now);
    action = 'scale';
  }
  if (next === null) return { ok: false, error: 'bad_request' };
  if (next === item) return { ok: true, ids: [itemId] };
  const updated = [...items];
  updated[index] = next;
  await db.batch([saveSheet(db, encounter, updated, now), edit(db, deps.runtime, encounter, itemId, action, item.origin)]);
  return { ok: true, ids: [itemId] };
}

/** 項目を消す（入れ間違い。直した記録に「消した」を残す。文は残さない） */
export async function deleteOrder(db: Db, encounterId: string, itemId: string, runtime: Runtime): Promise<boolean> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return false;
  const items = await sheetOf(db, encounterId);
  const item = items.find((i) => i.id === itemId);
  if (item === undefined) return false;
  const now = japanDateTime(runtime.now());
  await db.batch([
    saveSheet(
      db,
      encounter,
      items.filter((i) => i.id !== itemId),
      now,
    ),
    edit(db, runtime, encounter, itemId, 'delete', item.origin),
  ]);
  return true;
}

export type ProposalOutcome =
  | { readonly ok: true; readonly proposals: readonly OrderProposal[]; readonly counts: { readonly notOrder: number; readonly cleared: number; readonly shapes: number; readonly rejected: Partial<Record<TranscribeRejectReason | ProposeRejectReason, number>> } }
  | { readonly ok: false; readonly reason: 'not_found' | 'empty' | 'ai_limit' }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure };

/** 記録の文から写す（AI の 1 回）：その記載の保存した字だけを送り、引用を確かめた項目を案として返す（保存しない） */
export async function transcribeOrders(db: Db, encounterId: string, sourceId: string, deps: { readonly organizer: Organizer; readonly gate: CallGate }): Promise<ProposalOutcome> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return { ok: false, reason: 'not_found' };
  const row = await db.prepare('SELECT id, encounter_id, kind, at, text FROM sources WHERE id = ?').bind(sourceId).first();
  if (row === null || row['encounter_id'] !== encounterId || typeof row['text'] !== 'string' || typeof row['kind'] !== 'string') return { ok: false, reason: 'not_found' };
  const source = { id: sourceId, kind: row['kind'] as Parameters<typeof transcribeMessage>[0]['kind'], at: typeof row['at'] === 'string' ? row['at'] : null, text: row['text'] };
  if (source.text.trim() === '') return { ok: false, reason: 'empty' };
  if (!(await deps.gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await deps.organizer.orderTranscribe(transcribeMessage(source));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  const checked = checkTranscribe(answered.answer, source);
  return { ok: true, proposals: checked.proposals, counts: { notOrder: checked.notOrder, cleared: checked.cleared, shapes: 0, rejected: checked.rejected } };
}

/** 資料：臨床支援と同じ記録の資料（いまの受診）・確かめた後の臨床支援・テンプレ・この受診の指示簿 */
export async function proposeInputOf(db: Db, record: PatientRecord, encounterId: string, categories: readonly OrderCategory[], today: string) {
  const support = supportInputOf(record, today);
  if (support === null) return null;
  return {
    support: supportMaterial(support),
    findings: record.support?.body ?? null,
    templates: await listOrderTemplates(db),
    orders: record.orders.find((s) => s.encounterId === encounterId)?.items ?? [],
    categories,
  };
}

/** AI の案を出す（AI の 1 回）：資料にない数には※、識別情報の形は伏せる。保存しない（先生が採用した項目だけを、足す要求で保存する） */
export async function proposeOrders(
  db: Db,
  encounterId: string,
  categories: readonly OrderCategory[],
  deps: { readonly organizer: Organizer; readonly gate: CallGate; readonly today: string },
): Promise<ProposalOutcome> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return { ok: false, reason: 'not_found' };
  const record = await getRecord(db, encounter.patientId);
  if (record === null) return { ok: false, reason: 'not_found' };
  // 案は、いまの受診（いちばん新しい受診）の指示簿にだけ出す（資料がいまの受診の記録なので）
  if (record.encounters.at(-1)?.id !== encounterId) return { ok: false, reason: 'empty' };
  const input = await proposeInputOf(db, record, encounterId, categories, deps.today);
  if (input === null) return { ok: false, reason: 'empty' };
  // 記録がまったくなければ、AI を呼ばない
  if (record.sources.filter((s) => s.encounterId === encounterId).length === 0) return { ok: false, reason: 'empty' };
  const material = proposeMaterial(input);
  if (!(await deps.gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await deps.organizer.orderPropose(proposeMessage(material));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  const checked = checkPropose(answered.answer, material);
  return { ok: true, proposals: checked.proposals, counts: { notOrder: 0, cleared: 0, shapes: checked.shapes, rejected: checked.rejected } };
}

// ---------------------------------------------------------------------------
// テンプレ（全患者に共通。患者に付かない）

export type TemplateOutcome = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: 'not_found' | 'shape' };

export async function addTemplate(db: Db, body: ScaleTemplateBody, runtime: Runtime): Promise<TemplateOutcome> {
  if (templateProblem(body) !== null) return { ok: false, error: 'shape' };
  const id = newId(runtime);
  const now = japanDateTime(runtime.now());
  await db.prepare('INSERT INTO order_templates (id, body, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, JSON.stringify(body), now, now).run();
  return { ok: true, id };
}

export async function patchTemplate(db: Db, id: string, body: ScaleTemplateBody, runtime: Runtime): Promise<TemplateOutcome> {
  if (templateProblem(body) !== null) return { ok: false, error: 'shape' };
  const current = orderTemplateOf(await db.prepare('SELECT id, body, created_at, updated_at FROM order_templates WHERE id = ? AND removed_at IS NULL').bind(id).first());
  if (current === null) return { ok: false, error: 'not_found' };
  await db.prepare('UPDATE order_templates SET body = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(body), japanDateTime(runtime.now()), id).run();
  return { ok: true, id };
}

/** 外す（行は消さず、外した日時を入れる。入れた指示は、入れたときのテンプレの中身を持つので変わらない） */
export async function removeTemplate(db: Db, id: string, runtime: Runtime): Promise<boolean> {
  const r = await db.prepare('UPDATE order_templates SET removed_at = ? WHERE id = ? AND removed_at IS NULL').bind(japanDateTime(runtime.now()), id).run();
  return (r.meta?.changes ?? 0) > 0;
}
