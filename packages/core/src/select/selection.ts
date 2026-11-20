// AI の選別（docs/01 の 2 の 2 番目の網。CA-006）：AI は、識別情報の**場所を指すだけ**。文は書き換えない。
// ここは、AI の答えの形と、指された場所を決まった語に置き換える処理（決定論）。AI を呼ぶのは apps/worker。
//
// - AI が返すのは、種類と、文の中の引用（その文字のまま）だけ。置き換える語は、ここの表で決まる（AI は語を作らない）。
// - 引用が文に見つからない・短すぎる・長すぎるときは、**選別の失敗**にする（その文は保存しない。AGENTS.md の 1）。
// - 置き換えるのは、指された場所だけ。ほかの文字は、1字も変えない（試験が確かめる）。
import { z } from 'zod';

import { foldSameLength } from '../text/fold.ts';

export const IDENTIFIER_KINDS = ['person', 'staff', 'patient_id', 'birth_date', 'address', 'contact', 'facility', 'other_name'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** 施設の実名の、置き換え先（CA-005）。AI は、この中から選ぶだけ */
export const FACILITY_ROLES = ['own', 'local', 'previous', 'other'] as const;
export type FacilityRole = (typeof FACILITY_ROLES)[number];

export const FACILITY_TOKENS: Readonly<Record<FacilityRole, string>> = {
  own: '当院',
  local: '近医',
  previous: '前医',
  other: '他院',
};

export const IDENTIFIER_TOKENS: Readonly<Record<IdentifierKind, string>> = {
  person: '〔氏名〕',
  staff: '〔医療者〕',
  patient_id: '〔ID〕',
  birth_date: '〔生年月日〕',
  address: '〔住所〕',
  contact: '〔連絡先〕',
  facility: '〔施設〕',
  other_name: '〔固有名〕',
};

export const IDENTIFIER_LABELS: Readonly<Record<IdentifierKind, string>> = {
  person: '氏名',
  staff: '医療者の名前',
  patient_id: 'ID・番号',
  birth_date: '生年月日',
  address: '住所',
  contact: '連絡先',
  facility: '施設の名前',
  other_name: '勤務先・学校などの固有名',
};

/** AI の答えの形（構造化した出力の型）。長さなどの細かい検査は、applySelection がする */
export const SelectionAnswer = z.object({
  identifiers: z.array(
    z.object({
      kind: z.enum(IDENTIFIER_KINDS),
      quote: z.string(),
      facility: z.enum(FACILITY_ROLES).nullable(),
    }),
  ),
});
export type SelectionAnswer = z.infer<typeof SelectionAnswer>;

/** 引用の長さ（文字）。1字の引用は、ほかの語の一部まで置き換えるので受け付けない（「関」→「関節」） */
export const QUOTE_MIN = 2;
export const QUOTE_MAX = 60;
/** 数字と記号だけの引用に要る、数字の数（「72」のような短い数を、文じゅうで置き換えない） */
export const DIGIT_QUOTE_MIN_DIGITS = 4;
/** 1つの文で指せる数 */
export const IDENTIFIERS_MAX = 200;

export type SelectionProblem = 'not_found' | 'too_short' | 'too_long' | 'too_many' | 'bad_shape';

export type IdentifierCounts = Readonly<Partial<Record<IdentifierKind, number>>>;

export type SelectionResult =
  | { readonly ok: true; readonly text: string; readonly counts: IdentifierCounts }
  | { readonly ok: false; readonly problems: readonly SelectionProblem[] };

interface Span {
  readonly start: number;
  readonly end: number;
  readonly token: string;
  readonly kind: IdentifierKind;
}

const DIGITS_ONLY = /^[\d\s\-./()]+$/u;
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** 引用の、文の中の場所（すべて）。そのままの文字で探し、なければ、全角・半角とダッシュをそろえて探す（長さは変わらないので、位置は元の文のもの）。 */
function locate(text: string, folded: string, quote: string): { start: number; end: number }[] {
  const find = (hay: string, needle: string): { start: number; end: number }[] => {
    const out: { start: number; end: number }[] = [];
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push({ start: at, end: at + needle.length });
    return out;
  };
  const exact = find(text, quote);
  if (exact.length > 0) return exact;
  return find(folded, foldSameLength(quote));
}

/**
 * AI が指した場所を、決まった語に置き換える。
 * 1つでも確かめられない引用があれば、全体を失敗にする（識別情報が残っているかもしれない文を、通さない）。
 */
export function applySelection(text: string, answer: SelectionAnswer): SelectionResult {
  const problems = new Set<SelectionProblem>();
  if (answer.identifiers.length > IDENTIFIERS_MAX) return { ok: false, problems: ['too_many'] };
  const folded = foldSameLength(text);
  const spans: Span[] = [];

  for (const item of answer.identifiers) {
    const quote = item.quote;
    if (quote !== quote.trim() || quote.includes('\n')) {
      // 前後の空白・改行をまたぐ引用は、場所があいまいになる
      problems.add('bad_shape');
      continue;
    }
    if (quote.length < QUOTE_MIN) {
      problems.add('too_short');
      continue;
    }
    if (quote.length > QUOTE_MAX) {
      problems.add('too_long');
      continue;
    }
    const digitsOnly = DIGITS_ONLY.test(foldSameLength(quote));
    if (digitsOnly && quote.replace(/\D/gu, '').length < DIGIT_QUOTE_MIN_DIGITS) {
      problems.add('too_short');
      continue;
    }
    const token = item.kind === 'facility' && item.facility !== null ? FACILITY_TOKENS[item.facility] : IDENTIFIER_TOKENS[item.kind];
    let found = locate(text, folded, quote);
    // 数字だけの引用は、ほかの数の一部に当てない（「12345」を、「0.12345」「912345」の中で置き換えない）
    if (digitsOnly) found = found.filter(({ start, end }) => !isDigit(folded[start - 1]) && !isDigit(folded[end]) && !(folded[start - 1] === '.' && isDigit(folded[start - 2])));
    if (found.length === 0) {
      problems.add('not_found');
      continue;
    }
    for (const f of found) spans.push({ ...f, token, kind: item.kind });
  }
  if (problems.size > 0) return { ok: false, problems: [...problems] };

  // 重なりは、前から・長いものを先に取り、重なる後ろのものは、広げてまとめる（語は、先に取ったもの）
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last !== undefined && s.start < last.end) {
      if (s.end > last.end) merged[merged.length - 1] = { ...last, end: s.end };
    } else merged.push(s);
  }

  const counts: Partial<Record<IdentifierKind, number>> = {};
  let out = '';
  let at = 0;
  for (const s of merged) {
    out += text.slice(at, s.start) + s.token;
    at = s.end;
    counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  }
  return { ok: true, text: out + text.slice(at), counts };
}
