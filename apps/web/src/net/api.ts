// サーバーの API を呼ぶ、ただ1つの場所（ESLint と試験が見張る）。宛先は、自分のオリジンの /api/ だけ。
// 印（Cookie）は、ブラウザが付ける。画面のプログラムからは読めない（HttpOnly）。
import type {
  SearchHit,
  SearchPatient,
  SearchEncounter,
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
  ApNoteNew,
  ApNotePatch,
  ApOrigin,
  ApPart,
  ApRef,
  Backing,
  CheckedDocument,
  CourseCategory,
  ListItem,
  ListPatch,
  DocType,
  HandoffSeverity,
  SavedDocument,
  SavedHandoff,
  SavedSection,
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
  SupportBody,
  AskReply,
  ConsultEvent,
  ConsultNote,
  ConsultNoteNew,
  ConsultReply,
  ConsultRequest,
  ConsultStage,
  ConsultStatement,
  PendingBody,
  PendingMark,
  PlanBody,
  PlanMark,
  CasebookLink,
  CasebookPatch,
  OrderCategory,
  OrderFields,
  OrderItem,
  OrderNew,
  OrderProposal,
  ScaleTemplate,
  ScaleTemplateBody,
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
  | 'document_empty'
  | 'list_empty'
  | 'support_empty'
  | 'ask_empty'
  | 'consult_empty'
  | 'orders_empty'
  | 'shape'
  | 'bad_span'
  | 'too_long';

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError; readonly left?: number };

