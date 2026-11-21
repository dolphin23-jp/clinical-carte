// 記録の読み書き（段1：患者・受診・取り込んだ文・測定値）。書く表は、docs/04 の 6 の一覧のとおり。
// ここは、形を確かめた後の値だけを受け取る（形の確かめは handler.ts、文の選別は intake.ts）。
import type { AuthorRole, Comparator, EncounterKind, EventKind, HistoryAction, LabRow, MedicationAction, OrganizeReport, ProblemActivity, ProblemStatus, SegmentLabel, Sex, SourceKind } from '@clinical-carte/core';

import { type Db, int, real, type Statement, text } from './db.ts';

export interface Patient {
  readonly id: string;
  readonly age: number;
  readonly ageOn: string;
  readonly sex: Sex;
  readonly createdOn: string;
}

export interface Encounter {
  readonly id: string;
  readonly patientId: string;
  readonly kind: EncounterKind;
  readonly start: string;
  readonly end: string | null;
}

export interface Source {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly kind: SourceKind;
  readonly authorRole: AuthorRole;
  readonly at: string | null;
  readonly enteredAt: string;
  readonly text: string;
  /** 置き換えた種類ごとの件数 */
  readonly replaced: Readonly<Record<string, number>>;
  /** 整理の状態：null（まだ）・done・failed */
  readonly organized: 'done' | 'failed' | null;
  /** 整理に使った指示の版 */
  readonly organizedVersion: string | null;
  /** 整理で確かめられなかった件数（種類と理由ごと） */
  readonly organizeReport: OrganizeReport;
}

export interface Segment {
  readonly id: string;
  readonly sourceId: string;
  readonly label: SegmentLabel;
  readonly start: number;
  readonly end: number;
}

export interface Medication {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly name: string;
  readonly doseText: string | null;
  readonly action: MedicationAction | null;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
}

export interface Event {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
}

export interface Problem {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly name: string;
  readonly status: ProblemStatus;
  /** 書かれた活動の状態（解決・非活動）。書かれていなければ null */
  readonly activity: ProblemActivity | null;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
  /** 問題の筋（まだつないでいなければ null） */
  readonly threadId: string | null;
  /** つないだ方法：rule（名前が同じ）・ai（AI が指した）・self（本人が直した） */
  readonly threadOrigin: 'rule' | 'ai' | 'self' | null;
}

export interface ProblemThread {
  readonly id: string;
  readonly displayName: string | null;
  readonly mergedInto: string | null;
}

export interface HistoryEntry {
  readonly id: string;
  readonly at: string;
  readonly action: HistoryAction;
  readonly target: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface Observation {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly at: string | null;
  readonly name: string | null;
  readonly nameRaw: string;
  readonly kind: 'lab' | 'vital' | null;
  readonly value: number | null;
  readonly comparator: Comparator | null;
  readonly valueText: string;
  readonly unit: string | null;
  readonly start: number;
  readonly end: number;
}

type Row = Record<string, unknown>;

function toPatient(row: Row | null): Patient | null {
  const id = text(row, 'id');
  const age = int(row, 'age');
  const ageOn = text(row, 'age_on');
  const sex = text(row, 'sex');
  const createdOn = text(row, 'created_on');
  if (id === null || age === null || ageOn === null || createdOn === null) return null;
  if (sex !== 'male' && sex !== 'female' && sex !== 'other') return null;
  return { id, age, ageOn, sex, createdOn };
}

function toEncounter(row: Row | null): Encounter | null {
  const id = text(row, 'id');
  const patientId = text(row, 'patient_id');
  const kind = text(row, 'kind');
  const start = text(row, 'started');
  if (id === null || patientId === null || start === null) return null;
  if (kind !== 'er' && kind !== 'outpatient' && kind !== 'inpatient') return null;
  return { id, patientId, kind, start, end: text(row, 'ended') };
}

function toReport(json: string | null): OrganizeReport {
  const out: Record<string, Record<string, number>> = {};
  if (json === null) return out;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [category, reasons] of Object.entries(parsed)) {
        if (typeof reasons !== 'object' || reasons === null) continue;
        for (const [reason, v] of Object.entries(reasons as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isInteger(v) && v > 0) (out[category] ??= {})[reason] = v;
        }
      }
    }
  } catch {
    // 読めない件数は、ないものとして扱う
  }
  return out;
}

function toCounts(json: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (json === null) return out;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v;
    }
  } catch {
    // 読めない件数は、ないものとして扱う（文そのものは別の列にある）
  }
  return out;
}

