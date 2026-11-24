// 記録の読み書き（段1：患者・受診・取り込んだ文・測定値）。書く表は、docs/04 の 6 の一覧のとおり。
// ここは、形を確かめた後の値だけを受け取る（形の確かめは handler.ts、文の選別は intake.ts）。
import { COURSE_CATEGORIES, type CourseCategory, type SearchInput, DOC_ORIGINS, DOC_TYPES, type DocOrigin, type DocType, isDocOrigin, isHandoffSeverity, latestHandoff, type HandoffSeverity, type SavedHandoff, type ListItem, ListItemShape, roundSummary, type RoundSummary, type SavedDocument, PendingBody, PlanBody, SavedSection, SupportBody, type OrderItem, OrderItems, type ScaleTemplate, ScaleTemplateBody, CONSULT_NOTE_MODES, type ConsultNote } from '@clinical-carte/core';
import { z } from 'zod';
import { ApRef, type ApOrigin, type ApPart, type FactField, type FactKind, type PlanKind, USER_EDIT_FIELDS, USER_EDIT_TARGETS, type UserEditField, type UserEditTarget } from '@clinical-carte/core';
import type { AuthorRole, Comparator, EncounterKind, EventKind, HistoryAction, LabRow, MedicationAction, OrganizeReport, ProblemActivity, ProblemStatus, SegmentLabel, Sex, SourceKind } from '@clinical-carte/core';

import { type CasebookLinkRow, casebookLinks } from './casebook.ts';
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
  /** 日をまたいだ場所（CA-047）。ここより後ろの、日の書かれていない時刻は翌日。なければ null */
  readonly nextDayFrom: number | null;
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
  /** 日時がおおよそのときの印（CA-056） */
  readonly atApprox?: string | null;
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
  readonly atApprox?: string | null;
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
  /** 日時がおおよそのときの印（CA-056） */
  readonly atApprox?: string | null;
  /** AI が読んだ項目と値か（CA-056） */
  readonly readBy?: 'rule' | 'ai';
  /** AI が読んだ数が、書かれた場所の字に見つからない */
  readonly unseen?: boolean;
}

/** 経過の出来事（CA-056） */
export interface CourseItem {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly at: string | null;
  readonly atApprox: string | null;
  readonly category: CourseCategory;
  readonly summary: string;
  readonly start: number;
  readonly end: number;
}

/** AI のプロブレムリスト（CA-057） */
export interface ProblemListRow {
  readonly madeAt: string;
  readonly promptVersion: string;
  readonly basis: string;
  readonly items: readonly ListItem[];
}

/** 結果待ち（段K6。CA-065。患者ごとに1つ） */
export interface PendingRow {
  readonly madeAt: string;
  readonly promptVersion: string;
  readonly basis: string;
  readonly body: PendingBody;
}

/** 予定と実施（段K9。CA-071。患者ごとに1つ） */
export interface PlanRow {
  readonly madeAt: string;
  readonly promptVersion: string;
  readonly basis: string;
  readonly body: PlanBody;
}

/** AI の臨床支援（段K5。CA-064。患者ごとに1つ） */
export interface SupportRow {
  readonly madeAt: string;
  readonly promptVersion: string;
  readonly basis: string;
  readonly body: SupportBody;
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
    nextDayFrom: typeof row?.['next_day_from'] === 'number' ? row['next_day_from'] : null,
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
    atApprox: text(row, 'at_approx'),
    readBy: text(row, 'read_by') === 'ai' ? 'ai' : 'rule',
    unseen: int(row, 'unseen') === 1,
  };
}

function toCourse(row: Row): CourseItem | null {
  const id = text(row, 'id');
  const sourceId = text(row, 'source_id');
  const encounterId = text(row, 'encounter_id');
  const category = text(row, 'category');
  const summary = text(row, 'summary');
  const span = spanOf(row);
  if (id === null || sourceId === null || encounterId === null || category === null || summary === null || span === null) return null;
  if (!(COURSE_CATEGORIES as readonly string[]).includes(category)) return null;
  return { id, sourceId, encounterId, at: text(row, 'at'), atApprox: text(row, 'at_approx'), category: category as CourseCategory, summary, ...span };
}