const KNOWN: readonly ApiError[] = [
  'too_long',
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
  'document_empty',
  'list_empty',
  'support_empty',
  'ask_empty',
  'consult_empty',
  'orders_empty',
  'shape',
  'bad_span',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<Result<Record<string, unknown>>> {
  let response: Response;
  let data: unknown;
  // 待つ時間の上限（文を入れるときだけ。段K9）：電波の弱いところで、答えが戻らないまま待ち続けない。過ぎたら、つながらないのと同じ扱い（送り待ちになる）
  const controller = timeoutMs === undefined ? null : new AbortController();
  const timer = controller === null ? null : setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const init: RequestInit = { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
    if (controller !== null) init.signal = controller.signal;
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    response = await fetch(`/api/${path}`, init);
    data = await response.json();
  } catch {
    return { ok: false, error: 'network' };
  } finally {
    if (timer !== null) clearTimeout(timer);
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
  /** 日をまたいだ場所（CA-047）。ここより後ろの、日の書かれていない時刻は翌日として読む。なければ null */
  readonly nextDayFrom: number | null;
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
  /** 日時がおおよそのときの印（CA-056） */
  readonly atApprox?: string | null;
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
  readonly atApprox?: string | null;
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
export interface ProblemListView {
  readonly madeAt: string;
  readonly promptVersion: string;
  readonly basis: string;
  readonly items: readonly ListItem[];
}

/** AI の臨床支援（段K5。CA-064） */
export interface SupportView {
  readonly madeAt: string;
  readonly promptVersion: string;
  readonly basis: string;
  readonly body: SupportBody;
}

/** Casebook へ送る印（段K10。CA-073） */
export interface CasebookLinkView extends CasebookLink {
  readonly encounterId: string;
}

/** 結果待ち（段K6。CA-065） */
export interface PendingView {
  readonly madeAt: string;
  readonly promptVersion: string;
  readonly basis: string;
  readonly body: PendingBody;
}

/** 予定と実施（段K9。CA-071） */
export interface PlanView {
  readonly madeAt: string;
  readonly promptVersion: string;
  readonly basis: string;
  readonly body: PlanBody;
}

export interface PatientSummary {
  readonly patient: Patient;
  readonly latest: Encounter | null;
  readonly sources: number;
  /** 回診リストの材料（段3d） */
  readonly round: RoundSummary;
  /** いちばん新しい受診の、いちばん新しい申し送り（段K7）の日と、先生が選んだ重症度だけ（なければ null） */
  readonly handoff: { readonly id: string; readonly day: string; readonly severity: HandoffSeverity } | null;
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
  /** 単位の「同じ目盛り」（CA-051。全患者に共通） */
  readonly scaleLinks: readonly ScaleLinkView[];
  /** 残したカルテ記載（段I。CA-054） */
  readonly documents: readonly SavedDocument[];
  /** 残した申し送り（段K7。CA-067。新しい順） */
  readonly handoffs: readonly SavedHandoff[];
  /** 経過の出来事（CA-056） */
  readonly course: readonly CourseItem[];
  /** AI のプロブレムリスト（CA-057。まだなければ null） */
  readonly problemList: ProblemListView | null;
  /** AI の臨床支援（段K5。まだなければ null） */
  readonly support: SupportView | null;
  /** 結果待ち（段K6。まだなければ null） */
  readonly pending: PendingView | null;
  /** 予定と実施（段K9。まだなければ null） */
  readonly plans: PlanView | null;
  /** Casebook へ送る印（段K10。受診ごと。種・症例コード・取り込んだ項目の印だけ） */
  readonly casebook: readonly CasebookLinkView[];
  /** 指示簿（段K11。受診ごとに1つ） */
  readonly orders: readonly OrderSheetView[];
  /** スケールのテンプレ（段K11。全患者に共通） */
  readonly orderTemplates: readonly ScaleTemplate[];
  /** 相談の窓口で、先生が残した答え（段M。CA-081。新しい順） */
  readonly consultNotes: readonly ConsultNote[];
  /** サーバーの、今日（日本の日） */
  readonly today: string;
}

export interface OrderSheetView {
  readonly encounterId: string;
  readonly items: readonly OrderItem[];
  readonly updatedAt: string;
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
  const { patient, encounters, sources, observations, segments, medications, events, problems, problemThreads, history, factEdits, userEdits, apNotes, scaleLinks, documents, handoffs, course, problemList, support, pending, plans, casebook, orders, orderTemplates, consultNotes, today } = result.value;
  const lists = [encounters, sources, observations, segments, medications, events, problems, problemThreads, history, factEdits, userEdits, apNotes, scaleLinks, documents, handoffs, course];
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
      scaleLinks: scaleLinks as ScaleLinkView[],
      documents: documents as SavedDocument[],
      handoffs: handoffs as SavedHandoff[],
      course: course as CourseItem[],
      problemList: isRecord(problemList) ? (problemList as unknown as ProblemListView) : null,
      support: isRecord(support) && isRecord(support['body']) ? (support as unknown as SupportView) : null,
      pending: isRecord(pending) && isRecord(pending['body']) ? (pending as unknown as PendingView) : null,
      plans: isRecord(plans) && isRecord(plans['body']) ? (plans as unknown as PlanView) : null,
      casebook: Array.isArray(casebook) ? (casebook as CasebookLinkView[]) : [],
      orders: Array.isArray(orders) ? (orders as OrderSheetView[]) : [],
      orderTemplates: Array.isArray(orderTemplates) ? (orderTemplates as ScaleTemplate[]) : [],
      consultNotes: Array.isArray(consultNotes) ? (consultNotes as ConsultNote[]) : [],
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

/** 受診の種類を変える（救急・外来 → 入院 など）。開始・終わりの日時は、そのまま */
export async function setEncounterKind(encounterId: string, kind: EncounterKind): Promise<Result<Encounter>> {
  return field<Encounter>(await call('PATCH', `encounters/${encodeURIComponent(encounterId)}`, { kind }), 'encounter');
}

export async function setEncounterEnd(encounterId: string, end: string | null): Promise<Result<Encounter>> {
  return field<Encounter>(await call('PATCH', `encounters/${encodeURIComponent(encounterId)}`, { end }), 'encounter');
}

/** 文を入れるときに待つ時間の上限（ミリ秒。サーバーの選別は、AI の待ちを含めて長くかかることがあるので長め）。過ぎたら、つながらない扱い（段K9） */
export const ADD_SOURCE_TIMEOUT_MS = 120_000;

/** 文を入れる。サーバーで、AI の選別と置き換えを通ったものだけが保存され、保存された形が返る。
 *  送る鍵（sendKey）があれば、送り直しても、サーバーは同じ文を二重に保存しない（段K9） */
export async function addSource(encounterId: string, input: NewSource): Promise<Result<{ source: Source; observations: readonly Observation[] }>> {
  const result = await call('POST', `encounters/${encodeURIComponent(encounterId)}/sources`, input, ADD_SOURCE_TIMEOUT_MS);
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

// --- 整理の評価（架空の文だけを、いまの版か前の版の指示で整理し、記録に入る行を決まりで数える）

export type OrganizePrompt = 'current' | 'previous';

export interface OrganizeCheckInfo {
  readonly cases: readonly { readonly id: string; readonly note: string; readonly rules: readonly { readonly id: string; readonly label: string }[] }[];
  readonly versions: Readonly<Record<OrganizePrompt, string>>;
  readonly model: string;
  readonly ready: boolean;
}

export interface OrganizeCheckResult {
  readonly id: string;
  readonly failed: string | null;
  /** 決まりを超えた（拾いすぎ）決まりの id */
  readonly extra: readonly string[];
  /** 足りない（拾い漏れ）決まりの id */
  readonly missing: readonly string[];
  readonly counts: { readonly problems: number; readonly medications: number; readonly events: number; readonly measurements: number } | null;
  readonly unverified: number;
}

export async function getOrganizeCheck(): Promise<Result<OrganizeCheckInfo>> {
  const result = await call('GET', 'selfcheck/organize');
  if (!result.ok) return result;
  const { cases, versions, model, ready } = result.value;
  if (!Array.isArray(cases) || typeof versions !== 'object' || versions === null || typeof model !== 'string' || typeof ready !== 'boolean') return { ok: false, error: 'network' };
  return { ok: true, value: { cases: cases as OrganizeCheckInfo['cases'], versions: versions as OrganizeCheckInfo['versions'], model, ready } };
}

export async function runOrganizeCheck(id: string, prompt: OrganizePrompt): Promise<Result<OrganizeCheckResult>> {
  return field<OrganizeCheckResult>(await call('POST', 'selfcheck/organize', { id, prompt }), 'result');
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

/** 続きを足す（CA-050。足す文だけを選別に通し、記載の末尾に足す） */
export async function appendSource(sourceId: string, text: string, nextDay?: boolean): Promise<Result<null>> {
  return done(await call('POST', `sources/${encodeURIComponent(sourceId)}/append`, nextDay === undefined ? { text } : { text, nextDay }));
}

/** 文を打ち直す（選別を通す）。引き継げなかった本人の直しの数が返る */
export async function retypeSource(sourceId: string, text: string, nextDay?: boolean): Promise<Result<{ lost: number }>> {
  const result = await call('PUT', `sources/${encodeURIComponent(sourceId)}/text`, nextDay === undefined ? { text } : { text, nextDay });
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

export interface ScaleLinkView {
  readonly id: string;
  readonly name: string;
  readonly unitA: string;
  readonly unitB: string;
  readonly createdAt: string;
}

/** 単位の「同じ目盛り」を決める（CA-051。全患者に共通。'' は単位の記載なし） */
export async function addScaleLink(link: { name: string; unitA: string; unitB: string }): Promise<Result<null>> {
  return done(await call('POST', 'scale-links', link));
}

/** 単位の「同じ目盛り」を外す */
export async function removeScaleLink(id: string): Promise<Result<null>> {
  return done(await call('DELETE', `scale-links/${encodeURIComponent(id)}`));
}

export async function deleteApNote(id: string): Promise<Result<null>> {
  return done(await call('DELETE', `ap-notes/${encodeURIComponent(id)}`));
}

// --- カルテ記載（段I。CA-054）

/** 出典の題（書籍・ネット。抜き出しの字は返らない） */
export interface RefLabel {
  readonly id: string;
  readonly kind: 'book' | 'web';
  readonly label: string;
}

export interface DocumentReply {
  readonly document: CheckedDocument;
  readonly backing: Backing;
  readonly refs: readonly RefLabel[];
  readonly material: { readonly records: number; readonly shortened: number; readonly dropped: number };
  readonly webFailed: boolean;
}

function documentReply(value: Record<string, unknown>): DocumentReply | null {
  const { document, backing, refs, material, webFailed } = value;
  return isRecord(document) && isRecord(backing) && Array.isArray(refs) && isRecord(material) && typeof webFailed === 'boolean'
    ? { document: document as unknown as CheckedDocument, backing: backing as unknown as Backing, refs: refs as RefLabel[], material: material as unknown as DocumentReply['material'], webFailed }
    : null;
}

/** カルテ記載を出す（保存しない） */
export async function generateDocument(encounterId: string, body: { type: DocType; day: string; web: boolean }): Promise<Result<DocumentReply>> {
  const result = await call('POST', `encounters/${encodeURIComponent(encounterId)}/documents/generate`, body);
  if (!result.ok) return result;
  const reply = documentReply(result.value);
  return reply === null ? { ok: false, error: 'network' } : { ok: true, value: reply };
}

/** カルテ記載を、AI と相談して直す（保存しない。やりとりも保存しない） */
export async function reviseDocument(
  encounterId: string,
  body: { type: DocType; day: string; web: boolean; sections: readonly { key: string; text: string }[]; instruction: string; history: readonly { role: 'doctor' | 'ai'; text: string }[] },
): Promise<Result<DocumentReply & { reply: string }>> {
  const result = await call('POST', `encounters/${encodeURIComponent(encounterId)}/documents/revise`, body);
  if (!result.ok) return result;
  const reply = documentReply(result.value);
  const text = result.value['reply'];
  return reply === null || typeof text !== 'string' ? { ok: false, error: 'network' } : { ok: true, value: { ...reply, reply: text } };
}

/** 数の印の照らし合わせの表（AI を使わない。残した記載を開いたとき） */
export async function documentBacking(encounterId: string, body: { type: DocType; day: string }): Promise<Result<Backing>> {
  return field<Backing>(await call('POST', `encounters/${encodeURIComponent(encounterId)}/documents/backing`, body), 'backing');
}

/** カルテ記載を残す（文はサーバーで選別を通す） */
export async function saveDocument(encounterId: string, body: { type: DocType; day: string; sections: readonly SavedSection[]; origin: 'ai' | 'self'; edited: boolean }): Promise<Result<string>> {
  return field<string>(await call('POST', `encounters/${encodeURIComponent(encounterId)}/documents`, body), 'id');
}

/** 残した記載を直す（選別を通す） */
export async function patchDocument(id: string, sections: readonly SavedSection[]): Promise<Result<null>> {
  return done(await call('PATCH', `documents/${encodeURIComponent(id)}`, { sections }));
}

export async function deleteDocument(id: string): Promise<Result<null>> {
  return done(await call('DELETE', `documents/${encodeURIComponent(id)}`));
}

/** 申し送りを残す（段K7。重症度は先生が選んだもの。文はサーバーで選別を通す） */
export async function saveHandoff(encounterId: string, body: { day: string; severity: HandoffSeverity; sections: readonly SavedSection[]; origin: 'ai' | 'self'; edited: boolean }): Promise<Result<string>> {
  return field<string>(await call('POST', `encounters/${encodeURIComponent(encounterId)}/handoffs`, body), 'id');
}

/** 残した申し送りを直す（重症度の選び直しも。選別を通す） */
export async function patchHandoff(id: string, body: { severity: HandoffSeverity; sections: readonly SavedSection[] }): Promise<Result<null>> {
  return done(await call('PATCH', `handoffs/${encodeURIComponent(id)}`, body));
}

export async function deleteHandoff(id: string): Promise<Result<null>> {
  return done(await call('DELETE', `handoffs/${encodeURIComponent(id)}`));
}

/** 受け持ち全員の申し送り（段K7）：患者ごとに、いちばん新しい受診の、いちばん新しい残した申し送り（読むだけ） */
export async function listHandoffs(): Promise<Result<readonly { readonly patientId: string; readonly handoff: SavedHandoff }[]>> {
  const result = await call('GET', 'handoffs');
  if (!result.ok) return result;
  const list = result.value['handoffs'];
  return Array.isArray(list) ? { ok: true, value: list as { patientId: string; handoff: SavedHandoff }[] } : { ok: false, error: 'network' };
}

/** 書籍の参照元（clinical-RAG）のつながり：設定なし・つながっている・鍵が違う・つながらない */
export type BookStatus = 'off' | 'ok' | 'unauthorized' | 'unavailable';

export async function getReferences(): Promise<Result<BookStatus>> {
  const result = await call('GET', 'references');
  if (!result.ok) return result;
  const books = result.value['books'];
  return books === 'off' || books === 'ok' || books === 'unauthorized' || books === 'unavailable' ? { ok: true, value: books } : { ok: false, error: 'network' };
}

// --- AI のプロブレムリスト（CA-057）

/** 記録全体から、AI がリストを組み直す（先生の直しは引き継ぐ） */
export async function generateProblemList(patientId: string): Promise<Result<{ rejected: Record<string, number> }>> {
  const result = await call('POST', `patients/${encodeURIComponent(patientId)}/problem-list`, {});
  if (!result.ok) return result;
  const rejected = result.value['rejected'];
  return { ok: true, value: { rejected: isRecord(rejected) ? (rejected as Record<string, number>) : {} } };
}

/** 先生の直し（名前はサーバーで選別を通す） */
export async function patchProblemList(patientId: string, patch: ListPatch): Promise<Result<null>> {
  return done(await call('PATCH', `patients/${encodeURIComponent(patientId)}/problem-list`, patch));
}

// --- AI の臨床支援（段K5。CA-064）

/** 記録から、AI が臨床支援を組み直す（ネットの出典も探すかを選ぶ。書籍は設定があるとき、いつも） */
export async function generateSupport(patientId: string, web: boolean): Promise<Result<null>> {
  return done(await call('POST', `patients/${encodeURIComponent(patientId)}/support`, { web }));
}

// --- 結果待ち（段K6。CA-065）

/** 記録から、結果待ちの一覧を組み直す（AI の 1 回。提出の候補がなければ、AI を呼ばずに空の一覧） */
export async function generatePending(patientId: string): Promise<Result<null>> {
  return done(await call('POST', `patients/${encodeURIComponent(patientId)}/pending`, {}));
}

/** 先生の印（結果を確かめた・外す・戻す）。ボタンだけ */
export async function markPending(patientId: string, key: string, mark: PendingMark): Promise<Result<null>> {
  return done(await call('PATCH', `patients/${encodeURIComponent(patientId)}/pending`, { key, mark }));
}

// --- 予定と実施（段K9。CA-071）

/** 記録から、予定と実施の一覧を組み直す（AI の 1 回。予定の行がなければ、AI を呼ばずに空の一覧） */
export async function generatePlans(patientId: string): Promise<Result<null>> {
  return done(await call('POST', `patients/${encodeURIComponent(patientId)}/plans`, {}));
}

/** 先生の印（実施を確かめた・中止・不要・外す・戻す）。ボタンだけ */
export async function markPlan(patientId: string, key: string, mark: PlanMark): Promise<Result<null>> {
  return done(await call('PATCH', `patients/${encodeURIComponent(patientId)}/plans`, { key, mark }));
}

// --- 記録への質問（段K6。CA-066）

/** 記録に聞く（保存しない。問いも答えも、画面のメモリだけ） */
export async function askRecord(patientId: string, question: string): Promise<Result<AskReply>> {
  return field<AskReply>(await call('POST', `patients/${encodeURIComponent(patientId)}/ask`, { question }), 'answer');
}

// --- 相談の窓口（段M。CA-081）

/** 待つ時間の上限：検索の語・ネットの出典・答えの3回を待つ */
export const CONSULT_TIMEOUT_MS = 420_000;

/**
 * 相談する（保存しない。問い・前のやりとり・答えは、画面のメモリだけ）。書籍・ネットの検索に渡るのは、問題の名前と、問いの一般的な語だけ。
 * 答えは、少しずつ受け取る（CA-085）：いま何をしているか（onStage）と、サーバーが確かめた後の文（onStatement。書かれた順）。
 * 最後の答え（見出しの順に並べ直したもの）が、戻り値。確かめる前の字は、サーバーから届かない
 */
export async function consultPatient(
  patientId: string,
  request: Omit<ConsultRequest, 'stream'>,
  on: { readonly onStage: (stage: ConsultStage) => void; readonly onStatement: (statement: ConsultStatement) => void },
): Promise<Result<ConsultReply>> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, CONSULT_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/patients/${encodeURIComponent(patientId)}/consult`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    });
    const known = (name: unknown): ApiError => KNOWN.find((k) => k === name) ?? 'server';
    if (!response.ok || response.body === null) {
      const data: unknown = await response.json().catch(() => null);
      return { ok: false, error: isRecord(data) ? known(data['error']) : 'server' };
    }
    // 1行に1つの JSON（届いた順に読む。行の途中で切れた分は、次の分とつなぐ）
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rest = '';
    const got: { result: Result<ConsultReply> | null } = { result: null };
    const take = (line: string): void => {
      if (line.trim() === '') return;
      const event = JSON.parse(line) as ConsultEvent;
      if ('stage' in event) on.onStage(event.stage);
      else if ('statement' in event) on.onStatement(event.statement);
      else if ('done' in event) got.result = { ok: true, value: event.done };
      else got.result = { ok: false, error: known(event.error) };
    };
    for (;;) {
      const { done, value } = await reader.read();
      rest += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) take(line);
      if (done) break;
    }
    take(rest);
    return got.result ?? { ok: false, error: 'network' };
  } catch {
    return { ok: false, error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** 答えを残す（先生が「残す」を押したものだけ。サーバーで選別を通す。問いの文は送らない） */
export async function addConsultNote(patientId: string, note: ConsultNoteNew): Promise<Result<null>> {
  return done(await call('POST', `patients/${encodeURIComponent(patientId)}/consult-notes`, note));
}

/** 残した答えを直す（CA-083。サーバーで選別を通す。「先生が直した」の印が付く） */
export async function patchConsultNote(id: string, text: string): Promise<Result<null>> {
  return done(await call('PATCH', `consult-notes/${encodeURIComponent(id)}`, { text }));
}

export async function deleteConsultNote(id: string): Promise<Result<null>> {
  return done(await call('DELETE', `consult-notes/${encodeURIComponent(id)}`));
}

/** 受け持ちを横断する検索（段K8。CA-070）の答え。保存しない（画面のメモリだけ） */
export interface SearchReply {
  readonly total: number;
  readonly shown: number;
  readonly patients: readonly { readonly patientId: string; readonly headline: string; readonly patient: SearchPatient; readonly encounter: SearchEncounter | null; readonly total: number; readonly hits: readonly SearchHit[] }[];
}

/** 受け持ちから探す（AI を使わない）。問いは本文で送る（道の字に載せない）。サーバーは保存しない */
export async function searchAll(q: string): Promise<Result<SearchReply>> {
  const result = await call('POST', 'search', { q });
  if (!result.ok) return result;
  const { total, shown, patients } = result.value;
  return typeof total === 'number' && typeof shown === 'number' && Array.isArray(patients) ? { ok: true, value: { total, shown, patients: patients as SearchReply['patients'] } } : { ok: false, error: 'network' };
}

/** Casebook へ送る印を用意する（段K10。なければ新しい種で作る。Casebook へは何も送らない） */
export async function ensureCasebookLink(encounterId: string): Promise<Result<CasebookLinkView>> {
  return field<CasebookLinkView>(await call('POST', `encounters/${encodeURIComponent(encounterId)}/casebook`, {}), 'casebook');
}

/** 症例コード・Casebook が取り込んだ項目の印・最初からやり直す（段K10） */
export async function patchCasebookLink(encounterId: string, patch: CasebookPatch): Promise<Result<CasebookLinkView>> {
  return field<CasebookLinkView>(await call('PATCH', `encounters/${encodeURIComponent(encounterId)}/casebook`, patch), 'casebook');
}

// --- 指示簿（段K11。CA-074〜CA-079）。病院のカルテへ戻す向き（コピー）はない

/** 写す・案を出すの答え（保存しない。画面のメモリだけ） */
export interface OrderProposals {
  readonly proposals: readonly OrderProposal[];
  readonly counts: { readonly notOrder: number; readonly cleared: number; readonly shapes: number; readonly rejected: Readonly<Record<string, number>> };
}

function proposalsOf(result: Result<Record<string, unknown>>): Result<OrderProposals> {
  if (!result.ok) return result;
  const { proposals, counts } = result.value;
  return Array.isArray(proposals) && isRecord(counts) ? { ok: true, value: { proposals: proposals as OrderProposal[], counts: counts as unknown as OrderProposals['counts'] } } : { ok: false, error: 'network' };
}

/** 記録の文から写す（AI の 1 回。保存しない） */
export async function transcribeOrders(encounterId: string, sourceId: string): Promise<Result<OrderProposals>> {
  return proposalsOf(await call('POST', `encounters/${encodeURIComponent(encounterId)}/orders/transcribe`, { sourceId }));
}

/** AI の案を出す（AI の 1 回。保存しない）。categories が空なら、すべての欄 */
export async function proposeOrders(encounterId: string, categories: readonly OrderCategory[]): Promise<Result<OrderProposals>> {
  return proposalsOf(await call('POST', `encounters/${encodeURIComponent(encounterId)}/orders/propose`, { categories }));
}

/** 指示簿に足す（先生が打った字・AI の案の字は、サーバーで選別を通す） */
export async function addOrders(encounterId: string, items: readonly OrderNew[]): Promise<Result<null>> {
  return done(await call('POST', `encounters/${encodeURIComponent(encounterId)}/orders`, { items }));
}

/** 欄を直す・中止／再開・スケールの体重と段 */
export async function patchOrder(encounterId: string, itemId: string, patch: { fields: OrderFields } | { status: 'active' | 'stopped' } | { weightKg: number | null; step: number | null }): Promise<Result<null>> {
  return done(await call('PATCH', `encounters/${encodeURIComponent(encounterId)}/orders/${encodeURIComponent(itemId)}`, patch));
}

export async function deleteOrder(encounterId: string, itemId: string): Promise<Result<null>> {
  return done(await call('DELETE', `encounters/${encodeURIComponent(encounterId)}/orders/${encodeURIComponent(itemId)}`));
}

/** スケールのテンプレ（全患者に共通。患者の情報を書かない） */
export async function addTemplate(body: ScaleTemplateBody): Promise<Result<null>> {
  return done(await call('POST', 'order-templates', body));
}

export async function patchTemplate(id: string, body: ScaleTemplateBody): Promise<Result<null>> {
  return done(await call('PATCH', `order-templates/${encodeURIComponent(id)}`, body));
}

export async function removeTemplate(id: string): Promise<Result<null>> {
  return done(await call('DELETE', `order-templates/${encodeURIComponent(id)}`));
}
