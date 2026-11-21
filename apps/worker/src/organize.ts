// 整理（段2。docs/00 の 5）：保存した文を AI に整理させ、core の applyOrganization で確かめて、文の行（区切り・投薬・できごと・問題・測定値）を入れ替える。
// 文そのもの（sources.text）は変えない。整理に失敗したら、それまでの行を残し、失敗の印だけを付ける。
// AI に送るのは、保存した文（識別情報を置き換えた後）だけ。AI の答えそのものは、保存もログもしない。
import { applyOrganization, carryKey, segmentEnds, ulid, ULID_RANDOM_BYTES } from '@clinical-carte/core';

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

  // 本人が足した・直した行（origin = self。段3e・CA-029）は、整理し直しでも残す（本人の直しが先）。
  // AI の答えのうち、本人の行と同じ場所・同じ字の行は、足さない（重ねない）
  const [selfMeds, selfEvents, selfObs, selfProblems, selfSegments] = await Promise.all([
    db.prepare("SELECT span_start, span_end, name FROM medications WHERE source_id = ? AND origin = 'self'").bind(source.id).all(),
    db.prepare("SELECT span_start, span_end, title FROM events WHERE source_id = ? AND origin = 'self'").bind(source.id).all(),
    db.prepare("SELECT span_start, span_end, name_raw, ord FROM observations WHERE source_id = ? AND origin = 'self'").bind(source.id).all(),
    db.prepare("SELECT span_start, span_end, name FROM problems WHERE source_id = ? AND origin = 'self'").bind(source.id).all(),
    db.prepare("SELECT id, span_start FROM segments WHERE source_id = ? AND origin = 'self'").bind(source.id).all(),
  ]);
  const keys = (rows: readonly Record<string, unknown>[], text: string) => new Set(rows.map((r) => carryKey(Number(r['span_start']), Number(r['span_end']), String(r[text]))));
  const medKeys = keys(selfMeds.results, 'name');
  const eventKeys = keys(selfEvents.results, 'title');
  const obsKeys = keys(selfObs.results, 'name_raw');
  const problemKeys = keys(selfProblems.results, 'name');
  const ordBase = selfObs.results.reduce((n, r) => Math.max(n, Number(r['ord']) + 1), 0);

  // 問題の筋（段3a）：整理し直しても、同じ場所・同じ名前の記載は、前と同じ筋のまま（本人がつなぎ直したものも）
  const before = await db.prepare("SELECT span_start, span_end, name, thread_id, thread_origin FROM problems WHERE source_id = ? AND thread_id IS NOT NULL AND origin != 'self'").bind(source.id).all();
  const kept = new Map<string, { threadId: string; origin: string | null }>();
  for (const row of before.results) {
    const threadId = row['thread_id'];
    if (typeof threadId !== 'string') continue;
    kept.set(carryKey(Number(row['span_start']), Number(row['span_end']), String(row['name'])), { threadId, origin: typeof row['thread_origin'] === 'string' ? row['thread_origin'] : null });
  }

  // 区切り：本人の区切りと同じ場所から始まる AI の区切りは足さない。終わりは、全部を並べて決め直す
  const selfStarts = new Set(selfSegments.results.map((r) => Number(r['span_start'])));
  const aiSegments = organized.segments.filter((g) => !selfStarts.has(g.start)).map((g) => ({ id: id(), label: g.label, start: g.start, self: false }));
  const allSegments = segmentEnds([...aiSegments, ...selfSegments.results.map((r) => ({ id: String(r['id']), label: null, start: Number(r['span_start']), self: true }))], source.text.length);

  await db.batch([
    // それまでの、この文の AI の行を入れ替える（本人の行は残す）
    ...FACT_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE source_id = ? AND origin != 'self'`).bind(source.id)),
    ...allSegments.map((g) =>
      g.self
        ? db.prepare('UPDATE segments SET span_end = ? WHERE id = ?').bind(g.end, g.id)
        : db.prepare("INSERT INTO segments (id, patient_id, source_id, label, span_start, span_end, origin) VALUES (?, ?, ?, ?, ?, ?, 'ai')").bind(g.id, source.patientId, source.id, g.label, g.start, g.end),
    ),
    ...organized.medications
      .filter((m) => !medKeys.has(carryKey(m.start, m.end, m.name)))
      .map((m) =>
        db
          .prepare("INSERT INTO medications (id, patient_id, encounter_id, source_id, name, dose_text, action, at, span_start, span_end, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai')")
          .bind(id(), ...base, m.name, m.doseText, m.action, m.at, m.start, m.end),
      ),
    ...organized.events
      .filter((e) => !eventKeys.has(carryKey(e.start, e.end, e.title)))
      .map((e) =>
        db.prepare("INSERT INTO events (id, patient_id, encounter_id, source_id, kind, title, at, span_start, span_end, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai')").bind(id(), ...base, e.kind, e.title, e.at, e.start, e.end),
      ),
    ...organized.problems
      .filter((p) => !problemKeys.has(carryKey(p.start, p.end, p.name)))
      .map((p) => {
        const keep = kept.get(carryKey(p.start, p.end, p.name));
        return db
          .prepare("INSERT INTO problems (id, patient_id, encounter_id, source_id, name, status, activity, at, span_start, span_end, origin, thread_id, thread_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?)")
          .bind(id(), ...base, p.name, p.status, p.activity, p.at, p.start, p.end, keep?.threadId ?? null, keep?.origin ?? null);
      }),
    ...organized.observations
      .filter((o) => !obsKeys.has(carryKey(o.row.start, o.row.end, o.row.nameRaw)))
      .map((o, index) =>
        db
          .prepare(
            'INSERT INTO observations (id, patient_id, encounter_id, source_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, ord, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(id(), ...base, o.at, o.row.name, o.row.nameRaw, o.row.kind, o.row.value, o.row.comparator, o.row.valueText, o.row.unit, o.row.start, o.row.end, ordBase + index, o.origin),
      ),
    db
      .prepare("UPDATE sources SET kind = ?, at = ?, organized = 'done', organized_version = ?, organize_report = ? WHERE id = ?")
      .bind(organized.kind, organized.at, ORGANIZE_PROMPT_VERSION, JSON.stringify(organized.report), source.id),
  ]);

  const updated = await getSource(db, sourceId);
  return updated === null ? { ok: false, reason: 'not_found' } : { ok: true, source: updated };
}
