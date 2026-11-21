// 本人の調節（CA-029。docs/04 の 11）：なぞって足す（B）、記載・区切りを直す（A）、文を打ち直す（C-1：選別を通す）。
// どれも、本人の行（origin = self）として持ち、整理し直しより先にする（organize.ts）。直すたびに user_edits に残す。
import { type AddFact, checkSpan, type LabRow, nextDayPoint, readLabText, READ_VALUES_KINDS, segmentEnds, type SegmentPatch, type SourcePatch, type SpanProblem, ulid, ULID_RANDOM_BYTES } from '@clinical-carte/core';

import type { Db, Statement } from './db.ts';
import { intake } from './intake.ts';
import { linkPatient, userEdit } from './problems.ts';
import { FACT_TABLES, getSource } from './records.ts';
import type { Runtime } from './runtime.ts';
import type { Selector, SelectorFailure } from './selector.ts';

export type AddOutcome = { readonly ok: true } | { readonly ok: false; readonly error: 'not_found' } | { readonly ok: false; readonly error: 'span'; readonly problem: SpanProblem };

/** なぞって足す（B）：保存した文の一部を、問題・投薬・できごと・値・区切りとして足す。字は文にあるとおり（選別を通し直さない） */
export async function addFact(db: Db, sourceId: string, add: AddFact, runtime: Runtime): Promise<AddOutcome> {
  const source = await getSource(db, sourceId);
  if (source === null) return { ok: false, error: 'not_found' };
  const span = checkSpan(source.text, add);
  if (!span.ok) return { ok: false, error: 'span', problem: span.problem };
  const id = (): string => ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));
  const base = [source.patientId, source.encounterId, source.id] as const;
  const statements: Statement[] = [];
  let targetType: 'problem' | 'medication' | 'event' | 'observation' | 'segment' = add.type;
  let target = '';

  if (add.type === 'segment') {
    // その場所から始まる区切りがあれば、見出しを変える。なければ足す。終わりは、全部を並べて決め直す
    const rows = (await db.prepare('SELECT id, span_start FROM segments WHERE source_id = ?').bind(source.id).all()).results;
    const same = rows.find((r) => Number(r['span_start']) === span.start);
    target = typeof same?.['id'] === 'string' ? same['id'] : id();
    const all = segmentEnds([...rows.filter((r) => r !== same).map((r) => ({ id: String(r['id']), start: Number(r['span_start']) })), { id: target, start: span.start }], source.text.length);
    for (const g of all) {
      if (g.id !== target) statements.push(db.prepare('UPDATE segments SET span_end = ? WHERE id = ?').bind(g.end, g.id));
      else if (same !== undefined) statements.push(db.prepare("UPDATE segments SET label = ?, span_end = ?, origin = 'self' WHERE id = ?").bind(add.label, g.end, target));
      else statements.push(db.prepare("INSERT INTO segments (id, patient_id, source_id, label, span_start, span_end, origin) VALUES (?, ?, ?, ?, ?, ?, 'self')").bind(target, source.patientId, source.id, add.label, g.start, g.end));
    }
  } else if (add.type === 'problem') {
    target = id();
    statements.push(
      db
        .prepare("INSERT INTO problems (id, patient_id, encounter_id, source_id, name, status, activity, at, span_start, span_end, origin) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'self')")
        .bind(target, ...base, span.quote, add.status, source.at, span.start, span.end),
    );
  } else if (add.type === 'medication') {
    target = id();
    statements.push(
      db
        .prepare("INSERT INTO medications (id, patient_id, encounter_id, source_id, name, dose_text, action, at, span_start, span_end, origin) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'self')")
        .bind(target, ...base, span.quote, add.action, source.at, span.start, span.end),
    );
  } else if (add.type === 'event') {
    target = id();
    statements.push(
      db
        .prepare("INSERT INTO events (id, patient_id, encounter_id, source_id, kind, title, at, span_start, span_end, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'self')")
        .bind(target, ...base, add.kind, span.quote, source.at, span.start, span.end),
    );
  } else {
    // 値：なぞった字を、決定論で読む（数を AI に写させない決まりと同じ）
    const ord = Number((await db.prepare('SELECT COALESCE(MAX(ord), -1) AS m FROM observations WHERE source_id = ?').bind(source.id).first())?.['m'] ?? -1) + 1;
    readLabText(span.quote).rows.forEach((row: LabRow, i) => {
      const rowId = id();
      if (i === 0) target = rowId;
      statements.push(
        db
          .prepare(
            "INSERT INTO observations (id, patient_id, encounter_id, source_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, ord, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'self')",
          )
          .bind(rowId, ...base, source.at, row.name, row.nameRaw, row.kind, row.value, row.comparator, row.valueText, row.unit, row.start + span.start, row.end + span.start, ord + i),
      );
    });
    targetType = 'observation';
  }
  statements.push(userEdit(db, runtime, source.patientId, targetType, target, 'added', null, add.type));
  await db.batch(statements);

  // 足した問題は、筋につなぐ：名前が同じ筋があれば、そこへ（AI は使わない）。なければ、新しい筋
  if (add.type === 'problem') {
    await linkPatient(db, source.patientId, null, runtime);
    const linked = await db.prepare('SELECT thread_id FROM problems WHERE id = ?').bind(target).first();
    if (typeof linked?.['thread_id'] !== 'string') {
      const thread = id();
      await db.batch([
        db.prepare('INSERT INTO problem_threads (id, patient_id) VALUES (?, ?)').bind(thread, source.patientId),
        db.prepare("UPDATE problems SET thread_id = ?, thread_origin = 'self' WHERE id = ?").bind(thread, target),
      ]);
    }
  }
  return { ok: true };
}