export function problemListOf(row: Row | null): ProblemListRow | null {
  const madeAt = text(row, 'made_at');
  const promptVersion = text(row, 'prompt_version');
  const basis = text(row, 'basis');
  if (row === null || madeAt === null || promptVersion === null || basis === null) return null;
  let items: ListItem[] = [];
  try {
    const parsed: unknown = JSON.parse(text(row, 'items') ?? '[]');
    if (Array.isArray(parsed)) items = parsed.map((x) => ListItemShape.safeParse(x)).flatMap((r) => (r.success ? [r.data] : []));
  } catch {
    // 読めない中身は、空として扱う
  }
  return { madeAt, promptVersion, basis, items };
}

/** 支援の行を読む（中身が読めなければ null：組み直すと、また作られる） */
export function supportOf(row: Row | null): SupportRow | null {
  const madeAt = text(row, 'made_at');
  const promptVersion = text(row, 'prompt_version');
  const basis = text(row, 'basis');
  if (row === null || madeAt === null || promptVersion === null || basis === null) return null;
  try {
    const parsed = SupportBody.safeParse(JSON.parse(text(row, 'body') ?? 'null'));
    return parsed.success ? { madeAt, promptVersion, basis, body: parsed.data } : null;
  } catch {
    return null;
  }
}

/** 結果待ちの行を読む（中身が読めなければ null：組み直すと、また作られる） */
export function pendingOf(row: Row | null): PendingRow | null {
  const madeAt = text(row, 'made_at');
  const promptVersion = text(row, 'prompt_version');
  const basis = text(row, 'basis');
  if (row === null || madeAt === null || promptVersion === null || basis === null) return null;
  try {
    const parsed = PendingBody.safeParse(JSON.parse(text(row, 'body') ?? 'null'));
    return parsed.success ? { madeAt, promptVersion, basis, body: parsed.data } : null;
  } catch {
    return null;
  }
}

/** 予定と実施の行を読む（中身が読めなければ null：組み直すと、また作られる） */
export function planOf(row: Row | null): PlanRow | null {
  const madeAt = text(row, 'made_at');
  const promptVersion = text(row, 'prompt_version');
  const basis = text(row, 'basis');
  if (row === null || madeAt === null || promptVersion === null || basis === null) return null;
  try {
    const parsed = PlanBody.safeParse(JSON.parse(text(row, 'body') ?? 'null'));
    return parsed.success ? { madeAt, promptVersion, basis, body: parsed.data } : null;
  } catch {
    return null;
  }
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
  return { id, sourceId, encounterId, name, doseText: text(row, 'dose_text'), action: action as MedicationAction | null, at: text(row, 'at'), atApprox: text(row, 'at_approx'), ...span, ...editState(row) };
}

function toEvent(row: Row): Event | null {
  const id = text(row, 'id');
  const sourceId = text(row, 'source_id');
  const encounterId = text(row, 'encounter_id');
  const kind = text(row, 'kind');
  const title = text(row, 'title');
  const span = spanOf(row);
  if (id === null || sourceId === null || encounterId === null || kind === null || title === null || span === null) return null;
  return { id, sourceId, encounterId, kind: kind as EventKind, title, at: text(row, 'at'), atApprox: text(row, 'at_approx'), ...span, ...editState(row) };
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

/** 参照の欄（JSON）を読む。読めない参照は、ないものとして扱う */
function refsOf(row: Row): ApRef[] {
  try {
    const parsed: unknown = JSON.parse(text(row, 'refs') ?? '[]');
    if (Array.isArray(parsed)) return parsed.map((r) => ApRef.safeParse(r)).flatMap((r) => (r.success ? [r.data] : []));
  } catch {
    // 読めない参照は、ないものとして扱う
  }
  return [];
}

/** 相談の窓口で残した答え（段M。CA-081） */
function toConsultNote(row: Row): ConsultNote | null {
  const id = text(row, 'id');
  const mode = CONSULT_NOTE_MODES.find((m) => m === text(row, 'mode'));
  const body = text(row, 'text');
  const enteredAt = text(row, 'entered_at');
  if (id === null || mode === undefined || body === null || enteredAt === null) return null;
  return { id, mode, text: body, refs: refsOf(row), enteredAt, edited: int(row, 'edited') === 1, updatedAt: text(row, 'updated_at') ?? enteredAt };
}

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
  const refs = refsOf(row);
  return { id, encounterId, threadId, day, part, planKind: kind === 'dx' || kind === 'tx' || kind === 'ex' || kind === 'other' ? kind : null, text: body, origin, refs, enteredAt, updatedAt };
}

