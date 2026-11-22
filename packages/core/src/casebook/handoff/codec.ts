// 受け渡しパケットの文字列の形（docs/contracts/handoff-packet.md の 2）：`CBH1:` ＋ base64url（UTF-8 の JSON）＋ `.` ＋ CRC-32（16進8桁）。
// core は DOM と Node の型を使えない（TextEncoder、btoa、Buffer がない）ので、UTF-8 と base64url と CRC は、ここで純関数として書く。
// CRC は、貼り付けの途中切れや文字の取り違えを見つけるためのもの（改ざんの防止ではない。パケットは匿名化済みの平文）。

export const PACKET_PREFIX = 'CBH1:';

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

// 不正な UTF-8 は null（置き換え文字で黙って直さない）
export function utf8Decode(bytes: Uint8Array): string | null {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] ?? 0;
    let cp: number;
    let extra: number;
    let min: number;
    if (b < 0x80) { cp = b; extra = 0; min = 0; }
    else if (b >= 0xc2 && b < 0xe0) { cp = b & 0x1f; extra = 1; min = 0x80; }
    else if (b >= 0xe0 && b < 0xf0) { cp = b & 0x0f; extra = 2; min = 0x800; }
    else if (b >= 0xf0 && b < 0xf5) { cp = b & 0x07; extra = 3; min = 0x10000; }
    else return null;
    for (let k = 1; k <= extra; k += 1) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    i += extra + 1;
  }
  return out;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; // phi-guard: allow base64url の文字表

export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63);
    if (i + 1 < bytes.length) out += B64URL.charAt((n >> 6) & 63);
    if (i + 2 < bytes.length) out += B64URL.charAt(n & 63);
  }
  return out;
}

// 文字が違う・長さが余る（4n+1）ときは null
export function base64urlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64URL.indexOf(ch);
    if (v < 0) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

// CRC-32（IEEE 802.3）。文字列の UTF-8 のバイト列にかける
let table: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (table === null) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = (table[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const crcHex = (bytes: Uint8Array): string => crc32(bytes).toString(16).padStart(8, '0');

// 本文（JSON の文字列）→ 先頭の印（prefix）つきの文字列。パケット（CBH1:）とスナップショット（CBS1:。T049）が同じ符号化を使う
export function wrapWith(prefix: string, json: string): string {
  const body = base64urlEncode(utf8Encode(json));
  return `${prefix}${body}.${crcHex(utf8Encode(body))}`;
}

// 本文（JSON の文字列）→ 貼り付ける文字列
export const wrapPacket = (json: string): string => wrapWith(PACKET_PREFIX, json);

export type Unwrapped =
  | { ok: true; json: string }
  | { ok: false; reason: 'not-packet' | 'truncated' | 'crc' | 'encoding' };

// 貼り付けた文字列 → 本文。前後の空白と、途中の改行・空白（メールや共有で折り返されたもの）は無視する
export const unwrapPacket = (pasted: string): Unwrapped => unwrapWith(PACKET_PREFIX, pasted);

export function unwrapWith(prefix: string, pasted: string): Unwrapped {
  const text = pasted.replace(/\s+/g, '');
  if (!text.startsWith(prefix)) return { ok: false, reason: 'not-packet' };
  const rest = text.slice(prefix.length);
  const dot = rest.lastIndexOf('.');
  if (dot < 0) return { ok: false, reason: 'truncated' };
  const body = rest.slice(0, dot);
  const crc = rest.slice(dot + 1);
  if (!/^[0-9a-f]{8}$/.test(crc)) return { ok: false, reason: 'truncated' };
  if (crcHex(utf8Encode(body)) !== crc) return { ok: false, reason: 'crc' };
  const bytes = base64urlDecode(body);
  const json = bytes === null ? null : utf8Decode(bytes);
  return json === null ? { ok: false, reason: 'encoding' } : { ok: true, json };
}
