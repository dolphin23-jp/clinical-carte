// 記録の読み書き（段1：患者・受診・取り込んだ文・測定値）。書く表は、docs/04 の 6 の一覧のとおり。
// ここは、形を確かめた後の値だけを受け取る（形の確かめは handler.ts、文の選別は intake.ts）。
import { roundSummary, type RoundSummary } from '@clinical-carte/core';
import { ApRef, type ApOrigin, type ApPart, type FactField, type FactKind, type PlanKind, USER_EDIT_FIELDS, USER_EDIT_TARGETS, type UserEditField, type UserEditTarget } from '@clinical-carte/core';
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
  /** 本人が足した・見出しを直した区切り（CA-029） */
  readonly edited: boolean;
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
  /** 本人が外した（見方から除く。戻せる） */
  readonly excluded: boolean;
  /** 本人が直した（整理し直しでも引き継ぐ） */
  readonly edited: boolean;
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
  readonly excluded: boolean;
  readonly edited: boolean;
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
  /** 本人の決め（CA-029） */
  readonly statusOverride: ProblemStatus | null;
  readonly activityOverride: 'active' | 'resolved' | 'inactive' | null;
  readonly ord: number | null;
  readonly excluded: boolean;
  readonly typedName: string | null;
}

export interface ApNote {
  readonly id: string;
  readonly encounterId: string;
  readonly threadId: string;
  readonly day: string;
  readonly part: ApPart;
  readonly planKind: PlanKind | null;
  readonly text: string;
  readonly origin: ApOrigin;
  readonly refs: readonly ApRef[];
  readonly enteredAt: string;
  readonly updatedAt: string;
}

export interface UserEdit {
  readonly id: string;
  readonly at: string;
  readonly targetType: UserEditTarget;
  readonly target: string;
  readonly field: UserEditField;
  readonly before: string | null;
  readonly after: string | null;
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
  readonly excluded: boolean;
  readonly edited: boolean;
}

export interface FactEdit {
  readonly id: string;
  readonly at: string;
  readonly fact: FactKind;
  readonly target: string;
  readonly field: FactField;
  readonly before: string | null;
  readonly after: string | null;
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
    ...editState(row),
  };
}

/** 外した印と、本人が直したか（列がない古い読み出しでは、どちらも false） */
function editState(row: Row | null): { excluded: boolean; edited: boolean } {
  return { excluded: int(row, 'excluded') === 1, edited: text(row, 'origin') === 'self' };
}

function toFactEdit(row: Row): FactEdit | null {
  const id = text(row, 'id');
  const at = text(row, 'at');
  const fact = text(row, 'fact');
  const target = text(row, 'target');
  const field = text(row, 'field');
  if (id === null || at === null || target === null) return null;
  if (fact !== 'medication' && fact !== 'event' && fact !== 'observation') return null;
  if (field !== 'excluded' && field !== 'action' && field !== 'kind' && field !== 'at') return null;
  return { id, at, fact, target, field, before: text(row, 'before'), after: text(row, 'after') };
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
  return { id, sourceId, label: label as SegmentLabel, ...span, edited: text(row, 'origin') === 'self' };
}

function toMedication(row: Row): Medication | null {
  const id = text(row, 'id');
  const sourceId = text(row, 'source_id');
  const encounterId = text(row, 'encounter_id');
  const name = text(row, 'name');
  const span = spanOf(row);
  if (id === null || sourceId === null || encounterId === null || name === null || span === null) return null;
  const action = text(row, 'action');
  return { id, sourceId, encounterId, name, doseText: text(row, 'dose_text'), action: action as MedicationAction | null, at: text(row, 'at'), ...span, ...editState(row) };
}

function toEvent(row: Row): Event | null {
  const id = text(row, 'id');
  const sourceId = text(row, 'source_id');
  const encounterId = text(row, 'encounter_id');
  const kind = text(row, 'kind');
  const title = text(row, 'title');
  const span = spanOf(row);
  if (id === null || sourceId === null || encounterId === null || kind === null || title === null || span === null) return null;
  return { id, sourceId, encounterId, kind: kind as EventKind, title, at: text(row, 'at'), ...span, ...editState(row) };
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
  const status = text(row, 'status_override');
  const activity = text(row, 'activity_override');
  return {
    id,
    displayName: text(row, 'display_name'),
    mergedInto: text(row, 'merged_into'),
    statusOverride: status === 'problem' || status === 'diagnosis' || status === 'suspected' || status === 'ruled_out' ? status : null,
    activityOverride: activity === 'active' || activity === 'resolved' || activity === 'inactive' ? activity : null,
    ord: int(row, 'ord'),
    excluded: int(row, 'excluded') === 1,
    typedName: text(row, 'typed_name'),
  };
}