function toSource(row: Row | null): Source | null {
  const id = text(row, 'id');
  const patientId = text(row, 'patient_id');
  const encounterId = text(row, 'encounter_id');
  const kind = text(row, 'kind');
  const authorRole = text(row, 'author_role');
  const enteredAt = text(row, 'entered_at');
  const body = text(row, 'text');
  if (id === null || patientId === null || encounterId === null || kind === null || authorRole === null || enteredAt === null || body === null) return null;
  const organized = text(row, 'organized');
  return {
    id,
    patientId,
    encounterId,
    kind: kind as SourceKind,
    authorRole: authorRole as AuthorRole,
    at: text(row, 'at'),
    enteredAt,
    text: body,
    replaced: toCounts(text(row, 'replaced')),
    organized: organized === 'done' || organized === 'failed' ? organized : null,
    organizedVersion: text(row, 'organized_version'),
    organizeReport: toReport(text(row, 'organize_report')),
  };
}

function toObservation(row: Row | null): Observation | null {
  const id = text(row, 'id');
  const sourceId = text(row, 'source_id');
  const encounterId = text(row, 'encounter_id');
  const nameRaw = text(row, 'name_raw');
  const valueText = text(row, 'value_text');
  const start = int(row, 'span_start');
  const end = int(row, 'span_end');
  if (id === null || sourceId === null || encounterId === null || nameRaw === null || valueText === null || start === null || end === null) return null;
  const kind = text(row, 'kind');
  const comparator = text(row, 'comparator');
  return {
    id,
    sourceId,
    encounterId,
    at: text(row, 'at'),
    name: text(row, 'name'),
    nameRaw,
    kind: kind === 'lab' || kind === 'vital' ? kind : null,
    value: real(row, 'value'),
    comparator: comparator === '<' || comparator === '>' || comparator === '<=' || comparator === '>=' ? comparator : null,
    valueText,
    unit: text(row, 'unit'),
    start,
    end,
  };
}

function spanOf(row: Row): { start: number; end: number } | null {
  const start = int(row, 'span_start');
  const end = int(row, 'span_end');
  return start === null || end === null ? null : { start, end };
}

function toSegment(row: Row): Segment | null {
  const id = text(row, 'id');
  const sourceId = text(row, 'source_id');
  const label = text(row, 'label');
  const span = spanOf(row);
  if (id === null || sourceId === null || label === null || span === null) return null;
  return { id, sourceId, label: label as SegmentLabel, ...span };
}

function toMedication(row: Row): Medication | null {
  const id = text(row, 'id');
  const sourceId = text(row, 'source_id');
  const encounterId = text(row, 'encounter_id');
  const name = text(row, 'name');
  const span = spanOf(row);
  if (id === null || sourceId === null || encounterId === null || name === null || span === null) return null;
  const action = text(row, 'action');
  return { id, sourceId, encounterId, name, doseText: text(row, 'dose_text'), action: action as MedicationAction | null, at: text(row, 'at'), ...span };
}

function toEvent(row: Row): Event | null {
  const id = text(row, 'id');
  const sourceId = text(row, 'source_id');
  const encounterId = text(row, 'encounter_id');
  const kind = text(row, 'kind');
  const title = text(row, 'title');
  const span = spanOf(row);
  if (id === null || sourceId === null || encounterId === null || kind === null || title === null || span === null) return null;
  return { id, sourceId, encounterId, kind: kind as EventKind, title, at: text(row, 'at'), ...span };
}

function toProblem(row: Row): Problem | null {
  const id = text(row, 'id');
  const sourceId = text(row, 'source_id');
  const encounterId = text(row, 'encounter_id');
  const name = text(row, 'name');
  const status = text(row, 'status');
  const span = spanOf(row);
  if (id === null || sourceId === null || encounterId === null || name === null || status === null || span === null) return null;
  const activity = text(row, 'activity');
  const origin = text(row, 'thread_origin');
  return {
    id,
    sourceId,
    encounterId,
    name,
    status: status as ProblemStatus,
    activity: activity === 'resolved' || activity === 'inactive' ? activity : null,
    at: text(row, 'at'),
    ...span,
    threadId: text(row, 'thread_id'),
    threadOrigin: origin === 'rule' || origin === 'ai' || origin === 'self' ? origin : null,
  };
}

function toThread(row: Row): ProblemThread | null {
  const id = text(row, 'id');
  if (id === null) return null;
  return { id, displayName: text(row, 'display_name'), mergedInto: text(row, 'merged_into') };
}

function toHistory(row: Row): HistoryEntry | null {
  const id = text(row, 'id');
  const at = text(row, 'at');
  const action = text(row, 'action');
  const target = text(row, 'target');
  if (id === null || at === null || target === null || (action !== 'move' && action !== 'merge' && action !== 'name')) return null;
  return { id, at, action, target, before: text(row, 'before'), after: text(row, 'after') };
}

