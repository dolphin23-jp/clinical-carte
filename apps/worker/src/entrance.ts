// 入口（CA-016・CA-019。docs/03 の 2）：端末の登録を1回だけ。以後は、印（Cookie）で通る。
// 保存するのは、端末の id・種類・照合用の値・日（docs/04 の 3.8）。合鍵・端末の秘密そのものは、保存もログもしない。
import {
  type DeviceKind,
  DEVICE_SECRET_BYTES,
  formatDeviceToken,
  isDeviceKind,
  japanDay,
  MAX_DEVICES,
  MAX_FAILED_PER_DAY,
  parseDeviceToken,
  readCookie,
  sameText,
  toHex,
  TOKEN_MAX_AGE_SECONDS,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';

import { type Db, int, text } from './db.ts';
import type { Runtime } from './runtime.ts';

export interface EntranceDeps {
  readonly db: Db;
  /** サーバーに設定した合鍵（秘密）。形の確かめは handler.ts（使えなければ、すべてを断る） */
  readonly key: string;
  readonly runtime: Runtime;
  /** 本番は true。印に Secure と __Host- を付ける。手元の http のサーバー（試験）だけ false */
  readonly secureCookies: boolean;
}

export interface Device {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly registeredOn: string;
  readonly lastUsedOn: string;
}

export function cookieName(secure: boolean): string {
  return secure ? '__Host-carte' : 'carte';
}

/** 印を置く・延ばす Set-Cookie。画面のプログラムからは読めない（HttpOnly）。ほかのサイトからの要求には付かない（SameSite=Strict）。 */
export function tokenCookie(token: string, secure: boolean): string {
  return `${cookieName(secure)}=${token}; Path=/; Max-Age=${String(TOKEN_MAX_AGE_SECONDS)}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearCookie(secure: boolean): string {
  return `${cookieName(secure)}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function toDevice(row: Record<string, unknown>): Device | null {
  const id = text(row, 'id');
  const kind = text(row, 'kind');
  const registeredOn = text(row, 'registered_on');
  const lastUsedOn = text(row, 'last_used_on');
  if (id === null || !isDeviceKind(kind) || registeredOn === null || lastUsedOn === null) return null;
  return { id, kind, registeredOn, lastUsedOn };
}

export interface Entered {
  readonly device: Device;
  /** 今日はじめて使ったとき：期限を延ばした印（Set-Cookie の値）。それ以外は null */
  readonly renew: string | null;
}

/** 要求の印が、登録した端末のものか。違えば null（理由は返さない）。 */
export async function enter(cookieHeader: string | null, deps: EntranceDeps): Promise<Entered | null> {
  const raw = readCookie(cookieHeader, cookieName(deps.secureCookies));
  const token = parseDeviceToken(raw);
  if (token === null) return null;
  const row = await deps.db.prepare('SELECT id, kind, secret_hash, registered_on, last_used_on FROM devices WHERE id = ?').bind(token.deviceId).first();
  const stored = text(row, 'secret_hash');
  // 端末が見つからないときも、ハッシュの計算と比べをする（見つかる・見つからないで、かかる時間を大きく変えない）
  const given = await deps.runtime.sha256Hex(token.secretHex);
  if (row === null || stored === null || !sameText(given, stored)) return null;
  const device = toDevice(row);
  if (device === null) return null;
  const today = japanDay(deps.runtime.now());
  if (device.lastUsedOn === today) return { device, renew: null };
  // 使った日を書くのは、1日に1回（書き込みを増やさない）。同じときに、印の期限を延ばす
  await deps.db.prepare('UPDATE devices SET last_used_on = ? WHERE id = ?').bind(today, device.id).run();
  return { device: { ...device, lastUsedOn: today }, renew: tokenCookie(formatDeviceToken(token.deviceId, token.secretHex), deps.secureCookies) };
}

export type RegisterResult =
  | { readonly ok: true; readonly device: Device; readonly setCookie: string }
  | { readonly ok: false; readonly reason: 'locked' | 'too_many_devices' }
  | { readonly ok: false; readonly reason: 'wrong_key'; readonly left: number };

async function failedToday(db: Db, day: string): Promise<number> {
  return int(await db.prepare('SELECT failed FROM entrance_daily WHERE day = ?').bind(day).first(), 'failed') ?? 0;
}

/**
 * 端末を登録する。合鍵が合えば、端末の id と秘密を作り、照合用の値だけを保存して、印を返す。
 * 合鍵の間違いは、日ごとに数える（日付と整数だけ）。上限を超えた日は、合っていても受け付けない。
 * replace：この要求が、登録済みの端末の印を持っていたとき、その端末（同じ端末の古い登録）を外してから足す。
 */
export async function register(input: { key: string; kind: DeviceKind; replace: string | null }, deps: EntranceDeps): Promise<RegisterResult> {
  const { db, runtime } = deps;
  const nowMs = runtime.now();
  const today = japanDay(nowMs);
  const failed = await failedToday(db, today);
  if (failed >= MAX_FAILED_PER_DAY) return { ok: false, reason: 'locked' };

  // 合鍵そのものではなく、ハッシュどうしを比べる（長さが同じになり、違いの位置で時間が変わらない）
  const [given, expected] = await Promise.all([runtime.sha256Hex(input.key), runtime.sha256Hex(deps.key)]);
  if (!sameText(given, expected)) {
    await db.prepare('INSERT INTO entrance_daily (day, failed) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET failed = failed + 1').bind(today).run();
    return { ok: false, reason: 'wrong_key', left: Math.max(0, MAX_FAILED_PER_DAY - failed - 1) };
  }

  if (input.replace !== null) await db.prepare('DELETE FROM devices WHERE id = ?').bind(input.replace).run();
  const count = int(await db.prepare('SELECT COUNT(*) AS n FROM devices').first(), 'n') ?? 0;
  if (count >= MAX_DEVICES) return { ok: false, reason: 'too_many_devices' };

  const id = ulid(nowMs, runtime.randomBytes(ULID_RANDOM_BYTES));
  const secretHex = toHex(runtime.randomBytes(DEVICE_SECRET_BYTES));
  await db
    .prepare('INSERT INTO devices (id, kind, secret_hash, registered_on, last_used_on) VALUES (?, ?, ?, ?, ?)')
    .bind(id, input.kind, await runtime.sha256Hex(secretHex), today, today)
    .run();
  return {
    ok: true,
    device: { id, kind: input.kind, registeredOn: today, lastUsedOn: today },
    setCookie: tokenCookie(formatDeviceToken(id, secretHex), deps.secureCookies),
  };
}

export async function listDevices(db: Db): Promise<Device[]> {
  const { results } = await db.prepare('SELECT id, kind, registered_on, last_used_on FROM devices ORDER BY id').all();
  return results.map(toDevice).filter((d): d is Device => d !== null);
}

/** 端末を外す。外した数（0 か 1）を返す。 */
export async function removeDevice(db: Db, id: string): Promise<number> {
  const result = await db.prepare('DELETE FROM devices WHERE id = ?').bind(id).run();
  return result.meta?.changes ?? 0;
}
