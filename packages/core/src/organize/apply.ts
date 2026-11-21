// AI の整理の答えを、確かめて、記録の行にする（段2。docs/04 の 5）。純関数。
//
// 確かめること（通らないものは、事実にしない。黙って捨てず、種類と理由ごとの件数を report に残す）：
//  - 引用が、保存した文にある（そのまま、または全角・半角・ダッシュをそろえて）。1〜200 字、改行をまたがない
//  - 日時は、引用を決定論で読む（time/when.ts）。日時の引用がなければ、記載の日時
//  - 測定値は、引用を決定論で読む（labs/read.ts）。AI が書いた数は使わない
//  - 事実の文字に、識別情報の形（電話・メールなど）がない
// 置き換えた文そのもの（保存した文）は、1字も変えない。
import { findShapes } from '../guard/shapes.ts';
import { type LabRow, readLabText } from '../labs/read.ts';
import { READ_VALUES_KINDS, type SourceKind } from '../record/schema.ts';
import { foldSameLength } from '../text/fold.ts';
import { parseWhen } from '../time/when.ts';
import type { EventKind, MedicationAction, OrganizeAnswer, ProblemActivity, ProblemStatus, SegmentLabel } from './answer.ts';

export const ORGANIZE_QUOTE_MAX = 200;
/** 1つの文から作る、種類ごとの行の上限 */
export const ORGANIZE_ITEMS_MAX = 300;

export interface OrganizeContext {
  /** 保存した文（識別情報を置き換えた後） */
  readonly text: string;
  /** 文の種類（入れたとき） */
  readonly kind: SourceKind;
  /** 記載の日時（入れたとき。分からなければ null） */
  readonly at: string | null;
  /** 受診の開始の日時（病日を読むため） */
  readonly encounterStart: string;
}

export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface OrganizedSegment extends Span {
  readonly label: SegmentLabel;
}

export interface OrganizedMedication extends Span {
  readonly name: string;
  readonly doseText: string | null;
  readonly action: MedicationAction | null;
  readonly at: string | null;
}

export interface OrganizedEvent extends Span {
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
}

export interface OrganizedProblem extends Span {
  readonly name: string;
  readonly status: ProblemStatus;
  readonly activity: ProblemActivity | null;
  readonly at: string | null;
}

export interface OrganizedObservation {
  readonly row: LabRow;
  readonly at: string | null;
  /** parser：文全体を決定論で読んだ（検査結果・バイタルの文）。ai：AI が指した場所を、決定論で読んだ */
  readonly origin: 'parser' | 'ai';
}

