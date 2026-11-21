// 問題以外の事実を、本人が直す（段3e。docs/04 の 10）。直せるのは、外す・戻すと、選ぶだけの直し。打つ欄はない
// （打った文は選別を通す決まり。docs/01 の 2）。API の本文の形と、直した値を整理し直しで引き継ぐための鍵は、ここの1か所。
import { z } from 'zod';

import { findShapes } from '../guard/shapes.ts';
import { readLabText } from '../labs/read.ts';
import { EVENT_KINDS, MEDICATION_ACTIONS, PROBLEM_STATUSES, SEGMENT_LABELS } from '../organize/answer.ts';
import { AUTHOR_ROLES, DateTime, SOURCE_KINDS, TEXT_LIMIT } from './schema.ts';

export const FACT_KINDS = ['medication', 'event', 'observation'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_FIELDS = ['excluded', 'action', 'kind', 'at'] as const;
export type FactField = (typeof FACT_FIELDS)[number];

export const FACT_FIELD_NAMES: Readonly<Record<FactField, string>> = {
  excluded: '外す・戻す',
  action: '投薬の動き',
  kind: 'できごとの種類',
  at: '日時',
};

/** 事実の直し：1回に1つの欄。action は投薬だけ、kind はできごとだけ（サーバーが確かめる） */
export const FactPatch = z.union([
  z.strictObject({ excluded: z.boolean() }),
  z.strictObject({ action: z.enum(MEDICATION_ACTIONS).nullable() }),
  z.strictObject({ kind: z.enum(EVENT_KINDS) }),
  z.strictObject({ at: DateTime.nullable() }),
  // 値の項目名を、検査名の表から選び直す（値だけ。CA-029。表にない名前はサーバーが断る）
  z.strictObject({ name: z.string().min(1).max(60) }),
]);
export type FactPatch = z.infer<typeof FactPatch>;

/** その直しが、その種類の事実に使えるか */
export function patchFits(fact: FactKind, patch: FactPatch): boolean {
  if ('action' in patch) return fact === 'medication';
  if ('kind' in patch) return fact === 'event';
  if ('name' in patch) return fact === 'observation';
  return true;
}

/** 整理し直しで、本人の直しを引き継ぐための鍵：同じ文の、同じ場所の、同じ字（場所が変われば、引き継がない） */
export function carryKey(start: number, end: number, text: string): string {
  return `${String(start)}:${String(end)}:${text}`;
}

// ---------------------------------------------------------------------------
// なぞって足す（CA-029 の B）：保存した文の一部（場所）を選び、問題・投薬・できごと・値・区切りとして足す。
// 字は文にあるとおりなので、選別をもう一度通さない。確かめは決定論（checkSpan）。

export const ADD_TYPES = ['problem', 'medication', 'event', 'observation', 'segment'] as const;
export type AddType = (typeof ADD_TYPES)[number];

/** 足すものの形。segment は start だけを使う（その場所から区切りを始める） */
export const AddFact = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('problem'), start: z.number().int().min(0), end: z.number().int().min(1), status: z.enum(PROBLEM_STATUSES) }),
  z.strictObject({ type: z.literal('medication'), start: z.number().int().min(0), end: z.number().int().min(1), action: z.enum(MEDICATION_ACTIONS).nullable() }),
  z.strictObject({ type: z.literal('event'), start: z.number().int().min(0), end: z.number().int().min(1), kind: z.enum(EVENT_KINDS) }),
  z.strictObject({ type: z.literal('observation'), start: z.number().int().min(0), end: z.number().int().min(1) }),
  z.strictObject({ type: z.literal('segment'), start: z.number().int().min(0), label: z.enum(SEGMENT_LABELS) }),
]);
export type AddFact = z.infer<typeof AddFact>;

/** なぞった字の長さの上限（整理の引用と同じ） */
export const ADD_QUOTE_MAX = 200;

