// サーバーの API を呼ぶ、ただ1つの場所（ESLint と試験が見張る）。宛先は、自分のオリジンの /api/ だけ。
// 印（Cookie）は、ブラウザが付ける。画面のプログラムからは読めない（HttpOnly）。
import type { DeviceKind } from '@clinical-carte/core';

export interface DeviceView {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly registeredOn: string;
  readonly lastUsedOn: string;
  readonly current: boolean;
}

/** サーバーが返す、誤りの名前。network は、つながらない・答えが読めない */
export type ApiError = 'network' | 'no_key' | 'unregistered' | 'wrong_key' | 'locked' | 'too_many_devices' | 'not_found' | 'server';

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError; readonly left?: number };

const KNOWN: readonly ApiError[] = ['no_key', 'unregistered', 'wrong_key', 'locked', 'too_many_devices', 'not_found', 'server'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Result<Record<string, unknown>>> {
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