export type PatchOutcome = { readonly ok: true } | { readonly ok: false; readonly error: 'not_found' | 'bad_request' };

/** 記載の種類・日時・書いた人を直す（A） */
export async function patchSource(db: Db, sourceId: string, patch: SourcePatch, runtime: Runtime): Promise<PatchOutcome> {
  const source = await getSource(db, sourceId);
  if (source === null) return { ok: false, error: 'not_found' };
  const [column, field, before, after] =
    'kind' in patch
      ? (['kind', 'kind', source.kind, patch.kind] as const)
      : 'at' in patch
        ? (['at', 'at', source.at, patch.at] as const)
        : (['author_role', 'author_role', source.authorRole, patch.authorRole] as const);
  await db.batch([db.prepare(`UPDATE sources SET ${column} = ? WHERE id = ?`).bind(after, sourceId), userEdit(db, runtime, source.patientId, 'source', sourceId, field, before, after)]);
  return { ok: true };
}

/** 区切りの見出しを選び直す（A）。本人の区切りになる（整理し直しでも残る） */
export async function patchSegment(db: Db, segmentId: string, patch: SegmentPatch, runtime: Runtime): Promise<PatchOutcome> {
  const row = await db.prepare('SELECT patient_id, label FROM segments WHERE id = ?').bind(segmentId).first();
  const patientId = row?.['patient_id'];
  if (row === null || typeof patientId !== 'string') return { ok: false, error: 'not_found' };
  await db.batch([
    db.prepare("UPDATE segments SET label = ?, origin = 'self' WHERE id = ?").bind(patch.label, segmentId),
    userEdit(db, runtime, patientId, 'segment', segmentId, 'label', typeof row['label'] === 'string' ? row['label'] : null, patch.label),
  ]);
  return { ok: true };
}

export type RetypeOutcome =
  | { readonly ok: true; readonly lost: number }
  | { readonly ok: false; readonly error: 'not_found' | 'empty' }
  | { readonly ok: false; readonly error: 'ai'; readonly failure: SelectorFailure }
  | { readonly ok: false; readonly error: 'selection' };

/**
 * 文を打ち直す（C-1）：打った文を、文を入れるときと同じ選別に通し、置き換えた後の文だけを保存する。
 * 本人の行（足した・直した事実・区切り）は、前の文の字を新しい文で探して場所を移す（見つからなければ消し、数を返す）。
 * AI の行は消す（画面が続けて整理し直す）。直した記録には、前後の文を残さない（紛れた識別情報を消すための直しがありうる）。
 */