export const REPORT_CATEGORIES = ['kind', 'when', 'segment', 'medication', 'event', 'problem', 'measurement'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_REASONS = ['not_found', 'bad_quote', 'shape', 'when_unread', 'unread', 'order', 'too_many'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type OrganizeReport = Partial<Record<ReportCategory, Partial<Record<ReportReason, number>>>>;

export const REPORT_CATEGORY_NAMES: Readonly<Record<ReportCategory, string>> = {
  kind: '記載の種類',
  when: '記載の日時',
  segment: '区切り',
  medication: '投薬',
  event: 'できごと',
  problem: '問題',
  measurement: '測定値',
};
export const REPORT_REASON_NAMES: Readonly<Record<ReportReason, string>> = {
  not_found: '引用が文になかった',
  bad_quote: '引用の形が違った',
  shape: '識別情報の形があった',
  when_unread: '日時を読めなかった（日時なしにした）',
  unread: '値として読めない部分があった',
  order: '区切りの順が合わなかった',
  too_many: '多すぎた',
};

export interface Organized {
  /** 記載の種類（未分類の文に、AI が種類を付けたときだけ。それ以外は、入れたときの種類） */
  readonly kind: SourceKind;
  /** 記載の日時（入れたときに分からず、文に書かれていて読めたときだけ、それ。それ以外は、入れたときの日時） */
  readonly at: string | null;
  readonly segments: readonly OrganizedSegment[];
  readonly medications: readonly OrganizedMedication[];
  readonly events: readonly OrganizedEvent[];
  readonly problems: readonly OrganizedProblem[];
  readonly observations: readonly OrganizedObservation[];
  readonly report: OrganizeReport;
}

function count(report: Record<string, Record<string, number>>, category: ReportCategory, reason: ReportReason, n = 1): void {
  const bucket = (report[category] ??= {});
  bucket[reason] = (bucket[reason] ?? 0) + n;
}

/** 引用の形が使えるか（前後の空白・改行なし、長さ） */
function quoteShapeOk(quote: string): boolean {
  return quote.length >= 1 && quote.length <= ORGANIZE_QUOTE_MAX && quote === quote.trim() && !quote.includes('\n');
}

/** 引用の、文の中の場所（from より後の、最初の場所）。そのまま探し、なければ、そろえて探す */
function locate(text: string, folded: string, quote: string, from = 0): Span | null {
  let at = text.indexOf(quote, from);
  if (at < 0) at = folded.indexOf(foldSameLength(quote), from);
  return at < 0 ? null : { start: at, end: at + quote.length };
}

export function applyOrganization(answer: OrganizeAnswer, ctx: OrganizeContext): Organized {
  const { text } = ctx;
  const folded = foldSameLength(text);
  const report: Record<string, Record<string, number>> = {};

  /** 引用を確かめて、場所を返す。通らなければ、件数を数えて null */
  const place = (category: ReportCategory, quote: string, from = 0): Span | null => {
    if (!quoteShapeOk(quote)) {
      count(report, category, 'bad_quote');
      return null;
    }
    const span = locate(text, folded, quote, from);
    if (span === null) {
      count(report, category, 'not_found');
      return null;
    }
    if (findShapes(text.slice(span.start, span.end)).length > 0) {
      count(report, category, 'shape');
      return null;
    }
    return span;
  };

  // 記載の種類：未分類の文だけ
  let kind = ctx.kind;
  if (ctx.kind === 'unsorted' && answer.kind !== null && answer.kind !== 'unsorted') kind = answer.kind;

  // 記載の日時：入れたときに分からなかったときだけ、文から
  let at = ctx.at;
  const encounterStart = ctx.encounterStart.slice(0, 10);
  if (ctx.at === null && answer.when !== null) {
    const span = place('when', answer.when);
    if (span !== null) {
      const parsed = parseWhen(text.slice(span.start, span.end), { refDay: null, encounterStart });
      if (parsed === null) count(report, 'when', 'when_unread');
      else at = parsed;
    }
  }
  const whenCtx = { refDay: at === null ? null : at.slice(0, 10), encounterStart };

  /** 事実の日時：引用があれば、それを読む（読めなければ null と数える）。なければ、記載の日時 */
  const factAt = (category: ReportCategory, when: string | null): string | null => {
    if (when === null) return at;
    const span = place(category, when);
    if (span === null) return null;
    const parsed = parseWhen(text.slice(span.start, span.end), whenCtx);
    if (parsed === null) count(report, category, 'when_unread');
    return parsed;
  };

  const capped = <T>(category: ReportCategory, items: readonly T[]): readonly T[] => {
    if (items.length <= ORGANIZE_ITEMS_MAX) return items;
    count(report, category, 'too_many', items.length - ORGANIZE_ITEMS_MAX);
    return items.slice(0, ORGANIZE_ITEMS_MAX);
  };

  // 区切り：文の順に、前の区切りより後ろで見つかったものだけ
  const starts: { label: SegmentLabel; start: number }[] = [];
  let cursor = 0;
  for (const s of capped('segment', answer.segments)) {
    const span = place('segment', s.start, cursor);
    if (span === null) continue;
    if (starts.length > 0 && span.start <= (starts.at(-1)?.start ?? -1)) {
      count(report, 'segment', 'order');
      continue;
    }
    starts.push({ label: s.label, start: span.start });
    cursor = span.start + 1;
  }
  const segments: OrganizedSegment[] = starts.map((s, i) => ({ label: s.label, start: s.start, end: starts[i + 1]?.start ?? text.length }));

  const medications: OrganizedMedication[] = [];
  for (const m of capped('medication', answer.medications)) {
    const name = place('medication', m.name);
    if (name === null) continue;
    let doseText: string | null = null;
    if (m.dose !== null) {
      const dose = place('medication', m.dose);
      if (dose === null) continue;
      doseText = text.slice(dose.start, dose.end);
    }
    medications.push({ ...name, name: text.slice(name.start, name.end), doseText, action: m.action, at: factAt('medication', m.when) });
  }

  const events: OrganizedEvent[] = [];
  for (const e of capped('event', answer.events)) {
    const span = place('event', e.title);
    if (span === null) continue;
    events.push({ ...span, kind: e.kind, title: text.slice(span.start, span.end), at: factAt('event', e.when) });
  }

  const problems: OrganizedProblem[] = [];
  for (const p of capped('problem', answer.problems)) {
    const span = place('problem', p.name);
    if (span === null) continue;
    problems.push({ ...span, name: text.slice(span.start, span.end), status: p.status, activity: p.activity, at });
  }

  // 測定値：検査結果・バイタルの文は、文全体を決定論で読む（AI の指した場所は使わない）。
  // ほかの文は、AI が指した場所だけを、決定論で読む（「K 3.5 を目標に」のような、測定でない数を、AI が指さないことに頼る）
  const observations: OrganizedObservation[] = [];
  if (READ_VALUES_KINDS.includes(kind)) {
    for (const row of readLabText(text).rows) observations.push({ row, at, origin: 'parser' });
  } else {
    const used: Span[] = [];
    for (const m of capped('measurement', answer.measurements)) {
      // 同じ引用が、文に何度も出るとき（時刻の違う同じ測定）は、まだ使っていない場所を、順に使う
      let span: Span | null = null;
      if (quoteShapeOk(m.quote)) {
        let from = 0;
        for (;;) {
          const found = locate(text, folded, m.quote, from);
          if (found === null) break;
          if (!used.some((u) => u.start === found.start)) {
            span = found;
            break;
          }
          from = found.start + 1;
        }
        if (span === null) count(report, 'measurement', 'not_found');
      } else count(report, 'measurement', 'bad_quote');
      if (span === null) continue;
      used.push(span);
      const read = readLabText(text.slice(span.start, span.end));
      if (read.unread.length > 0) count(report, 'measurement', 'unread');
      if (read.rows.length === 0) continue;
      const rowAt = factAt('measurement', m.when);
      for (const row of read.rows) observations.push({ row: { ...row, start: row.start + span.start, end: row.end + span.start }, at: rowAt, origin: 'ai' });
    }
  }

  return { kind, at, segments, medications, events, problems, observations, report };
}

/** 確かめられなかった件数の合計 */
export function reportTotal(report: OrganizeReport): number {
  let n = 0;
  for (const reasons of Object.values(report)) for (const v of Object.values(reasons)) n += v;
  return n;
}
