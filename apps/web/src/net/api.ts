// サーバーの API を呼ぶ、ただ1つの場所（ESLint と試験が見張る）。宛先は、自分のオリジンの /api/ だけ。
// 印（Cookie）は、ブラウザが付ける。画面のプログラムからは読めない（HttpOnly）。
import type { AuthorRole, Comparator, DeviceKind, EncounterKind, NewEncounter, NewPatient, NewSource, PatientPatch, Sex, SourceKind } from '@clinical-carte/core';

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
  | 'selection_failed';

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
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Result<Record<string, unknown>>> {
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
}

export interface PatientSummary {
  readonly patient: Patient;
  readonly latest: Encounter | null;
  readonly sources: number;
}

export interface PatientRecord {
  readonly patient: Patient;
  readonly encounters: readonly Encounter[];
  readonly sources: readonly Source[];
  readonly observations: readonly Observation[];
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
  const { patient, encounters, sources, observations, today } = result.value;
  if (!isRecord(patient) || !Array.isArray(encounters) || !Array.isArray(sources) || !Array.isArray(observations) || typeof today !== 'string') return { ok: false, error: 'network' };
  return { ok: true, value: { patient: patient as unknown as Patient, encounters: encounters as Encounter[], sources: sources as Source[], observations: observations as Observation[], today } };
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