/** 残したカルテ記載の列（読み出し。段I） */
export const DOCUMENT_COLUMNS = 'id, encounter_id, type, day, sections, origin, entered_at, updated_at';

function toDocument(row: Row): SavedDocument | null {
  const id = text(row, 'id');
  const encounterId = text(row, 'encounter_id');
  const type = text(row, 'type');
  const day = text(row, 'day');
  const origin = text(row, 'origin');
  const enteredAt = text(row, 'entered_at');
  const updatedAt = text(row, 'updated_at');
  if (id === null || encounterId === null || type === null || day === null || origin === null || enteredAt === null || updatedAt === null) return null;
  if (!(DOC_TYPES as readonly string[]).includes(type) || !(DOC_ORIGINS as readonly string[]).includes(origin)) return null;
  let sections: z.infer<typeof SavedSection>[] = [];
  try {
    const parsed = z.array(SavedSection).safeParse(JSON.parse(text(row, 'sections') ?? '[]'));
    if (parsed.success) sections = parsed.data;
  } catch {
    // 読めない中身は、空として扱う
  }
  return { id, encounterId, type: type as DocType, day, sections, origin: origin as DocOrigin, enteredAt, updatedAt };
}

export function documentOf(row: Row): SavedDocument | null {
  return toDocument(row);
}

/** 残した申し送りの列（読み出し。段K7） */
export const HANDOFF_COLUMNS = 'id, encounter_id, day, severity, sections, origin, entered_at, updated_at';

export function handoffOf(row: Row | null): SavedHandoff | null {
  const id = text(row, 'id');
  const encounterId = text(row, 'encounter_id');
  const day = text(row, 'day');
  const severity = text(row, 'severity');
  const origin = text(row, 'origin');
  const enteredAt = text(row, 'entered_at');
  const updatedAt = text(row, 'updated_at');
  if (row === null || id === null || encounterId === null || day === null || enteredAt === null || updatedAt === null || !isHandoffSeverity(severity) || !isDocOrigin(origin)) return null;
  let sections: z.infer<typeof SavedSection>[] = [];
  try {
    const parsed = z.array(SavedSection).safeParse(JSON.parse(text(row, 'sections') ?? '[]'));
    if (parsed.success) sections = parsed.data;
  } catch {
    // 読めない中身は、空として扱う
  }
  return { id, encounterId, day, severity, sections, origin, enteredAt, updatedAt };
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
  /** いちばん新しい受診の、いちばん新しい申し送り（段K7）の日と、先生が選んだ重症度だけ（文は送らない。なければ null） */
  readonly handoff: { readonly id: string; readonly day: string; readonly severity: HandoffSeverity } | null;
}