/** 問題の筋の列（読み出し） */
export const THREAD_COLUMNS = 'id, display_name, merged_into, status_override, activity_override, ord, excluded, typed_name';

function toApNote(row: Row): ApNote | null {
  const id = text(row, 'id');
  const encounterId = text(row, 'encounter_id');
  const threadId = text(row, 'thread_id');
  const day = text(row, 'day');
  const part = text(row, 'part');
  const body = text(row, 'text');
  const origin = text(row, 'origin');
  const enteredAt = text(row, 'entered_at');
  const updatedAt = text(row, 'updated_at');
  if (id === null || encounterId === null || threadId === null || day === null || body === null || enteredAt === null || updatedAt === null) return null;
  if ((part !== 'assessment' && part !== 'plan') || (origin !== 'self' && origin !== 'ai' && origin !== 'ai_edited')) return null;
  const kind = text(row, 'plan_kind');
  let refs: ApRef[] = [];
  try {
    const parsed: unknown = JSON.parse(text(row, 'refs') ?? '[]');
    if (Array.isArray(parsed)) refs = parsed.map((r) => ApRef.safeParse(r)).flatMap((r) => (r.success ? [r.data] : []));
  } catch {
    // 読めない参照は、ないものとして扱う
  }
  return { id, encounterId, threadId, day, part, planKind: kind === 'dx' || kind === 'tx' || kind === 'ex' || kind === 'other' ? kind : null, text: body, origin, refs, enteredAt, updatedAt };
}

/** A/P の列（読み出し） */
export const AP_COLUMNS = 'id, encounter_id, thread_id, day, part, plan_kind, text, origin, refs, entered_at, updated_at';

export function apNoteOf(row: Row): ApNote | null {
  return toApNote(row);
}

function toUserEdit(row: Row): UserEdit | null {
  const id = text(row, 'id');
  const at = text(row, 'at');
  const targetType = text(row, 'target_type');
  const target = text(row, 'target');
  const field = text(row, 'field');
  if (id === null || at === null || target === null || targetType === null || field === null) return null;
  if (!(USER_EDIT_TARGETS as readonly string[]).includes(targetType) || !(USER_EDIT_FIELDS as readonly string[]).includes(field)) return null;
  return { id, at, targetType: targetType as UserEditTarget, target, field: field as UserEditField, before: text(row, 'before'), after: text(row, 'after') };
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
  /** 回診リストの材料（段3d）：記録の上で最後の日時・いまの問題の名前など。数と名前だけ（文は送らない） */
  readonly round: RoundSummary;
}

