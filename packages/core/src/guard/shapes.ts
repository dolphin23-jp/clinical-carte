// 保存の前の、形の検査（docs/01 の 2 の 3 番目の網）：電話・メール・郵便番号（〒つき）・12桁以上の数字。
// 文脈が要るもの（氏名・施設名・生年月日・住所）は、AI の選別の仕事で、ここでは見ない。
//
// 検出の式は、clinical-casebook の匿名化リンタ（lint/anonymize.ts）から、次の分だけ写した。
// **Casebook より狭い**：ここは、見つけた場所を置き換えて保存するので、臨床の数値を誤って置き換えないことを優先する。
//  - 郵便番号は「〒」つきだけ（3桁-4桁の、範囲の書き方〔尿量の幅など〕を、郵便番号とみなさない）
//  - 4桁ずつ区切った12桁は見ない（4桁の値を3つ並べた書き方を、番号とみなさない）
//  - 暦日は見ない（carte は暦日をそのまま持つ。CA-004）
import { foldSameLength } from '../text/fold.ts';

export const SHAPE_KINDS = ['phone', 'email', 'postal', 'digits'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export const SHAPE_TOKENS: Readonly<Record<ShapeKind, string>> = {
  phone: '〔電話番号〕',
  email: '〔メール〕',
  postal: '〔郵便番号〕',
  digits: '〔番号〕',
};

export const SHAPE_LABELS: Readonly<Record<ShapeKind, string>> = {
  phone: '電話番号の形',
  email: 'メールアドレスの形',
  postal: '郵便番号の形',
  digits: '12桁以上の数字',
};

export interface ShapeFinding {
  readonly kind: ShapeKind;
  readonly start: number;
  readonly end: number;
}

const PHONE_SEP = '[-().\\s]';

function spans(re: RegExp, text: string, kind: ShapeKind, accept: (m: RegExpExecArray) => boolean = () => true): ShapeFinding[] {
  const out: ShapeFinding[] = [];
  for (const m of text.matchAll(re)) {
    if (accept(m)) out.push({ kind, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function findPhones(line: string): ShapeFinding[] {
  const separated = new RegExp(`(?<![\\d+])(?:\\+81${PHONE_SEP}?|0)\\d{1,4}${PHONE_SEP}{1,2}\\d{1,4}${PHONE_SEP}{1,2}\\d{3,4}(?!\\d)`, 'g');
  return [
    ...spans(separated, line, 'phone', (m) => {
      const digits = m[0].replace(/\D/g, '');
      const n = m[0].startsWith('+81') ? digits.length - 2 + 1 : digits.length;
      return n >= 10 && n <= 11;
    }),
    ...spans(/(?<!\d)0[1-9]\d{8,9}(?!\d)/g, line, 'phone'),
    ...spans(new RegExp(`(?<![\\d+])\\+81${PHONE_SEP}?0?[1-9]\\d{8,9}(?!\\d)`, 'g'), line, 'phone'),
  ];
}

function findEmails(line: string): ShapeFinding[] {
  return spans(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g, line, 'email');
}

function findPostalCodes(line: string): ShapeFinding[] {
  return spans(/〒\s?\d{3}\s?-?\s?\d{4}/g, line, 'postal');
}

function findLongDigits(line: string): ShapeFinding[] {
  return [
    ...spans(/(?<!\d)(?<!\d\.)\d{12}(?!\d)(?!\.\d)/g, line, 'digits'),
    ...spans(/(?<![\dA-Za-z])(?<!\d\.)\d{13,}(?![\dA-Za-z])(?!\.\d)/g, line, 'digits'),
  ];
}

/** 形の検査。見つけた場所（元の文の位置）を、重なりをまとめて、前から順に返す。見つけた文字そのものは返さない。 */
export function findShapes(text: string): ShapeFinding[] {
  const folded = foldSameLength(text);
  const all = [...findPhones(folded), ...findEmails(folded), ...findPostalCodes(folded), ...findLongDigits(folded)].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: ShapeFinding[] = [];
  for (const f of all) {
    const last = merged.at(-1);
    if (last !== undefined && f.start < last.end) {
      if (f.end > last.end) merged[merged.length - 1] = { kind: last.kind, start: last.start, end: f.end };
    } else merged.push(f);
  }
  return merged;
}

export type ShapeCounts = Readonly<Partial<Record<ShapeKind, number>>>;

/** 見つけた場所だけを、決まった語に置き換える。ほかの文字は変えない。 */
export function replaceShapes(text: string): { text: string; counts: ShapeCounts } {
  const findings = findShapes(text);
  const counts: Partial<Record<ShapeKind, number>> = {};
  let out = '';
  let at = 0;
  for (const f of findings) {
    out += text.slice(at, f.start) + SHAPE_TOKENS[f.kind];
    at = f.end;
    counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  }
  return { text: out + text.slice(at), counts };
}