/**
 * 文を打ち直す。nextDay（CA-047）：true／false は、入れる欄と同じく本人が確かめた答え。答えがなければ、前に「日をまたいだ」と確かめた文だけ、
 * 新しい文で場所を決め直す（またいでいない文は、またいでいないまま）
 */
export async function retypeSource(db: Db, sourceId: string, typed: string, selector: Selector, runtime: Runtime, nextDay?: boolean): Promise<RetypeOutcome> {
  const source = await getSource(db, sourceId);
  if (source === null) return { ok: false, error: 'not_found' };
  const result = await intake({ kind: source.kind, authorRole: source.authorRole, at: source.at, text: typed }, selector);
  if (!result.ok) {
    if (result.reason === 'empty') return { ok: false, error: 'empty' };
    if (result.reason === 'ai') return { ok: false, error: 'ai', failure: result.failure };
    return { ok: false, error: 'selection' };
  }
  const text = result.text;
  const nextDayFrom = (nextDay ?? source.nextDayFrom !== null) ? (nextDayPoint(text)?.at ?? null) : null;
  const statements: Statement[] = [];
  let lost = 0;
  const id = (): string => ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));

  // 本人の行の場所を、新しい文で探し直す
  for (const table of ['problems', 'medications', 'events', 'observations'] as const) {
    const rows = (await db.prepare(`SELECT id, span_start, span_end FROM ${table} WHERE source_id = ? AND origin = 'self'`).bind(sourceId).all()).results;
    for (const r of rows) {
      const piece = source.text.slice(Number(r['span_start']), Number(r['span_end']));
      const at = piece === '' ? -1 : text.indexOf(piece);
      if (at < 0) {
        lost += 1;
        statements.push(db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(String(r['id'])));
      } else statements.push(db.prepare(`UPDATE ${table} SET span_start = ?, span_end = ? WHERE id = ?`).bind(at, at + piece.length, String(r['id'])));
    }
  }
  // 本人の区切り：始まりの数文字を、新しい文で探す
  const selfSegments = (await db.prepare("SELECT id, span_start, span_end FROM segments WHERE source_id = ? AND origin = 'self'").bind(sourceId).all()).results;
  const kept: { id: string; start: number }[] = [];
  for (const r of selfSegments) {
    const head = source.text.slice(Number(r['span_start']), Math.min(Number(r['span_end']), Number(r['span_start']) + 12));
    const at = head === '' ? -1 : text.indexOf(head);
    if (at < 0) {
      lost += 1;
      statements.push(db.prepare('DELETE FROM segments WHERE id = ?').bind(String(r['id'])));
    } else kept.push({ id: String(r['id']), start: at });
  }
  for (const g of segmentEnds(kept, text.length)) statements.push(db.prepare('UPDATE segments SET span_start = ?, span_end = ? WHERE id = ?').bind(g.start, g.end, g.id));

  // AI の行は消す。検査結果・バイタルの文は、入れるときと同じく、文全体を決定論で読み直す
  for (const table of FACT_TABLES) statements.push(db.prepare(`DELETE FROM ${table} WHERE source_id = ? AND origin != 'self'`).bind(sourceId));
  if (READ_VALUES_KINDS.includes(source.kind)) {
    result.rows.forEach((row, i) => {
      statements.push(
        db
          .prepare(
            "INSERT INTO observations (id, patient_id, encounter_id, source_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, ord, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parser')",
          )
          .bind(id(), source.patientId, source.encounterId, sourceId, source.at, row.name, row.nameRaw, row.kind, row.value, row.comparator, row.valueText, row.unit, row.start, row.end, 1000 + i),
      );
    });
  }
  statements.push(
    db.prepare('UPDATE sources SET text = ?, replaced = ?, organized = NULL, organized_version = NULL, organize_report = NULL, next_day_from = ? WHERE id = ?').bind(text, JSON.stringify(result.replaced), nextDayFrom, sourceId),
    userEdit(db, runtime, source.patientId, 'source', sourceId, 'text', null, null),
  );
  await db.batch(statements);
  return { ok: true, lost };
}