export async function listPatients(db: Db): Promise<PatientSummary[]> {
  const [patients, encounters, sourceRows, problemRows, threadRows, listRows, handoffRows] = await Promise.all([
    db.prepare('SELECT id, age, age_on, sex, created_on FROM patients ORDER BY id').all(),
    db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters ORDER BY started, id').all(),
    // 文の中身は読まない（日時と、どの受診かだけ）
    db.prepare('SELECT patient_id, encounter_id, at, entered_at FROM sources ORDER BY id').all(),
    db.prepare(`SELECT patient_id, ${PROBLEM_COLUMNS} FROM problems ORDER BY source_id, span_start`).all(),
    db.prepare(`SELECT patient_id, ${THREAD_COLUMNS} FROM problem_threads ORDER BY id`).all(),
    // AI のプロブレムリスト（CA-057）：回診リストの問題を、リストの番号と名前にする（2026-11-22）
    db.prepare('SELECT patient_id, made_at, prompt_version, basis, items FROM problem_lists').all(),
    // 申し送り（段K7）：日と重症度だけ（文は読まない）
    db.prepare('SELECT id, patient_id, encounter_id, day, severity, updated_at FROM handoffs').all(),
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
  const handoffs = group(handoffRows.results, (row) => {
    const id = text(row, 'id');
    const encounterId = text(row, 'encounter_id');
    const day = text(row, 'day');
    const severity = text(row, 'severity');
    const updatedAt = text(row, 'updated_at');
    return id === null || encounterId === null || day === null || updatedAt === null || !isHandoffSeverity(severity) ? null : { id, encounterId, day, severity, updatedAt };
  });
  const lists = new Map<string, readonly ListItem[]>();
  for (const row of listRows.results) {
    const key = text(row, 'patient_id');
    const list = problemListOf(row);
    if (key !== null && list !== null) lists.set(key, list.items);
  }
  return patients.results
    .map(toPatient)
    .filter(present)
    .map((patient) => {
      const own = sources.get(patient.id) ?? [];
      const encounter = latest.get(patient.id) ?? null;
      const round = roundSummary({ encounter: { id: encounter?.id ?? '' }, sources: own, threads: threads.get(patient.id) ?? [], mentions: problems.get(patient.id) ?? [], list: lists.get(patient.id) ?? [] });
      const last = latestHandoff((handoffs.get(patient.id) ?? []).filter((h) => h.encounterId === encounter?.id));
      return { patient, latest: encounter, sources: own.length, round, handoff: last === null ? null : { id: last.id, day: last.day, severity: last.severity } };
    })
    // いちばん新しい受診の開始が新しい順（受け持ち中の患者が上に来る）
    .sort((a, b) => (b.latest?.start ?? '').localeCompare(a.latest?.start ?? '') || b.patient.id.localeCompare(a.patient.id));
}


/**
 * 受け持ちを横断する検索（段K8。CA-070）の資料：すべての患者の、保存した文（識別情報を置き換えた後）と、整理した事実の名前・題・要約。
 * 読むだけ（何も書かない）。外した事実・隠した項目・外した筋の記載は、渡さない（見方と同じ）。問いは、ここに来ない
 */
export async function searchInput(db: Db): Promise<SearchInput> {
  const [patients, encounters, sources, medications, events, course, observations, problems, threads, lists] = await Promise.all([
    db.prepare('SELECT id, age, age_on, sex, created_on FROM patients ORDER BY id').all(),
    db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters ORDER BY started, id').all(),
    db.prepare('SELECT id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced, organized, organized_version, organize_report, next_day_from FROM sources ORDER BY id').all(),
    db.prepare('SELECT id, source_id, encounter_id, name, dose_text, action, at, at_approx, span_start, span_end, excluded, origin FROM medications ORDER BY source_id, span_start').all(),
    db.prepare('SELECT id, source_id, encounter_id, kind, title, at, at_approx, span_start, span_end, excluded, origin FROM events ORDER BY source_id, span_start').all(),
    db.prepare('SELECT id, source_id, encounter_id, at, at_approx, category, summary, span_start, span_end FROM course_items ORDER BY source_id, span_start').all(),
    db.prepare('SELECT id, source_id, encounter_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, excluded, origin FROM observations ORDER BY source_id, ord').all(),
    db.prepare(`SELECT ${PROBLEM_COLUMNS} FROM problems ORDER BY source_id, span_start`).all(),
    db.prepare(`SELECT patient_id, ${THREAD_COLUMNS} FROM problem_threads ORDER BY id`).all(),
    db.prepare('SELECT patient_id, made_at, prompt_version, basis, items FROM problem_lists').all(),
  ]);
  const sourceList = sources.results.map(toSource).filter(present);
  const atOf = new Map(sourceList.map((s) => [s.id, s.at]));
  const threadRows = threads.results.flatMap((row) => {
    const t = toThread(row);
    const patientId = text(row, 'patient_id');
    return t === null || patientId === null ? [] : [{ ...t, patientId }];
  });
  const excludedThreads = new Set(threadRows.filter((t) => t.excluded).map((t) => t.id));
  const mentions = problems.results.map(toProblem).filter(present);
  // 打って直した名前の開く場所：その筋の、いちばん新しい記載
  const latestMention = new Map<string, { sourceId: string; start: number; at: string | null }>();
  for (const m of mentions) {
    if (m.threadId === null) continue;
    const at = atOf.get(m.sourceId) ?? null;
    const prev = latestMention.get(m.threadId);
    if (prev === undefined || (at !== null && (prev.at === null || at >= prev.at))) latestMention.set(m.threadId, { sourceId: m.sourceId, start: m.start, at });
  }
  return {
    patients: patients.results.map(toPatient).filter(present),
    encounters: encounters.results.map(toEncounter).filter(present),
    sources: sourceList.map((s) => ({ id: s.id, patientId: s.patientId, encounterId: s.encounterId, kind: s.kind, at: s.at, text: s.text })),
    medications: medications.results.map(toMedication).filter(present).map((m) => ({ id: m.id, sourceId: m.sourceId, start: m.start, end: m.end, name: m.name, excluded: m.excluded })),
    events: events.results.map(toEvent).filter(present).map((e) => ({ id: e.id, sourceId: e.sourceId, start: e.start, end: e.end, title: e.title, excluded: e.excluded })),
    course: course.results.map(toCourse).filter(present).map((c) => ({ id: c.id, sourceId: c.sourceId, start: c.start, end: c.end, summary: c.summary })),
    observations: observations.results.map(toObservation).filter(present).map((o) => ({ id: o.id, sourceId: o.sourceId, start: o.start, end: o.end, name: o.name, excluded: o.excluded, at: o.at })),
    problems: mentions.filter((m) => m.threadId === null || !excludedThreads.has(m.threadId)).map((m) => ({ id: m.id, sourceId: m.sourceId, start: m.start, end: m.end, name: m.name })),
    typedThreads: threadRows
      .filter((t) => !t.excluded && t.mergedInto === null && t.typedName !== null && t.typedName !== '')
      .map((t) => {
        const where = latestMention.get(t.id);
        return { id: t.id, patientId: t.patientId, name: t.typedName ?? '', sourceId: where?.sourceId ?? null, start: where?.start ?? 0 };
      }),
    listItems: lists.results.flatMap((row) => {
      const patientId = text(row, 'patient_id');
      const list = problemListOf(row);
      return patientId === null || list === null ? [] : list.items.filter((i) => !i.hidden).map((i) => ({ patientId, key: i.key, name: i.name }));
    }),
  };
}

/** 受け持ち全員の申し送り（段K7）：患者ごとに、いちばん新しい受診の、いちばん新しい申し送り（残したものだけ。AI は呼ばない） */
export async function latestHandoffs(db: Db): Promise<{ readonly patientId: string; readonly handoff: SavedHandoff }[]> {
  const [encounters, rows] = await Promise.all([
    db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters ORDER BY started, id').all(),
    db.prepare(`SELECT patient_id, ${HANDOFF_COLUMNS} FROM handoffs`).all(),
  ]);
  const latest = new Map<string, string>();
  for (const e of encounters.results.map(toEncounter).filter(present)) latest.set(e.patientId, e.id);
  const by = new Map<string, SavedHandoff[]>();
  for (const row of rows.results) {
    const patientId = text(row, 'patient_id');
    const h = handoffOf(row);
    if (patientId === null || h === null || latest.get(patientId) !== h.encounterId) continue;
    by.set(patientId, [...(by.get(patientId) ?? []), h]);
  }
  return [...by.entries()].flatMap(([patientId, list]) => {
    const h = latestHandoff(list);
    return h === null ? [] : [{ patientId, handoff: h }];
  });
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
  /** 単位の「同じ目盛り」（CA-051。全患者に共通。外したものは入れない） */
  readonly scaleLinks: ScaleLinkRow[];
  /** 残したカルテ記載（段I。CA-054） */
  readonly documents: SavedDocument[];
  /** 残した申し送り（段K7。CA-067。新しい順） */
  readonly handoffs: SavedHandoff[];
  /** 経過の出来事（CA-056） */
  readonly course: CourseItem[];
  /** AI のプロブレムリスト（CA-057。まだなければ null） */
  readonly problemList: ProblemListRow | null;
  /** AI の臨床支援（段K5。CA-064。まだなければ null） */
  readonly support: SupportRow | null;
  /** 結果待ち（段K6。CA-065。まだなければ null） */
  readonly pending: PendingRow | null;
  /** 予定と実施（段K9。CA-071。まだなければ null） */
  readonly plans: PlanRow | null;
  /** Casebook へ送る印（段K10。CA-073。受診ごと。種・症例コード・取り込んだ項目の印だけ） */
  readonly casebook: CasebookLinkRow[];
  /** 指示簿（段K11。CA-074。受診ごとに1つ） */
  readonly orders: OrderSheetRow[];
  /** スケールのテンプレ（段K11。CA-075。全患者に共通。外したものは入れない） */
  readonly orderTemplates: ScaleTemplate[];
  /** 相談の窓口で、先生が残した答え（段M。CA-081。新しい順） */
  readonly consultNotes: ConsultNote[];
}

export interface OrderSheetRow {
  readonly encounterId: string;
  readonly items: OrderItem[];
  readonly updatedAt: string;
}

/** 指示簿の行を読む（中身が読めなければ null） */
export function orderSheetOf(row: Row | null): OrderSheetRow | null {
  const encounterId = text(row, 'encounter_id');
  const updatedAt = text(row, 'updated_at');
  if (row === null || encounterId === null || updatedAt === null) return null;
  try {
    const parsed = OrderItems.safeParse(JSON.parse(text(row, 'items') ?? 'null'));
    return parsed.success ? { encounterId, items: parsed.data, updatedAt } : null;
  } catch {
    return null;
  }
}

/** テンプレの行を読む（中身が読めなければ null） */
export function orderTemplateOf(row: Row | null): ScaleTemplate | null {
  const id = text(row, 'id');
  const createdAt = text(row, 'created_at');
  const updatedAt = text(row, 'updated_at');
  if (row === null || id === null || createdAt === null || updatedAt === null) return null;
  try {
    const parsed = ScaleTemplateBody.safeParse(JSON.parse(text(row, 'body') ?? 'null'));
    return parsed.success ? { id, body: parsed.data, createdAt, updatedAt } : null;
  } catch {
    return null;
  }
}

/** 使っているテンプレ（外したものは除く。作った順） */
export async function listOrderTemplates(db: Db): Promise<ScaleTemplate[]> {
  const rows = await db.prepare('SELECT id, body, created_at, updated_at FROM order_templates WHERE removed_at IS NULL ORDER BY created_at, id').all();
  return rows.results.map(orderTemplateOf).filter(present);
}

export interface ScaleLinkRow {
  readonly id: string;
  readonly name: string;
  readonly unitA: string;
  readonly unitB: string;
  readonly createdAt: string;
}

const toScaleLink = (row: Row | null): ScaleLinkRow | null => {
  const id = text(row, 'id');
  const name = text(row, 'name');
  const unitA = text(row, 'unit_a');
  const unitB = text(row, 'unit_b');
  const createdAt = text(row, 'created_at');
  return id === null || name === null || unitA === null || unitB === null || createdAt === null ? null : { id, name, unitA, unitB, createdAt };
};

/** 使っている「同じ目盛り」の組（外したものは除く） */
export async function listScaleLinks(db: Db): Promise<ScaleLinkRow[]> {
  const rows = await db.prepare('SELECT id, name, unit_a, unit_b, created_at FROM scale_links WHERE removed_at IS NULL ORDER BY created_at, id').all();
  return rows.results.map(toScaleLink).filter(present);
}

/** 問題の列（読み出し） */
export const PROBLEM_COLUMNS = 'id, source_id, encounter_id, name, status, activity, at, span_start, span_end, thread_id, thread_origin';

export async function getRecord(db: Db, id: string): Promise<PatientRecord | null> {
  const patient = await getPatient(db, id);
  if (patient === null) return null;
  const [encounters, sources, observations, segments, medications, events, problems, threads, history, factEdits, userEdits, apNotes, scaleLinks, documents, course, problemList, support, pending, handoffs, plans, casebook, orders, orderTemplates, consultNotes] = await Promise.all([
    db.prepare('SELECT id, patient_id, kind, started, ended FROM encounters WHERE patient_id = ? ORDER BY started, id').bind(id).all(),
    db.prepare('SELECT id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced, organized, organized_version, organize_report, next_day_from FROM sources WHERE patient_id = ? ORDER BY id').bind(id).all(),
    db
      .prepare('SELECT id, source_id, encounter_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, excluded, origin, at_approx, read_by, unseen FROM observations WHERE patient_id = ? ORDER BY source_id, ord')
      .bind(id)
      .all(),
    db.prepare('SELECT id, source_id, label, span_start, span_end, origin FROM segments WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare('SELECT id, source_id, encounter_id, name, dose_text, action, at, at_approx, span_start, span_end, excluded, origin FROM medications WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare('SELECT id, source_id, encounter_id, kind, title, at, at_approx, span_start, span_end, excluded, origin FROM events WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare(`SELECT ${PROBLEM_COLUMNS} FROM problems WHERE patient_id = ? ORDER BY source_id, span_start`).bind(id).all(),
    db.prepare(`SELECT ${THREAD_COLUMNS} FROM problem_threads WHERE patient_id = ? ORDER BY id`).bind(id).all(),
    db.prepare('SELECT id, at, action, target, before, after FROM history WHERE patient_id = ? ORDER BY at DESC, id DESC LIMIT 200').bind(id).all(),
    db.prepare('SELECT id, at, fact, target, field, before, after FROM fact_edits WHERE patient_id = ? ORDER BY at DESC, id DESC LIMIT 500').bind(id).all(),
    db.prepare('SELECT id, at, target_type, target, field, before, after FROM user_edits WHERE patient_id = ? ORDER BY at DESC, id DESC LIMIT 500').bind(id).all(),
    db.prepare(`SELECT ${AP_COLUMNS} FROM ap_notes WHERE patient_id = ? ORDER BY day, entered_at, id`).bind(id).all(),
    listScaleLinks(db),
    db.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE patient_id = ? ORDER BY day DESC, updated_at DESC, id DESC`).bind(id).all(),
    db.prepare('SELECT id, source_id, encounter_id, at, at_approx, category, summary, span_start, span_end FROM course_items WHERE patient_id = ? ORDER BY source_id, span_start').bind(id).all(),
    db.prepare('SELECT made_at, prompt_version, basis, items FROM problem_lists WHERE patient_id = ?').bind(id).first(),
    db.prepare('SELECT made_at, prompt_version, basis, body FROM clinical_support WHERE patient_id = ?').bind(id).first(),
    db.prepare('SELECT made_at, prompt_version, basis, body FROM pending_results WHERE patient_id = ?').bind(id).first(),
    db.prepare(`SELECT ${HANDOFF_COLUMNS} FROM handoffs WHERE patient_id = ? ORDER BY day DESC, updated_at DESC, id DESC`).bind(id).all(),
    db.prepare('SELECT made_at, prompt_version, basis, body FROM plan_checks WHERE patient_id = ?').bind(id).first(),
    casebookLinks(db, id),
    db.prepare('SELECT encounter_id, items, updated_at FROM order_sheets WHERE patient_id = ? ORDER BY encounter_id').bind(id).all(),
    listOrderTemplates(db),
    db.prepare('SELECT id, mode, text, refs, entered_at, edited, updated_at FROM consult_notes WHERE patient_id = ? ORDER BY entered_at DESC, id DESC LIMIT 100').bind(id).all(),
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
    scaleLinks,
    documents: documents.results.map(toDocument).filter(present),
    handoffs: handoffs.results.map(handoffOf).filter(present),
    course: course.results.map(toCourse).filter(present),
    problemList: problemListOf(problemList),
    support: supportOf(support),
    pending: pendingOf(pending),
    plans: planOf(plans),
    casebook,
    orders: orders.results.map(orderSheetOf).filter(present),
    orderTemplates,
    consultNotes: consultNotes.results.map(toConsultNote).filter(present),
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

/** 受診の種類を変える（開始・終わりの日時は、そのまま） */
export async function setEncounterKind(db: Db, id: string, kind: EncounterKind): Promise<number> {
  const r = await db.prepare('UPDATE encounters SET kind = ? WHERE id = ?').bind(kind, id).run();
  return r.meta?.changes ?? 0;
}

export async function setEncounterEnd(db: Db, id: string, end: string | null): Promise<number> {
  const r = await db.prepare('UPDATE encounters SET ended = ? WHERE id = ?').bind(end, id).run();
  return r.meta?.changes ?? 0;
}

/** 文から作った行の表（文を消すと、一緒に消える。整理し直すと、入れ替わる） */
export const FACT_TABLES = ['observations', 'segments', 'medications', 'events', 'problems', 'course_items'] as const;

/** 患者に付く、文からではない行の表（患者を消すと、一緒に消える。文を消しても残る：筋は、記載がなくなると見えなくなるだけ） */
export const PATIENT_TABLES = ['problem_threads', 'history', 'fact_edits', 'user_edits', 'ap_notes', 'ap_history', 'documents', 'document_history', 'handoffs', 'problem_lists', 'problem_list_edits', 'clinical_support', 'pending_results', 'pending_result_edits', 'plan_checks', 'plan_check_edits', 'casebook_links', 'order_sheets', 'order_edits', 'consult_notes', 'consult_note_history'] as const;

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
export async function saveSource(db: Db, source: Source, observations: readonly NewObservation[], sendKey: string | null = null): Promise<void> {
  await db.batch([
    db
      .prepare('INSERT INTO sources (id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced, next_day_from, send_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(source.id, source.patientId, source.encounterId, source.kind, source.authorRole, source.at, source.enteredAt, source.text, JSON.stringify(source.replaced), source.nextDayFrom, sendKey),
    ...observations.map(({ id, row }, index) =>
      db
        .prepare(
          "INSERT INTO observations (id, patient_id, encounter_id, source_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, ord, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parser')",
        )
        .bind(id, source.patientId, source.encounterId, source.id, source.at, row.name, row.nameRaw, row.kind, row.value, row.comparator, row.valueText, row.unit, row.start, row.end, index),
    ),
  ]);
}

/** 送る鍵（段K9。CA-072）で、同じ受診にすでに保存した文と、その文から読んだ測定値を探す（送り直しで二重に保存しないため）。なければ null */
export async function sourceBySendKey(db: Db, encounterId: string, sendKey: string): Promise<{ source: Source; observations: Observation[] } | null> {
  const source = toSource(
    await db
      .prepare('SELECT id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced, organized, organized_version, organize_report, next_day_from FROM sources WHERE encounter_id = ? AND send_key = ?')
      .bind(encounterId, sendKey)
      .first(),
  );
  if (source === null) return null;
  const rows = await db
    .prepare("SELECT id, source_id, encounter_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, excluded, origin, at_approx, read_by, unseen FROM observations WHERE source_id = ? AND origin = 'parser' ORDER BY ord")
    .bind(source.id)
    .all();
  return { source, observations: rows.results.map(toObservation).filter(present) };
}

export function observationOf(source: Source, { id, row }: NewObservation): Observation {
  return { id, sourceId: source.id, encounterId: source.encounterId, at: source.at, name: row.name, nameRaw: row.nameRaw, kind: row.kind, value: row.value, comparator: row.comparator, valueText: row.valueText, unit: row.unit, start: row.start, end: row.end, excluded: false, edited: false };
}

export async function getSource(db: Db, id: string): Promise<Source | null> {
  return toSource(await db.prepare('SELECT id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced, organized, organized_version, organize_report, next_day_from FROM sources WHERE id = ?').bind(id).first());
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
