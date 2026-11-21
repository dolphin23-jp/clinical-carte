// サーバーの API を呼ぶ、ただ1つの場所（ESLint と試験が見張る）。宛先は、自分のオリジンの /api/ だけ。
// 印（Cookie）は、ブラウザが付ける。画面のプログラムからは読めない（HttpOnly）。
import type {
  AuthorRole,
  Comparator,
  DeviceKind,
  EncounterKind,
  EventKind,
  MedicationAction,
  NewEncounter,
  NewPatient,
  NewSource,
  OrganizeReport,
  ActivityOverride,
  AddFact,
  CheckedDraft,
  ApNoteNew,
  ApNotePatch,
  ApOrigin,
  ApPart,
  ApRef,
  CheckedDiscussion,
  CheckedProposal,
  PlanKind,
  SegmentPatch,
  SourcePatch,
  ThreadPatch,
  UserEditField,
  UserEditTarget,
  FactField,
  FactKind,
  FactPatch,
  HistoryAction,
  PatientPatch,
  ProblemActivity,
  ProblemStatus,
  RoundSummary,
  SegmentLabel,
  Sex,
  SourceKind,
} from '@clinical-carte/core';

export interface DeviceView {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly registeredOn: string;
  readonly lastUsedOn: string;
  readonly current: boolean;
}

/** サーバーが返す、誤りの名前。network は、つながらない・答えが読めない */
export type ApiError =
  | 'network'
  | 'no_key'
  | 'unregistered'
  | 'wrong_key'
  | 'locked'
  | 'too_many_devices'
  | 'not_found'
  | 'server'
  | 'bad_request'
  | 'no_ai'
  | 'ai_limit'
  | 'ai_refused'
  | 'ai_unavailable'
  | 'ai_bad_answer'
  | 'selection_failed'
  | 'conflict'
  | 'draft_empty'
  | 'ap_empty'
  | 'shape'
  | 'bad_span';

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError; readonly left?: number };