export async function listPatients(db: Db): Promise<PatientSummary[]> {
  const [patients, encounters, sourceRows, problemRows, threadRows] = await Promise.all([
    db.prepare('SELECT id, age, age_on, sex, created_on FROM patients ORDER BY id').all(),
    db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters ORDER BY started, id').all(),
    // 文の中身は読まない（日時と、どの受診かだけ）
    db.prepare('SELECT patient_id, encounter_id, at, entered_at FROM sources ORDER BY id').all(),
    db.prepare(`SELECT patient_id, ${PROBLEM_COLUMNS} FROM problems ORDER BY source_id, span_start`).all(),
    db.prepare(`SELECT patient_id, ${THREAD_COLUMNS} FROM problem_threads ORDER BY id`).all(),
  ]);
  const latest = new Map<string, Encounter>();
  for (const e of encounters.results.map(toEncounter).filter(present)) latest.set(e.patientId, e);
  const group = <T>(rows: readonly Row[], to: (row: Row) => T | null): Map<string, T[]> => {
    const out = new Map<string, T[]>();
    for (const row of rows) {
      const value = to(row);
      const key = text(row, 'patient_id');
      if (value === null || key === null) continue;
      const list = out.get(key) ?? [];
      list.push(value);
      out.set(key, list);
    }
    return out;
  };
  const sources = group(sourceRows.results, (row) => {
    const encounterId = text(row, 'encounter_id');
    const enteredAt = text(row, 'entered_at');
    return encounterId === null || enteredAt === null ? null : { encounterId, at: text(row, 'at'), enteredAt };
  });
  const problems = group(problemRows.results, toProblem);
  const threads = group(threadRows.results, toThread);
  return patients.results
    .map(toPatient)
    .filter(present)
    .map((patient) => {
      const own = sources.get(patient.id) ?? [];
      const encounter = latest.get(patient.id) ?? null;
      const round = roundSummary({ encounter: { id: encounter?.id ?? '' }, sources: own, threads: threads.get(patient.id) ?? [], mentions: problems.get(patient.id) ?? [] });
      return { patient, latest: encounter, sources: own.length, round };
    })
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
  /** 本人が事実を直した記録（新しい順。段3e） */
  readonly factEdits: FactEdit[];
  /** 本人の調節の記録（新しい順。CA-029） */
  readonly userEdits: UserEdit[];
  /** A/P（段5。本人が残した・採用した、決まったことだけ） */
  readonly apNotes: ApNote[];
}

/** 問題の列（読み出し） */
export const PROBLEM_COLUMNS = 'id, source_id, encounter_id, name, status, activity, at, span_start, span_end, thread_id, thread_origin';

export async function getRecord(db: Db, id: string): Promise<PatientRecord | null> {
  const patient = await getPatient(db, id);
  if (patient === null) return null;
  const [encounters, sources, observations, segments, medications, events, problems, threads, history, factEdits, userEdits, apNotes] = await Promise.all([
    db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters WHERE patient_id = ? ORDER BY started, id').bind(id).all(),
    db.prepare('SELECT id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced, organized, organized_version, organize_report FROM sources WHERE patient_id = ? ORDER BY id').bind(id).all(),
    db
      .prepare('SELECT id, source_id, encounter_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, excluded, origin FROM observations WHERE patient_id = ? ORDER BY source_id, ord')
      .bind(id)
      .all(),
    db.prepare('SELECT id, source_id, label, span_start, span_end, origin FROM segments WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare('SELECT id, source_id, encounter_id, name, dose_text, action, at, span_start, span_end, excluded, origin FROM medications WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare('SELECT id, source_id, encounter_id, kind, title, at, span_start, span_end, excluded, origin FROM events WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare(`SELECT ${PROBLEM_COLUMNS} FROM problems WHERE patient_id = ? ORDER BY source_id, span_start`).bind(id).all(),
    db.prepare(`SELECT ${THREAD_COLUMNS} FROM problem_threads WHERE patient_id = ? ORDER BY id`).bind(id).all(),
    db.prepare('SELECT id, at, action, target, before, after FROM history WHERE patient_id = ? ORDER BY at DESC, id DESC LIMIT 200').bind(id).all(),
    db.prepare('SELECT id, at, fact, target, field, before, after FROM fact_edits WHERE patient_id = ? ORDER BY at DESC, id DESC LIMIT 500').bind(id).all(),
    db.prepare('SELECT id, at, target_type, target, field, before, after FROM user_edits WHERE patient_id = ? ORDER BY at DESC, id DESC LIMIT 500').bind(id).all(),
    db.prepare(`SELECT ${AP_COLUMNS} FROM ap_notes WHERE patient_id = ? ORDER BY day, entered_at, id`).bind(id).all(),
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
    factEdits: factEdits.results.map(toFactEdit).filter(present),
    userEdits: userEdits.results.map(toUserEdit).filter(present),
    apNotes: apNotes.results.map(toApNote).filter(present),
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
export const PATIENT_TABLES = ['problem_threads', 'history', 'fact_edits', 'user_edits', 'ap_notes', 'ap_history'] as const;

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
  return { id, sourceId: source.id, encounterId: source.encounterId, at: source.at, name: row.name, nameRaw: row.nameRaw, kind: row.kind, value: row.value, comparator: row.comparator, valueText: row.valueText, unit: row.unit, start: row.start, end: row.end, excluded: false, edited: false };
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