export type SpanProblem = 'range' | 'empty' | 'too_long' | 'newline' | 'shape' | 'no_value';
export const SPAN_PROBLEM_NAMES: Readonly<Record<SpanProblem, string>> = {
  range: '文の外を選んでいる',
  empty: '字が選ばれていない',
  too_long: `長すぎる（${String(ADD_QUOTE_MAX)} 字まで）`,
  newline: '行をまたいでいる',
  shape: '識別情報の形がある',
  no_value: '値として読めない（「Na 128」のように、名前と値をひと続きに選ぶ）',
};

/**
 * なぞった場所を確かめる。前後の空白は除いて場所を詰める。値は、決定論で読めること（数を AI に写させない決まりと同じ）。
 * 区切りは、文の中の場所であればよい。
 */
export function checkSpan(text: string, add: AddFact): { ok: true; start: number; end: number; quote: string } | { ok: false; problem: SpanProblem } {
  if (add.type === 'segment') {
    if (add.start >= text.length) return { ok: false, problem: 'range' };
    return { ok: true, start: add.start, end: add.start, quote: '' };
  }
  if (add.end > text.length || add.start >= add.end) return { ok: false, problem: 'range' };
  let start = add.start;
  let end = add.end;
  while (start < end && /\s/u.test(text[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1;
  if (start === end) return { ok: false, problem: 'empty' };
  const quote = text.slice(start, end);
  if (quote.length > ADD_QUOTE_MAX) return { ok: false, problem: 'too_long' };
  if (/[\r\n\u2028\u2029]/u.test(quote)) return { ok: false, problem: 'newline' };
  if (findShapes(quote).length > 0) return { ok: false, problem: 'shape' };
  if (add.type === 'observation' && readLabText(quote).rows.length === 0) return { ok: false, problem: 'no_value' };
  return { ok: true, start, end, quote };
}

/** 区切りの終わり：始まりの順に並べ、次の始まり（最後は文の終わり）まで */
export function segmentEnds<T extends { readonly start: number }>(segments: readonly T[], textLength: number): (T & { end: number })[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  return sorted.map((s, i) => ({ ...s, end: sorted[i + 1]?.start ?? textLength }));
}

// ---------------------------------------------------------------------------
// 記載・区切りを直す（CA-029 の A）・文を打ち直す（C-1：サーバーで選別を通す）

export const SourcePatch = z.union([
  z.strictObject({ kind: z.enum(SOURCE_KINDS) }),
  z.strictObject({ at: DateTime.nullable() }),
  z.strictObject({ authorRole: z.enum(AUTHOR_ROLES) }),
]);
export type SourcePatch = z.infer<typeof SourcePatch>;

export const SegmentPatch = z.strictObject({ label: z.enum(SEGMENT_LABELS) });
export type SegmentPatch = z.infer<typeof SegmentPatch>;

/** 文の打ち直し：文を入れるときと同じ選別を通す（C-1） */
export const SourceTextPut = z.strictObject({ text: z.string().min(1).max(TEXT_LIMIT), nextDay: z.boolean().optional() });
export type SourceTextPut = z.infer<typeof SourceTextPut>;

/** 本人の調節の記録（user_edits）の欄 */
export const USER_EDIT_FIELDS = ['kind', 'at', 'author_role', 'label', 'status', 'activity', 'ord', 'excluded', 'unmerge', 'typed_name', 'name', 'text', 'added'] as const;
export type UserEditField = (typeof USER_EDIT_FIELDS)[number];
export const USER_EDIT_FIELD_NAMES: Readonly<Record<UserEditField, string>> = {
  kind: '種類',
  at: '日時',
  author_role: '書いた人',
  label: '区切りの見出し',
  status: '確からしさ',
  activity: '状態',
  ord: '並び',
  excluded: '外す・戻す',
  unmerge: '統合を解く',
  typed_name: '打って直した名前',
  name: '項目名',
  text: '文を打ち直した',
  added: 'なぞって足した',
};
export const USER_EDIT_TARGETS = ['source', 'segment', 'thread', 'problem', 'medication', 'event', 'observation'] as const;
export type UserEditTarget = (typeof USER_EDIT_TARGETS)[number];