const KNOWN: readonly ApiError[] = [
  'no_key',
  'unregistered',
  'wrong_key',
  'locked',
  'too_many_devices',
  'not_found',
  'server',
  'bad_request',
  'no_ai',
  'ai_limit',
  'ai_refused',
  'ai_unavailable',
  'ai_bad_answer',
  'selection_failed',
  'conflict',
  'draft_empty',
  'ap_empty',
  'shape',
  'bad_span',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Result<Record<string, unknown>>> {
  let response: Response;
  let data: unknown;
  try {
    const init: RequestInit = { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    response = await fetch(`/api/${path}`, init);
    data = await response.json();
  } catch {
    return { ok: false, error: 'network' };
  }
  if (!isRecord(data)) return { ok: false, error: 'network' };
  if (response.ok) return { ok: true, value: data };
  const name = data['error'];
  const error = KNOWN.find((k) => k === name) ?? 'server';
  const left = data['left'];
  return typeof left === 'number' ? { ok: false, error, left } : { ok: false, error };
}

function toDevice(value: unknown): DeviceView | null {
  if (!isRecord(value)) return null;
  const { id, kind, registeredOn, lastUsedOn, current } = value;
  if (typeof id !== 'string' || typeof registeredOn !== 'string' || typeof lastUsedOn !== 'string' || typeof current !== 'boolean') return null;
  if (kind !== 'iphone' && kind !== 'ipad' && kind !== 'pc' && kind !== 'other') return null;
  return { id, kind, registeredOn, lastUsedOn, current };
}

function oneDevice(result: Result<Record<string, unknown>>): Result<DeviceView> {
  if (!result.ok) return result;
  const device = toDevice(result.value['device']);
  return device === null ? { ok: false, error: 'network' } : { ok: true, value: device };
}

/** この端末が登録済みか。 */
export async function getSession(): Promise<Result<DeviceView>> {
  return oneDevice(await call('GET', 'session'));
}

/** この端末を登録する（最初の1回）。合鍵は、この要求で送るだけで、画面のどこにも残さない。 */
export async function registerDevice(key: string, kind: DeviceKind): Promise<Result<DeviceView>> {
  return oneDevice(await call('POST', 'devices', { key, kind }));
}

export async function listDevices(): Promise<Result<DeviceView[]>> {
  const result = await call('GET', 'devices');
  if (!result.ok) return result;
  const list = result.value['devices'];
  if (!Array.isArray(list)) return { ok: false, error: 'network' };
  const devices = list.map(toDevice);
  return devices.every((d): d is DeviceView => d !== null) ? { ok: true, value: devices } : { ok: false, error: 'network' };
}

export async function removeDevice(id: string): Promise<Result<null>> {
  const result = await call('DELETE', `devices/${encodeURIComponent(id)}`);
  return result.ok ? { ok: true, value: null } : result;
}

// --- 記録（段1：患者・受診・取り込み）。サーバーが返した形を、そのまま使う（形の確かめは、サーバーと同じ core の型の側にある）

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
  readonly encounterId: string;
  readonly kind: SourceKind;
  readonly authorRole: AuthorRole;
  readonly at: string | null;
  readonly enteredAt: string;
  readonly text: string;
  readonly replaced: Readonly<Record<string, number>>;
  /** 整理の状態：null（まだ）・done・failed */
  readonly organized: 'done' | 'failed' | null;
  readonly organizedVersion: string | null;
  readonly organizeReport: OrganizeReport;
}

export interface Segment {
  readonly id: string;
  readonly sourceId: string;
  readonly label: SegmentLabel;
  readonly start: number;
  readonly end: number;
  /** 本人が足した・見出しを直した区切り */
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
  /** 本人が外した（段3e。見方から除く） */
  readonly excluded: boolean;
  /** 本人が直した（段3e） */
  readonly edited: boolean;
}

export interface ClinicalEvent {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
  /** 本人が外した（段3e。見方から除く） */
  readonly excluded: boolean;
  /** 本人が直した（段3e） */
  readonly edited: boolean;
}

export interface Problem {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly name: string;
  readonly status: ProblemStatus;
  readonly activity: ProblemActivity | null;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
  readonly threadId: string | null;
  readonly threadOrigin: 'rule' | 'ai' | 'self' | null;
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

export interface ProblemThread {
  readonly id: string;
  readonly displayName: string | null;
  readonly mergedInto: string | null;
  readonly statusOverride: ProblemStatus | null;
  readonly activityOverride: ActivityOverride | null;
  readonly ord: number | null;
  readonly excluded: boolean;
  readonly typedName: string | null;
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
  /** 本人が外した（段3e。見方から除く） */
  readonly excluded: boolean;
  /** 本人が直した（段3e） */
  readonly edited: boolean;
}

export interface PatientSummary {
  readonly patient: Patient;
  readonly latest: Encounter | null;
  readonly sources: number;
  /** 回診リストの材料（段3d） */
  readonly round: RoundSummary;
}

/** 残した A/P（段5）。参照は場所・題・頁・URL だけ（本文なし） */
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

export interface PatientRecord {
  readonly patient: Patient;
  readonly encounters: readonly Encounter[];
  readonly sources: readonly Source[];
  readonly observations: readonly Observation[];
  readonly segments: readonly Segment[];
  readonly medications: readonly Medication[];
  readonly events: readonly ClinicalEvent[];
  readonly problems: readonly Problem[];
  readonly problemThreads: readonly ProblemThread[];
  readonly history: readonly HistoryEntry[];
  readonly factEdits: readonly FactEdit[];
  readonly userEdits: readonly UserEdit[];
  /** A/P（段5。本人が書いた・AI の案から採用した、決まったことだけ） */
  readonly apNotes: readonly ApNote[];
  /** サーバーの、今日（日本の日） */
  readonly today: string;
}

/** 答えの中の欄を、決めた型として読む（欄がなければ、つながらないのと同じ扱い） */
function field<T>(result: Result<Record<string, unknown>>, name: string): Result<T> {
  if (!result.ok) return result;
  const value = result.value[name];
  return value === undefined || value === null ? { ok: false, error: 'network' } : { ok: true, value: value as T };
}

export async function listPatients(): Promise<Result<{ patients: readonly PatientSummary[]; today: string }>> {
  const result = await call('GET', 'patients');
  if (!result.ok) return result;
  const { patients, today } = result.value;
  return Array.isArray(patients) && typeof today === 'string' ? { ok: true, value: { patients: patients as PatientSummary[], today } } : { ok: false, error: 'network' };
}

export async function createPatient(input: NewPatient): Promise<Result<Patient>> {
  return field<Patient>(await call('POST', 'patients', input), 'patient');
}

export async function getRecord(patientId: string): Promise<Result<PatientRecord>> {
  const result = await call('GET', `patients/${encodeURIComponent(patientId)}`);
  if (!result.ok) return result;
  const { patient, encounters, sources, observations, segments, medications, events, problems, problemThreads, history, factEdits, userEdits, apNotes, today } = result.value;
  const lists = [encounters, sources, observations, segments, medications, events, problems, problemThreads, history, factEdits, userEdits, apNotes];
  if (!isRecord(patient) || lists.some((l) => !Array.isArray(l)) || typeof today !== 'string') return { ok: false, error: 'network' };
  return {
    ok: true,
    value: {
      patient: patient as unknown as Patient,
      encounters: encounters as Encounter[],
      sources: sources as Source[],
      observations: observations as Observation[],
      segments: segments as Segment[],
      medications: medications as Medication[],
      events: events as ClinicalEvent[],
      problems: problems as Problem[],
      problemThreads: problemThreads as ProblemThread[],
      history: history as HistoryEntry[],
      factEdits: factEdits as FactEdit[],
      userEdits: userEdits as UserEdit[],
      apNotes: apNotes as ApNote[],
      today,
    },
  };
}

export async function patchPatient(patientId: string, patch: PatientPatch): Promise<Result<Patient>> {
  return field<Patient>(await call('PATCH', `patients/${encodeURIComponent(patientId)}`, patch), 'patient');
}

export async function deletePatient(patientId: string): Promise<Result<null>> {
  const result = await call('DELETE', `patients/${encodeURIComponent(patientId)}`);
  return result.ok ? { ok: true, value: null } : result;
}

export async function createEncounter(patientId: string, input: NewEncounter): Promise<Result<Encounter>> {
  return field<Encounter>(await call('POST', `patients/${encodeURIComponent(patientId)}/encounters`, input), 'encounter');
}

export async function setEncounterEnd(encounterId: string, end: string | null): Promise<Result<Encounter>> {
  return field<Encounter>(await call('PATCH', `encounters/${encodeURIComponent(encounterId)}`, { end }), 'encounter');
}

/** 文を入れる。サーバーで、AI の選別と置き換えを通ったものだけが保存され、保存された形が返る。 */
export async function addSource(encounterId: string, input: NewSource): Promise<Result<{ source: Source; observations: readonly Observation[] }>> {
  const result = await call('POST', `encounters/${encodeURIComponent(encounterId)}/sources`, input);
  if (!result.ok) return result;
  const { source, observations } = result.value;
  return isRecord(source) && Array.isArray(observations) ? { ok: true, value: { source: source as unknown as Source, observations: observations as Observation[] } } : { ok: false, error: 'network' };
}

/** 文を整理する（段2）。保存した文を AI が整理し、確かめた行だけが入る。整理し直すときも、これ */
export async function organizeSource(sourceId: string): Promise<Result<Source>> {
  return field<Source>(await call('POST', `sources/${encodeURIComponent(sourceId)}/organize`, {}), 'source');
}

export async function deleteSource(sourceId: string): Promise<Result<null>> {
  const result = await call('DELETE', `sources/${encodeURIComponent(sourceId)}`);
  return result.ok ? { ok: true, value: null } : result;
}

// --- 選別の評価（架空の文だけを、サーバーの鍵・指示・モデルで AI に送り、漏れを数える）

export interface SelfCheckInfo {
  readonly cases: readonly { readonly id: string; readonly note: string; readonly planted: number }[];
  readonly promptVersion: string;
  readonly model: string;
  /** AI の鍵が置かれているか */
  readonly ready: boolean;
}

export interface SelfCheckResult {
  readonly id: string;
  readonly failed: string | null;
  readonly leaked: number;
  readonly lost: number;
  readonly exact: boolean | null;
  /** 混ぜた場所の外で、変わった部分（架空の文のひな形の字だけ） */
  readonly altered: readonly string[];
}

export async function getSelfCheck(): Promise<Result<SelfCheckInfo>> {
  const result = await call('GET', 'selfcheck');
  if (!result.ok) return result;
  const { cases, promptVersion, model, ready } = result.value;
  if (!Array.isArray(cases) || typeof promptVersion !== 'string' || typeof model !== 'string' || typeof ready !== 'boolean') return { ok: false, error: 'network' };
  return { ok: true, value: { cases: cases as SelfCheckInfo['cases'], promptVersion, model, ready } };
}

export async function runSelfCheck(id: string, seed: number): Promise<Result<SelfCheckResult>> {
  return field<SelfCheckResult>(await call('POST', 'selfcheck', { id, seed }), 'result');
}

// --- 問題の筋（段3a）

/** つないでいない問題の記載を、もう一度つなぐ（AI を使う） */
export async function linkProblems(patientId: string): Promise<Result<null>> {
  const result = await call('POST', `patients/${encodeURIComponent(patientId)}/problems/link`, {});
  return result.ok ? { ok: true, value: null } : result;
}

/** 記載を、別の筋へ移す（new：新しい筋に分ける）。expected は、いまの筋（違えば conflict） */
export async function moveProblem(problemId: string, thread: string, expected: string | null): Promise<Result<null>> {
  const result = await call('PATCH', `problems/${encodeURIComponent(problemId)}`, { thread, expected });
  return result.ok ? { ok: true, value: null } : result;
}

/** 筋を、別の筋へ統合する */
export async function mergeThread(threadId: string, into: string): Promise<Result<null>> {
  const result = await call('PATCH', `threads/${encodeURIComponent(threadId)}`, { mergeInto: into });
  return result.ok ? { ok: true, value: null } : result;
}

/** 筋の表示の名前を、書かれた名前から選ぶ（null：いちばん新しい記載の名前） */
export async function nameThread(threadId: string, displayName: string | null): Promise<Result<null>> {
  const result = await call('PATCH', `threads/${encodeURIComponent(threadId)}`, { displayName });
  return result.ok ? { ok: true, value: null } : result;
}

// --- 事実を直す（段3e）

export async function patchFact(fact: FactKind, id: string, patch: FactPatch): Promise<Result<null>> {
  const result = await call('PATCH', `facts/${fact}/${encodeURIComponent(id)}`, patch);
  return result.ok ? { ok: true, value: null } : result;
}

// --- 草案（段4。保存しない）

export interface DraftResult {
  readonly draft: CheckedDraft;
  /** 資料にした引用の数と、長さの上限で落とした数 */
  readonly quotes: number;
  readonly dropped: number;
}

export async function requestDraft(encounterId: string): Promise<Result<DraftResult>> {
  const result = await call('POST', `encounters/${encodeURIComponent(encounterId)}/draft`, {});
  if (!result.ok) return result;
  const { draft, quotes, dropped } = result.value;
  return isRecord(draft) && typeof quotes === 'number' && typeof dropped === 'number' ? { ok: true, value: { draft: draft as unknown as CheckedDraft, quotes, dropped } } : { ok: false, error: 'network' };
}

// --- 本人の調節（CA-029）

const done = (result: Result<Record<string, unknown>>): Result<null> => (result.ok ? { ok: true, value: null } : result);

/** 問題の筋を直す：確からしさ・状態・並び・外す・統合を解く・打った名前（打った名前はサーバーで選別を通す） */
export async function patchThread(threadId: string, patch: ThreadPatch): Promise<Result<null>> {
  return done(await call('PATCH', `threads/${encodeURIComponent(threadId)}`, patch));
}

/** 記載の種類・日時・書いた人を直す */
export async function patchSource(sourceId: string, patch: SourcePatch): Promise<Result<null>> {
  return done(await call('PATCH', `sources/${encodeURIComponent(sourceId)}`, patch));
}

/** 区切りの見出しを選び直す */
export async function patchSegment(segmentId: string, patch: SegmentPatch): Promise<Result<null>> {
  return done(await call('PATCH', `segments/${encodeURIComponent(segmentId)}`, patch));
}

/** 文をなぞって足す */
export async function addFact(sourceId: string, add: AddFact): Promise<Result<null>> {
  return done(await call('POST', `sources/${encodeURIComponent(sourceId)}/facts`, add));
}

/** 文を打ち直す（選別を通す）。引き継げなかった本人の直しの数が返る */
export async function retypeSource(sourceId: string, text: string): Promise<Result<{ lost: number }>> {
  const result = await call('PUT', `sources/${encodeURIComponent(sourceId)}/text`, { text });
  if (!result.ok) return result;
  const lost = result.value['lost'];
  return typeof lost === 'number' ? { ok: true, value: { lost } } : { ok: false, error: 'network' };
}

// --- 記載と A/P（段5。CA-030〜035）

/** A/P を残す（まとめて。文はサーバーで選別を通す） */
export async function addApNotes(encounterId: string, notes: readonly ApNoteNew[]): Promise<Result<null>> {
  return done(await call('POST', `encounters/${encodeURIComponent(encounterId)}/ap-notes`, { notes }));
}

/** A/P を直す（文は選別を通す。AI 案から採用したものは「AI 案を直した」になる）・方針の種類を選び直す */
export async function patchApNote(id: string, patch: ApNotePatch): Promise<Result<null>> {
  return done(await call('PATCH', `ap-notes/${encodeURIComponent(id)}`, patch));
}

export async function deleteApNote(id: string): Promise<Result<null>> {
  return done(await call('DELETE', `ap-notes/${encodeURIComponent(id)}`));
}

export interface RefCounts {
  /** 資料にした出典の数（記録・書籍・ネット） */
  readonly sources: number;
  readonly books: number;
  readonly web: number;
  /** ウェブ検索を頼んだが、できなかった */
  readonly webFailed: boolean;
}

function refCounts(value: Record<string, unknown>): RefCounts | null {
  const { sources, books, web, webFailed } = value;
  return typeof sources === 'number' && typeof books === 'number' && typeof web === 'number' && typeof webFailed === 'boolean' ? { sources, books, web, webFailed } : null;
}

/** AI の A/P の案（保存しない） */
export async function requestProposal(encounterId: string, body: { day: string; threadIds: readonly string[]; web: boolean }): Promise<Result<{ proposal: CheckedProposal } & RefCounts>> {
  const result = await call('POST', `encounters/${encodeURIComponent(encounterId)}/ap-proposal`, body);
  if (!result.ok) return result;
  const counts = refCounts(result.value);
  const proposal = result.value['proposal'];
  return counts !== null && isRecord(proposal) ? { ok: true, value: { proposal: proposal as unknown as CheckedProposal, ...counts } } : { ok: false, error: 'network' };
}

/** AI との議論（保存しない） */
export async function requestDiscussion(
  encounterId: string,
  body: { threadId: string; day: string; web: boolean; question: string; history: readonly { role: 'doctor' | 'ai'; text: string }[] },
): Promise<Result<{ discussion: CheckedDiscussion } & RefCounts>> {
  const result = await call('POST', `encounters/${encodeURIComponent(encounterId)}/discuss`, body);
  if (!result.ok) return result;
  const counts = refCounts(result.value);
  const discussion = result.value['discussion'];
  return counts !== null && isRecord(discussion) ? { ok: true, value: { discussion: discussion as unknown as CheckedDiscussion, ...counts } } : { ok: false, error: 'network' };
}
