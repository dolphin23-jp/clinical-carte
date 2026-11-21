// AI のプロブレムリスト（CA-057）：記録全体から AI がリストを組み、core の checkProblemList で確かめて、患者ごとに1つ残す（problem_lists）。
// 組み直すときは、先生の直しを引き継ぐ（carryListEdits）。先生の直しは problem_list_edits に残す（名前は選別 C-1 を通した後の字）。
// AI に送るのは、保存した問題の名前・評価と方針の文の一部・経過の出来事の要約・できごと・薬・検査の値（どれも識別情報を置き換えた後の記録から）だけ。
import {
  applyListPatch,
  carryListEdits,
  checkProblemList,
  type CheckedList,
  japanDateTime,
  type ListCourse,
  type ListItem,
  listBasis,
  listMaterial,
  type ListPatch,
  type ListThread,
  medicationTimeline,
  MEDICATION_ACTION_NAMES,
  EVENT_KIND_NAMES,
  problemNotes,
  threadViews,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';

import { selectTexts, type SelectOutcome } from './ap.ts';
import type { Db } from './db.ts';
import type { CallGate } from './documents.ts';
import type { Organizer } from './organizer.ts';
import { PLIST_PROMPT_VERSION } from './prompt.ts';
import { getRecord, type PatientRecord, problemListOf } from './records.ts';
import type { Runtime } from './runtime.ts';
import type { Selector, SelectorFailure } from './selector.ts';

const NOTE_MAX = 300;

/** 資料の入力を、記録から作る（AI を呼ぶ前に、空かどうかを見るため、分けてある） */
export function listInputOf(record: PatientRecord) {
  const views = threadViews(record.problemThreads, record.problems).threads;
  const all = views.flatMap((t) => t.mentions);
  const textOf = new Map(record.sources.map((s) => [s.id, s.text]));
  const threads: ListThread[] = views.map((t) => {
    const notes = problemNotes(t.mentions, record.segments, all);
    const lastSource = notes.at(-1)?.sourceId;
    const lastNote = notes
      .filter((n) => n.sourceId === lastSource)
      .map((n) => (textOf.get(n.sourceId) ?? '').slice(n.start, n.end).trim())
      .join('\n')
      .slice(0, NOTE_MAX);
    return { id: t.id, name: t.name, status: t.status, group: t.group, first: t.first, last: t.last, lastNote };
  });
  const course: ListCourse[] = record.course.map((c) => ({ sourceId: c.sourceId, start: c.start, at: c.at, atApprox: c.atApprox, category: c.category, summary: c.summary }));
  const events = record.events.filter((e) => !e.excluded).map((e) => ({ at: e.at, kind: EVENT_KIND_NAMES[e.kind], title: e.title }));
  const medications = medicationTimeline(record.medications.filter((m) => !m.excluded)).map((line) => {
    const last = line.entries.at(-1);
    const fact = record.medications.find((m) => m.id === last?.id);
    return { name: line.name, last: `${fact?.at ?? '日時不明'} ${fact?.action === null || fact?.action === undefined ? '動きの記載なし' : MEDICATION_ACTION_NAMES[fact.action]}${fact?.doseText === null || fact?.doseText === undefined ? '' : ` ${fact.doseText}`}` };
  });
  const byName = new Map<string, string[]>();
  for (const o of record.observations.filter((x) => !x.excluded && x.kind === 'lab')) {
    const key = o.name ?? o.nameRaw;
    byName.set(key, [...(byName.get(key) ?? []), `${o.at ?? '日時不明'} ${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`]);
  }
  const labs = [...byName].map(([name, values]) => ({ name, values: values.slice(-5).join('、') })).slice(0, 60);
  return { patient: { age: record.patient.age, sex: record.patient.sex === 'male' ? '男' : record.patient.sex === 'female' ? '女' : 'その他・不明' }, threads, course, events, medications, labs, previous: record.problemList?.items ?? [] };
}

export type ListOutcome =
  | { readonly ok: true; readonly items: readonly ListItem[]; readonly rejected: CheckedList['rejected']; readonly shapes: number }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'empty' }
  | { readonly ok: false; readonly reason: 'ai_limit' }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure };

export async function generateList(db: Db, patientId: string, organizer: Organizer, gate: CallGate, runtime: Runtime): Promise<ListOutcome> {
  const record = await getRecord(db, patientId);
  if (record === null) return { ok: false, reason: 'not_found' };
  const input = listInputOf(record);
  if (input.threads.length === 0 && input.course.length === 0) return { ok: false, reason: 'empty' };
  const material = listMaterial(input);
  if (!(await gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await organizer.problemList(material.message);
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  const checked = checkProblemList(answered.answer, material);
  const items = carryListEdits(checked.items, input.previous, () => ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)));
  await db
    .prepare(
      'INSERT INTO problem_lists (patient_id, made_at, prompt_version, basis, items) VALUES (?, ?, ?, ?, ?) ON CONFLICT(patient_id) DO UPDATE SET made_at = excluded.made_at, prompt_version = excluded.prompt_version, basis = excluded.basis, items = excluded.items',
    )
    .bind(patientId, japanDateTime(runtime.now()), PLIST_PROMPT_VERSION, listBasis(record.sources), JSON.stringify(items))
    .run();
  return { ok: true, items, rejected: checked.rejected, shapes: checked.shapes };
}

export type ListPatchOutcome = { readonly ok: true } | { readonly ok: false; readonly error: 'not_found' } | Exclude<SelectOutcome, { ok: true }>;

/** 先生の直し：名前は選別を通す。どの欄を直したかを problem_list_edits に残す */
export async function patchList(db: Db, patientId: string, patch: ListPatch, selector: Selector | null, runtime: Runtime): Promise<ListPatchOutcome> {
  const current = problemListOf(await db.prepare('SELECT made_at, prompt_version, basis, items FROM problem_lists WHERE patient_id = ?').bind(patientId).first());
  if (current === null) return { ok: false, error: 'not_found' };
  const item = current.items.find((x) => x.key === patch.key);
  if (item === undefined) return { ok: false, error: 'not_found' };
  let applied: ListPatch = patch;
  if ('name' in patch) {
    if (selector === null) return { ok: false, error: 'selection' };
    const selected = await selectTexts([patch.name], selector);
    if (!selected.ok) return selected;
    applied = { key: patch.key, name: (selected.texts[0] ?? '').slice(0, 60) };
  }
  const items = applyListPatch(current.items, applied);
  if (items === null) return { ok: false, error: 'not_found' };
  const field = 'name' in applied ? 'name' : 'certainty' in applied ? 'certainty' : 'activity' in applied ? 'activity' : 'hidden' in applied ? 'hidden' : 'move';
  const before = field === 'name' ? item.name : field === 'certainty' ? item.certainty : field === 'activity' ? item.activity : field === 'hidden' ? String(item.hidden) : null;
  const after = 'name' in applied ? applied.name : 'certainty' in applied ? applied.certainty : 'activity' in applied ? applied.activity : 'hidden' in applied ? String(applied.hidden) : applied.move;
  await db.batch([
    db.prepare('UPDATE problem_lists SET items = ? WHERE patient_id = ?').bind(JSON.stringify(items), patientId),
    db
      .prepare('INSERT INTO problem_list_edits (id, patient_id, at, item_key, field, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)), patientId, japanDateTime(runtime.now()), patch.key, field, before, after),
  ]);
  return { ok: true };
}
