// 文字の「そろえ」（長さを変えない）。形の検査と、検査値の読み取りが、同じそろえ方を使う。
// 長さを変えないので、そろえた文で見つけた位置は、そのまま元の文の位置になる（保存する文は、元の文のまま）。

/** 見えない書式の文字（ゼロ幅の空白・接続子、ソフトハイフン、向きの印、語をつなぐ字、BOM）。臨床の意味を持たない */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

/**
 * 保存する前の、決まった整え：見えない書式の文字を除き、改行を LF にそろえ、前後の空白を落とす。
 * ほかの文字は、1字も変えない（全角・半角も、そのまま）。
 */
export function cleanText(text: string): string {
  return text.replace(INVISIBLE, '').replace(/\r\n?/gu, '\n').trim();
}

const SCRIPTS: ReadonlyMap<string, string> = new Map([
  ...Array.from({ length: 10 }, (_, i) => [String.fromCharCode(0x2080 + i), String(i)] as const),
  ['\u2070', '0'],
  ['\u00B9', '1'],
  ['\u00B2', '2'],
  ['\u00B3', '3'],
  ...Array.from({ length: 6 }, (_, i) => [String.fromCharCode(0x2074 + i), String(i + 4)] as const),
  ['\u207A', '+'],
  ['\u207B', '-'],
  ['\u208A', '+'],
  ['\u208B', '-'],
]);

const DASHES = new Set(['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212', '\uFF0D', '\uFE63']);
const SPACES = new Set(['\u3000', '\u00A0', '\t']);

/** 1字を、比べるための形にする（全角の英数字・記号 → 半角、ダッシュの変種 → 「-」、空白の変種 → 空白、下付き・上付きの数字と符号 → 普通の字）。必ず1字を返す */
function foldChar(c: string): string {
  const code = c.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  if (DASHES.has(c)) return '-';
  if (SPACES.has(c)) return ' ';
  // マイクロ記号（µ）を、ギリシャ文字のミュー（μ）に
  if (c === '\u00B5') return '\u03BC';
  // 下付き・上付きの数字と符号（「SpO₂」「pCO₂」「HCO₃⁻」「m²」）を、普通の字に（2026-11-21：SpO₂ が読めなかった）
  const sub = SCRIPTS.get(c);
  if (sub !== undefined) return sub;
  return c;
}

/** 文を、比べるための形にする。**長さ（UTF-16 の単位の数）は変わらない**。 */
export function foldSameLength(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += foldChar(text.charAt(i));
  return out;
}

/** 英字の大文字だけを小文字にする（長さは変わらない） */
export function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
