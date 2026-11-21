// 整理（段2。docs/00 の 5）：保存した文を AI に整理させ、core の applyOrganization で確かめて、文の行（区切り・投薬・できごと・問題・測定値）を入れ替える。
// 文そのもの（sources.text）は変えない。整理に失敗したら、それまでの行を残し、失敗の印だけを付ける。
// AI に送るのは、保存した文（識別情報を置き換えた後）だけ。AI の答えそのものは、保存もログもしない。
import { applyOrganization, carryKey, ulid, ULID_RANDOM_BYTES } from '@clinical-carte/core';

import type { Db } from './db.ts';
import type { Organizer } from './organizer.ts';
import { ORGANIZE_PROMPT_VERSION } from './prompt.ts';
import { FACT_TABLES, getEncounter, getSource, markOrganizeFailed, type Source } from './records.ts';
import type { Runtime } from './runtime.ts';
import type { SelectorFailure } from './selector.ts';

export type OrganizeOutcome = { readonly ok: true; readonly source: Source } | { readonly ok: false; readonly reason: 'not_found' } | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure };

export async function organizeSource(db: Db, sourceId: string, organizer: Organizer, runtime: Runtime): Promise<OrganizeOutcome> {
  const source = await getSource(db, sourceId);
  if (source === null) return { ok: false, reason: 'not_found' };
  const encounter = await getEncounter(db, source.encounterId);
  if (encounter === null) return { ok: false, reason: 'not_found' };

  const answered = await organizer.organize(source.text);
  if (!answered.ok) {
    await markOrganizeFailed(db, sourceId);
    return { ok: false, reason: 'ai', failure: answered.reason };
  }

  const organized = applyOrganization(answered.answer, { text: source.text, kind: source.kind, at: source.at, encounterStart: encounter.start });
  const id = (): string => ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));
  const base = [source.patientId, source.encounterId, source.id] as const;

  // 本人が直した事実（段3e）：整理し直しても、同じ場所・同じ字の行には、直した値を引き継ぐ
  const [selfMeds, selfEvents, selfObs] = await Promise.all([
    db.prepare("SELECT span_start, span_end, name, action, at, excluded FROM medications WHERE source_id = ? AND origin = 'self'").bind(source.id).all(),
    db.prepare("SELECT span_start, span_end, title, kind, at, excluded FROM events WHERE source_id = ? AND origin = 'self'").bind(source.id).all(),
    db.prepare("SELECT span_start, span_end, name_raw, at, excluded FROM observations WHERE source_id = ? AND origin = 'self'").bind(source.id).all(),
  ]);
  const keyed = (rows: readonly Record<string, unknown>[], text: string) => new Map(rows.map((r) => [carryKey(Number(r['span_start']), Number(r['span_end']), String(r[text])), r]));
  const medEdits = keyed(selfMeds.results, 'name');
  const eventEdits = keyed(selfEvents.results, 'title');
  const obsEdits = keyed(selfObs.results, 'name_raw');
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  // 問題の筋（段3a）：整理し直しても、同じ場所・同じ名前の記載は、前と同じ筋のまま（本人がつなぎ直したものも）
  const before = await db.prepare('SELECT span_start, span_end, name, thread_id, thread_origin FROM problems WHERE source_id = ? AND thread_id IS NOT NULL').bind(source.id).all();
  const kept = new Map<string, { threadId: string; origin: string | null }>();
  for (const row of before.results) {
    const threadId = row['thread_id'];
    if (typeof threadId !== 'string') continue;
    kept.set(`${String(row['span_start'])}:${String(row['span_end'])}:${String(row['name'])}`, { threadId, origin: typeof row['thread_origin'] === 'string' ? row['thread_origin'] : null });
  }

  await db.batch([
    // それまでの、この文の行を入れ替える
    ...FACT_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).bind(source.id)),
    ...organized.segments.map((s) =>
      db.prepare('INSERT INTO segments (id, patient_id, source_id, label, span_start, span_end) VALUES (?, ?, ?, ?, ?, ?)').bind(id(), source.patientId, source.id, s.label, s.start, s.end),
    ),
    ...organized.medications.map((m) => {
      const edit = medEdits.get(carryKey(m.start, m.end, m.name));
      return db
        .prepare('INSERT INTO medications (id, patient_id, encounter_id, source_id, name, dose_text, action, at, span_start, span_end, origin, excluded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id(), ...base, m.name, m.doseText, edit === undefined ? m.action : str(edit['action']), edit === undefined ? m.at : str(edit['at']), m.start, m.end, edit === undefined ? 'ai' : 'self', edit === undefined ? 0 : Number(edit['excluded']));
    }),
    ...organized.events.map((e) => {
      const edit = eventEdits.get(carryKey(e.start, e.end, e.title));
      return db
        .prepare('INSERT INTO events (id, patient_id, encounter_id, source_id, kind, title, at, span_start, span_end, origin, excluded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id(), ...base, edit === undefined ? e.kind : String(edit['kind']), e.title, edit === undefined ? e.at : str(edit['at']), e.start, e.end, edit === undefined ? 'ai' : 'self', edit === undefined ? 0 : Number(edit['excluded']));
    }),
    ...organized.problems.map((p) => {
      const keep = kept.get(`${String(p.start)}:${String(p.end)}:${p.name}`);
      return db
        .prepare("INSERT INTO problems (id, patient_id, encounter_id, source_id, name, status, activity, at, span_start, span_end, origin, thread_id, thread_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)")
        .bind(id(), ...base, p.name, p.status, p.activity, p.at, p.start, p.end, keep?.threadId ?? null, keep?.origin ?? null);
    }),
    ...organized.observations.map((o, index) => {
      const edit = obsEdits.get(carryKey(o.row.start, o.row.end, o.row.nameRaw));
      return db
        .prepare(
          'INSERT INTO observations (id, patient_id, encounter_id, source_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, ord, origin, excluded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          id(),
          ...base,
          edit === undefined ? o.at : str(edit['at']),
          o.row.name,
          o.row.nameRaw,
          o.row.kind,
          o.row.value,
          o.row.comparator,
          o.row.valueText,
          o.row.unit,
          o.row.start,
          o.row.end,
          index,
          edit === undefined ? o.origin : 'self',
          edit === undefined ? 0 : Number(edit['excluded']),
        );
    }),
    db
      .prepare("UPDATE sources SET kind = ?, at = ?, organized = 'done', organized_version = ?, organize_report = ? WHERE id = ?")
      .bind(organized.kind, organized.at, ORGANIZE_PROMPT_VERSION, JSON.stringify(organized.report), source.id),
  ]);

  const updated = await getSource(db, sourceId);
  return updated === null ? { ok: false, reason: 'not_found' } : { ok: true, source: updated };
}