const present = <T>(value: T | null): value is T => value !== null;

// --- 患者と受診

function insertEncounter(db: Db, e: Encounter): Statement {
  return db.prepare('INSERT INTO encounters (id, patient_id, kind, started, ended) VALUES (?, ?, ?, ?, ?)').bind(e.id, e.patientId, e.kind, e.start, e.end);
}

/** 患者と、最初の受診を、一緒に作る。 */
export async function createPatient(db: Db, patient: Patient, encounter: Encounter): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO patients (id, age, age_on, sex, created_on) VALUES (?, ?, ?, ?, ?)').bind(patient.id, patient.age, patient.ageOn, patient.sex, patient.createdOn),
    insertEncounter(db, encounter),
  ]);
}

export async function getPatient(db: Db, id: string): Promise<Patient | null> {
  return toPatient(await db.prepare('SELECT id, age, age_on, sex, created_on FROM patients WHERE id = ?').bind(id).first());
}

export interface PatientSummary {
  readonly patient: Patient;
  /** いちばん新しい受診 */
  readonly latest: Encounter | null;
  /** 取り込んだ文の数 */
  readonly sources: number;
}

export async function listPatients(db: Db): Promise<PatientSummary[]> {
  const [patients, encounters, counts] = await Promise.all([
    db.prepare('SELECT id, age, age_on, sex, created_on FROM patients ORDER BY id').all(),
    db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters ORDER BY started, id').all(),
    db.prepare('SELECT patient_id, COUNT(*) AS n FROM sources GROUP BY patient_id').all(),
  ]);
  const latest = new Map<string, Encounter>();
  for (const e of encounters.results.map(toEncounter).filter(present)) latest.set(e.patientId, e);
  const sources = new Map<string, number>();
  for (const row of counts.results) sources.set(text(row, 'patient_id') ?? '', int(row, 'n') ?? 0);
  return patients.results
    .map(toPatient)
    .filter(present)
    .map((patient) => ({ patient, latest: latest.get(patient.id) ?? null, sources: sources.get(patient.id) ?? 0 }))
    // いちばん新しい受診の開始が新しい順（受け持ち中の患者が上に来る）
    .sort((a, b) => (b.latest?.start ?? '').localeCompare(a.latest?.start ?? '') || b.patient.id.localeCompare(a.patient.id));
}

export interface PatientRecord {
  readonly patient: Patient;
  readonly encounters: Encounter[];
  readonly sources: Source[];
  readonly observations: Observation[];
  readonly segments: Segment[];
  readonly medications: Medication[];
  readonly events: Event[];
  readonly problems: Problem[];
  readonly problemThreads: ProblemThread[];
  /** 本人が直した記録（新しい順） */
  readonly history: HistoryEntry[];
}

/** 問題の列（読み出し） */
export const PROBLEM_COLUMNS = 'id, source_id, encounter_id, name, status, activity, at, span_start, span_end, thread_id, thread_origin';

export async function getRecord(db: Db, id: string): Promise<PatientRecord | null> {
  const patient = await getPatient(db, id);
  if (patient === null) return null;
  const [encounters, sources, observations, segments, medications, events, problems, threads, history] = await Promise.all([
    db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters WHERE patient_id = ? ORDER BY started, id').bind(id).all(),
    db.prepare('SELECT id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced, organized, organized_version, organize_report FROM sources WHERE patient_id = ? ORDER BY id').bind(id).all(),
    db
      .prepare('SELECT id, source_id, encounter_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end FROM observations WHERE patient_id = ? ORDER BY source_id, ord')
      .bind(id)
      .all(),
    db.prepare('SELECT id, source_id, label, span_start, span_end FROM segments WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare('SELECT id, source_id, encounter_id, name, dose_text, action, at, span_start, span_end FROM medications WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare('SELECT id, source_id, encounter_id, kind, title, at, span_start, span_end FROM events WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare(`SELECT ${PROBLEM_COLUMNS} FROM problems WHERE patient_id = ? ORDER BY source_id, span_start`).bind(id).all(),
    db.prepare('SELECT id, display_name, merged_into FROM problem_threads WHERE patient_id = ? ORDER BY id').bind(id).all(),
    db.prepare('SELECT id, at, action, target, before, after FROM history WHERE patient_id = ? ORDER BY at DESC, id DESC LIMIT 200').bind(id).all(),
  ]);
  return {
    patient,
    encounters: encounters.results.map(toEncounter).filter(present),
    sources: sources.results.map(toSource).filter(present),
    observations: observations.results.map(toObservation).filter(present),
    segments: segments.results.map(toSegment).filter(present),
    medications: medications.results.map(toMedication).filter(present),
    events: events.results.map(toEvent).filter(present),
    problems: problems.results.map(toProblem).filter(present),
    problemThreads: threads.results.map(toThread).filter(present),
    history: history.results.map(toHistory).filter(present),
  };
}

export async function patchPatient(db: Db, id: string, patch: { age: number; ageOn: string; sex: Sex }): Promise<number> {
  const r = await db.prepare('UPDATE patients SET age = ?, age_on = ?, sex = ? WHERE id = ?').bind(patch.age, patch.ageOn, patch.sex, id).run();
  return r.meta?.changes ?? 0;
}

/** 患者を消す（CA-020）：その患者の受診・文・測定値を、すべて消す。戻せない。 */
export async function deletePatient(db: Db, id: string): Promise<number> {
  const exists = await getPatient(db, id);
  if (exists === null) return 0;
  await db.batch([
    ...FACT_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE patient_id = ?`).bind(id)),
    ...PATIENT_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE patient_id = ?`).bind(id)),
    db.prepare('DELETE FROM sources WHERE patient_id = ?').bind(id),
    db.prepare('DELETE FROM encounters WHERE patient_id = ?').bind(id),
    db.prepare('DELETE FROM patients WHERE id = ?').bind(id),
  ]);
  return 1;
}

