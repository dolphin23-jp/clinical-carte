// 入口（CA-016・CA-019）：端末ごとに最初の1回、長い合鍵を入れる。以後は、サーバーが出した印（Cookie）で通る。
// ここは、決まりと、時計・乱数・暗号に触れない部分だけ（照合用の値の計算と保存は apps/worker）。

/** 端末の種類。自由な名前は持たない（打った文字を、入口の表に残さないため）。 */
export const DEVICE_KINDS = ['iphone', 'ipad', 'pc', 'other'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_KIND_LABELS: Readonly<Record<DeviceKind, string>> = {
  iphone: 'iPhone',
  ipad: 'iPad',
  pc: 'PC',
  other: 'その他',
};

export function isDeviceKind(value: unknown): value is DeviceKind {
  return typeof value === 'string' && (DEVICE_KINDS as readonly string[]).includes(value);
}

/** 合鍵の長さの下限（文字）。短い合鍵では動かさない。 */
export const MIN_KEY_LENGTH = 32;
/** 合鍵に要る、文字の種類の数（同じ字の繰り返しを合鍵にしない）。 */
export const MIN_KEY_DISTINCT = 12;
/** 入れる合鍵の長さの上限（文字）。これより長い入力は、照合せずに断る。 */
export const MAX_KEY_LENGTH = 512;
/** 登録できる端末の数。 */
export const MAX_DEVICES = 10;
/** 1日（日本の日）に許す、合鍵の間違いの数。超えたら、その日は登録を受け付けない（登録済みの端末は使える）。 */
export const MAX_FAILED_PER_DAY = 20;
/** 印（Cookie）の期限（秒）。400日（ブラウザが受け付ける上限に合わせた）。使った日に延びる。 */
export const TOKEN_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
/** 端末の秘密の長さ（バイト）。 */
export const DEVICE_SECRET_BYTES = 32;

export type KeyProblem = 'missing' | 'too_short' | 'too_simple';

/** サーバーに設定した合鍵が、使える形か。使えないときは、すべてを断る（鍵なしで動かさない。AGENTS.md の 1）。 */
export function keyProblem(key: string | undefined): KeyProblem | null {
  if (key === undefined || key.trim() === '') return 'missing';
  if (key.length < MIN_KEY_LENGTH) return 'too_short';
  if (new Set(key).size < MIN_KEY_DISTINCT) return 'too_simple';
  return null;
}

const HEX = /^[0-9a-f]+$/;
const ULID_SHAPE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 印の値：端末の id と、端末の秘密（16進）を「.」でつないだもの。 */
export function formatDeviceToken(deviceId: string, secretHex: string): string {
  if (!ULID_SHAPE.test(deviceId)) throw new RangeError('端末の id は ULID');
  if (secretHex.length !== DEVICE_SECRET_BYTES * 2 || !HEX.test(secretHex)) throw new RangeError('端末の秘密は 16進の 64 文字');
  return `${deviceId}.${secretHex}`;
}

export function parseDeviceToken(value: string | undefined | null): { deviceId: string; secretHex: string } | null {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const deviceId = value.slice(0, dot);
  const secretHex = value.slice(dot + 1);
  if (!ULID_SHAPE.test(deviceId)) return null;
  if (secretHex.length !== DEVICE_SECRET_BYTES * 2 || !HEX.test(secretHex)) return null;
  return { deviceId, secretHex };
}

/**
 * 2つの文字列が同じか。長さが同じなら、最後の字まで比べる（違いの位置で、かかる時間を変えない）。
 * 呼ぶ側は、同じ長さの値（ハッシュの 16進）を渡す。
 */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Cookie のヘッダから、名前の値を取り出す（同じ名前が2つあれば、使わない）。 */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (typeof header !== 'string' || header === '') return null;
  const found: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) found.push(part.slice(eq + 1).trim());
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}
