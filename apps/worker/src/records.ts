// 記録の読み書き（段1：患者・受診・取り込んだ文・測定値）。書く表は、docs/04 の 6 の一覧のとおり。
// ここは、形を確かめた後の値だけを受け取る（形の確かめは handler.ts、文の選別は intake.ts）。
import type { AuthorRole, Comparator, EncounterKind, LabRow, Sex, SourceKind } from '@clinical-carte/core';

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
  return { id, patientId, encounterId, kind: kind as SourceKind, authorRole: authorRole as AuthorRole, at: text(row, 'at'), enteredAt, text: body, replaced: toCounts(text(row, 'replaced')) };
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
}

export async function getRecord(db: Db, id: string): Promise<PatientRecord | null> {
  const patient = await getPatient(db, id);
  if (patient === null) return null;
  const [encounters, sources, observations] = await Promise.all([
    db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters WHERE patient_id = ? ORDER BY started, id').bind(id).all(),
    db.prepare('SELECT id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced FROM sources WHERE patient_id = ? ORDER BY id').bind(id).all(),
    db
      .prepare('SELECT id, source_id, encounter_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end FROM observations WHERE patient_id = ? ORDER BY source_id, ord')
      .bind(id)
      .all(),
  ]);
  return {
    patient,
    encounters: encounters.results.map(toEncounter).filter(present),
    sources: sources.results.map(toSource).filter(present),
    observations: observations.results.map(toObservation).filter(present),
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
    db.prepare('DELETE FROM observations WHERE patient_id = ?').bind(id),
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

/** 文を消す（入れ間違い）：その文から読んだ測定値も消す。戻せない。 */
export async function deleteSource(db: Db, id: string): Promise<number> {
  const row = await db.prepare('SELECT id FROM sources WHERE id = ?').bind(id).first();
  if (row === null) return 0;
  await db.batch([db.prepare('DELETE FROM observations WHERE source_id = ?').bind(id), db.prepare('DELETE FROM sources WHERE id = ?').bind(id)]);
  return 1;
}