export async function createEncounter(db: Db, encounter: Encounter): Promise<void> {
  await insertEncounter(db, encounter).run();
}

export async function getEncounter(db: Db, id: string): Promise<Encounter | null> {
  return toEncounter(await db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters WHERE id = ?').bind(id).first());
}

export async function setEncounterEnd(db: Db, id: string, end: string | null): Promise<number> {
  const r = await db.prepare('UPDATE encounters SET ended = ? WHERE id = ?').bind(end, id).run();
  return r.meta?.changes ?? 0;
}

/** 文から作った行の表（文を消すと、一緒に消える。整理し直すと、入れ替わる） */
export const FACT_TABLES = ['observations', 'segments', 'medications', 'events', 'problems'] as const;

/** 患者に付く、文からではない行の表（患者を消すと、一緒に消える。文を消しても残る：筋は、記載がなくなると見えなくなるだけ） */
export const PATIENT_TABLES = ['problem_threads', 'history'] as const;

/** 問題の行を、表から読む */
export function problemOf(row: Record<string, unknown>): Problem | null {
  return toProblem(row);
}

export function threadOf(row: Record<string, unknown>): ProblemThread | null {
  return toThread(row);
}

// --- 取り込んだ文と、そこから読んだ測定値

export interface NewObservation {
  readonly id: string;
  readonly row: LabRow;
}

/** 文と、そこから読んだ測定値を、一緒に保存する。 */
export async function saveSource(db: Db, source: Source, observations: readonly NewObservation[]): Promise<void> {
  await db.batch([
    db
      .prepare('INSERT INTO sources (id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(source.id, source.patientId, source.encounterId, source.kind, source.authorRole, source.at, source.enteredAt, source.text, JSON.stringify(source.replaced)),
    ...observations.map(({ id, row }, index) =>
      db
        .prepare(
          "INSERT INTO observations (id, patient_id, encounter_id, source_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, ord, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parser')",
        )
        .bind(id, source.patientId, source.encounterId, source.id, source.at, row.name, row.nameRaw, row.kind, row.value, row.comparator, row.valueText, row.unit, row.start, row.end, index),
    ),
  ]);
}

export function observationOf(source: Source, { id, row }: NewObservation): Observation {
  return { id, sourceId: source.id, encounterId: source.encounterId, at: source.at, name: row.name, nameRaw: row.nameRaw, kind: row.kind, value: row.value, comparator: row.comparator, valueText: row.valueText, unit: row.unit, start: row.start, end: row.end };
}

export async function getSource(db: Db, id: string): Promise<Source | null> {
  return toSource(await db.prepare('SELECT id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced, organized, organized_version, organize_report FROM sources WHERE id = ?').bind(id).first());
}

/** 整理に失敗した印を付ける（それまでの整理の行は、残す） */
export async function markOrganizeFailed(db: Db, id: string): Promise<void> {
  await db.prepare("UPDATE sources SET organized = 'failed' WHERE id = ?").bind(id).run();
}

/** 文を消す（入れ間違い）：その文から読んだ測定値も消す。戻せない。 */
export async function deleteSource(db: Db, id: string): Promise<number> {
  const row = await db.prepare('SELECT id FROM sources WHERE id = ?').bind(id).first();
  if (row === null) return 0;
  await db.batch([...FACT_TABLES.map((table) => db.prepare(`DELETE FROM ${table} WHERE source_id = ?`).bind(id)), db.prepare('DELETE FROM sources WHERE id = ?').bind(id)]);
  return 1;
}
