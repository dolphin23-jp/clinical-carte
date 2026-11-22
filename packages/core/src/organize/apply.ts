// AI の整理の答えを、確かめて、記録の行にする（段2。docs/04 の 5）。純関数。
//
// 確かめること（通らないものは、事実にしない。黙って捨てず、種類と理由ごとの件数を report に残す）：
//  - 引用が、保存した文にある（そのまま、または全角・半角・ダッシュをそろえて）。1〜200 字、改行をまたがない
//  - 日時は、引用を決定論で読む（time/when.ts）。日時の引用がなければ、記載の日時
//  - 測定値は、まず引用を決定論で読む（labs/read.ts）。読めなければ、AI が読んだ項目と値を使い（CA-056）、引用の字に同じ数がないものに印（unseen）を付ける
//  - 規則で読めない日時の言い方は、AI の手がかり（基準とずれ）から決定論で計算し、幅のあるものに「ごろ」の印（CA-056。time/hint.ts）
//  - 経過の出来事（CA-056）：引用の場所と、AI の短い要約。要約の中の数は引用にあるものだけ（なければ、引用の字を要約にする）
//  - 事実の文字に、識別情報の形（電話・メールなど）がない
// 置き換えた文そのもの（保存した文）は、1字も変えない。
import { findShapes, replaceShapes } from '../guard/shapes.ts';
import { type LabRow, readLabText } from '../labs/read.ts';
import { READ_VALUES_KINDS, type SourceKind } from '../record/schema.ts';
import { foldSameLength } from '../text/fold.ts';
import { daysBetween } from '../time/datetime.ts';
import { resolveHint } from '../time/hint.ts';
import { lineHeadWhen, parseWhen, shiftDay, type WhenContext } from '../time/when.ts';
import type { AiValue, CourseCategory, EventKind, MedicationAction, OrganizeAnswer, ProblemActivity, ProblemStatus, SegmentLabel, WhenHint } from './answer.ts';

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
  /** 記載の中で日をまたいだと本人が確かめた場所（文の中の位置）。ここより後ろの、日の書かれていない時刻は翌日（CA-047）。なければ null */
  readonly nextDayFrom?: number | null;
}

/** 行頭の日時で、日だけのものを使う、記載の日からの幅（日）。これより離れた「1/2 …」のような行は、日時にしない */
const LINE_DAY_RANGE = 31;

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
  /** 日時がおおよそのときの印（「夕方ごろ」など。CA-056） */
  readonly atApprox: string | null;
}

export interface OrganizedEvent extends Span {
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
  readonly atApprox: string | null;
}

/** 経過の出来事（CA-056）：引用の場所と、AI の短い要約 */
export interface OrganizedCourse extends Span {
  readonly category: CourseCategory;
  readonly summary: string;
  readonly at: string | null;
  readonly atApprox: string | null;
}

/** 経過の出来事の要約の長さの上限 */
export const COURSE_SUMMARY_MAX = 80;

export interface OrganizedProblem extends Span {
  readonly name: string;
  readonly status: ProblemStatus;
  readonly activity: ProblemActivity | null;
  readonly at: string | null;
}

export interface OrganizedObservation {
  readonly row: LabRow;
  readonly at: string | null;
  /** parser：文全体を決定論で読んだ（検査結果・バイタルの文）。ai：AI が指した場所を読んだ */
  readonly origin: 'parser' | 'ai';
  readonly atApprox: string | null;
  /** rule：字を決定論で読んだ。ai：AI が読んだ項目と値（CA-056） */
  readonly readBy: 'rule' | 'ai';
  /** AI が読んだ値の数が、書かれた場所の字に見つからない（印を付けて出す） */
  readonly unseen: boolean;
}

export const REPORT_CATEGORIES = ['kind', 'when', 'segment', 'medication', 'event', 'problem', 'measurement', 'course'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_REASONS = ['not_found', 'bad_quote', 'shape', 'when_unread', 'unread', 'order', 'too_many', 'summary_number'] as const;
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
  course: '経過の出来事',
};
export const REPORT_REASON_NAMES: Readonly<Record<ReportReason, string>> = {
  not_found: '引用が文になかった',
  bad_quote: '引用の形が違った',
  shape: '識別情報の形があった',
  when_unread: '日時を読めなかった（日時なしにした）',
  unread: '値として読めない部分があった',
  order: '区切りの順が合わなかった',
  too_many: '多すぎた',
  summary_number: '要約の数が引用になかった（引用の字を出した）',
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
  readonly course: readonly OrganizedCourse[];
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

/** 場所が行の頭か（前に、同じ行の空白しかない） */
function atLineStart(text: string, pos: number): boolean {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return text.slice(lineStart, pos).trim() === '';
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

  // 記載の日時：入れたときに分からなかったときは、文から。日だけで入れたときは、文に書かれた同じ日の時刻を足す
  // （2026-11-21 の本人の決定：文に書かれた時刻を、AI が場所を指し、決定論で読んで、自動で記録の時刻にする）
  let at = ctx.at;
  const encounterStart = ctx.encounterStart.slice(0, 10);
  const nextDayFrom = ctx.nextDayFrom ?? null;
  /** 場所ごとの読み方：日をまたいだ場所より後ろの、時刻だけの言い方は翌日 */
  const withDay = (base: WhenContext, pos: number): WhenContext =>
    nextDayFrom !== null && pos >= nextDayFrom && base.refDay !== null ? { ...base, timeDay: shiftDay(base.refDay, 1) } : base;
  if ((ctx.at === null || ctx.at.length === 10) && answer.when !== null) {
    const span = place('when', answer.when);
    if (span !== null) {
      const parsed = parseWhen(text.slice(span.start, span.end), withDay({ refDay: ctx.at, encounterStart }, span.start));
      if (parsed === null) count(report, 'when', 'when_unread');
      else if (ctx.at === null) at = parsed;
      // 日だけで入れた記載：同じ日の、時刻のある日時のときだけ使う（本人の選んだ日は変えない）
      else if (parsed.length > 10 && parsed.slice(0, 10) === ctx.at) at = parsed;
    }
  }
  const whenCtx = { refDay: at === null ? null : at.slice(0, 10), encounterStart };

  /** 区切りの時刻（区切りの見出しや最初の行に書かれた時刻。区切りの中の、自分の日時のない事実の日時になる） */
  const segmentTimes: { start: number; end: number; at: string }[] = [];
  /** 行頭に書かれた日時（「16:00 BT 39.0 …」「3:00 BT 37.4 …」）。温度板・経過の行を写した文で、その行の値・できごとの日時にする（決定論。AI に頼らない） */
  const lineWhen = (pos: number): string | null => {
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = text.indexOf('\n', pos);
    const quote = lineHeadWhen(text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd));
    if (quote === null) return null;
    const parsed = parseWhen(quote, withDay(whenCtx, lineStart));
    if (parsed === null) return null;
    if (parsed.length === 10 && (whenCtx.refDay === null || Math.abs(daysBetween(whenCtx.refDay, parsed)) > LINE_DAY_RANGE)) return null;
    return parsed;
  };
  /** 自分の日時の書かれていない事実の日時：行頭の日時、区切りの時刻、記載の日時の順。行頭が日だけで、同じ日の時刻が分かっていれば、その時刻 */
  const atOfSpan = (pos: number): string | null => {
    const fallback = segmentTimes.find((g) => pos >= g.start && pos < g.end)?.at ?? at;
    const line = lineWhen(pos);
    if (line === null) return fallback;
    if (line.length === 10 && fallback !== null && fallback.slice(0, 10) === line) return fallback;
    return line;
  };

  /**
   * 事実の日時：引用があれば、それを読む。読めなければ（または引用がなく手がかりがあれば）、AI の手がかりから計算する（CA-056）。
   * どちらもなければ、区切りの時刻、それもなければ記載の日時
   */
  const factWhen = (category: ReportCategory, when: string | null, pos: number | null, hint: WhenHint = null): { at: string | null; approx: string | null } => {
    const fromHint = (): { at: string; approx: string | null } | null => resolveHint(hint, { noteAt: at, encounterStart: ctx.encounterStart });
    if (when === null) {
      const h = fromHint();
      if (h !== null) return h;
      return { at: pos === null ? at : atOfSpan(pos), approx: null };
    }
    const span = place(category, when);
    if (span === null) return { at: null, approx: null };
    const parsed = parseWhen(text.slice(span.start, span.end), withDay(whenCtx, span.start));
    const h = fromHint();
    // 引用を規則で読めた日だけのとき、手がかりが同じ日の時刻・時間帯を足せば、それを使う（「3日前の夕方」）。日が食い違えば、規則で読んだ日のまま
    if (parsed !== null) return h !== null && parsed.length === 10 && h.at.slice(0, 10) === parsed ? h : { at: parsed, approx: null };
    if (h !== null) return h;
    count(report, category, 'when_unread');
    return { at: null, approx: null };
  };

  const capped = <T>(category: ReportCategory, items: readonly T[]): readonly T[] => {
    if (items.length <= ORGANIZE_ITEMS_MAX) return items;
    count(report, category, 'too_many', items.length - ORGANIZE_ITEMS_MAX);
    return items.slice(0, ORGANIZE_ITEMS_MAX);
  };

  // 区切り：文の順に、前の区切りより後ろで見つかったものだけ
  const starts: { label: SegmentLabel; start: number; when: string | null; quote: string }[] = [];
  let cursor = 0;
  for (const s of capped('segment', answer.segments)) {
    const span = place('segment', s.start, cursor);
    if (span === null) continue;
    if (starts.length > 0 && span.start <= (starts.at(-1)?.start ?? -1)) {
      count(report, 'segment', 'order');
      continue;
    }
    starts.push({ label: s.label, start: span.start, when: s.when, quote: s.start });
    cursor = span.start + 1;
  }
  // 「#問題」の見出しの区切り：同じ字が、その前の問題の一覧にもあるとき（「【プロブレムリスト】#1 敗血症…#6 …」のあとに「#1 敗血症…」の見出し）、
  // 前から探すと一覧の側に置かれ、一覧から見出しまでが1つの区切りになる（別の問題の A・P が、みな #1 の範囲に入った）。
  // 後ろの区切りから順に、次の区切りの手前にある、いちばん後ろの行頭の場所に置き直す（字は同じなので、変わるのは場所だけ）
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const s = starts[i];
    if (s?.label !== 'problem_heading') continue;
    const bound = starts[i + 1]?.start ?? text.length;
    let best = s.start;
    for (let from = s.start + 1; ; ) {
      const found = locate(text, folded, s.quote, from);
      if (found === null || found.start >= bound) break;
      if (atLineStart(text, found.start)) best = found.start;
      from = found.start + 1;
    }
    starts[i] = { ...s, start: best };
  }
  const segments: OrganizedSegment[] = starts.map((s, i) => ({ label: s.label, start: s.start, end: starts[i + 1]?.start ?? text.length }));
  for (const [i, s] of starts.entries()) {
    if (s.when === null) continue;
    const span = place('segment', s.when);
    if (span === null) continue;
    const parsed = parseWhen(text.slice(span.start, span.end), withDay(whenCtx, span.start));
    if (parsed === null) {
      count(report, 'segment', 'when_unread');
      continue;
    }
    const seg = segments[i];
    if (seg !== undefined) segmentTimes.push({ start: seg.start, end: seg.end, at: parsed });
  }

  /**
   * 事実の名前の場所。同じ字が文に何度も出るとき、最初の場所に決め打ちしない（問題一覧の「NSAIDs・ARBの関与」の ARB を、
   * P の「ARB…中止」の事実の場所にしてしまうと、別の問題の記載に書かれた薬になる）。字はどの場所でも同じなので、変わるのは場所だけ：
   *  1. 手がかり（用量・日時の引用）が同じ行にある場所
   *  2. その中で、同じ種類の前の項目より後ろの、最初の場所（AI は、文の順に返すことが多い）
   *  3. なければ、手がかりの合う最初の場所。手がかりがどこにも合わなければ、すべての場所から同じ順で選ぶ
   */
  const placeFact = (category: ReportCategory, quote: string, anchors: readonly (string | null)[], cursor: number, prefer?: (span: Span) => boolean): Span | null => {
    const first = place(category, quote);
    if (first === null) return null;
    const found: Span[] = [];
    for (let from = 0; ; ) {
      const next = locate(text, folded, quote, from);
      if (next === null) break;
      found.push(next);
      from = next.start + 1;
    }
    if (found.length === 1) return first;
    // 優先する場所（問題なら「#問題」の見出しの行）があれば、その中から選ぶ
    const preferred = prefer === undefined ? [] : found.filter(prefer);
    const all = preferred.length > 0 ? preferred : found;
    const lineOf = (span: Span): string => {
      const start = text.lastIndexOf('\n', span.start - 1) + 1;
      const end = text.indexOf('\n', span.end);
      return foldSameLength(text.slice(start, end < 0 ? text.length : end));
    };
    const hints = anchors.filter((a): a is string => a !== null && a !== '').map((a) => foldSameLength(a));
    const anchored = hints.length === 0 ? [] : all.filter((span) => hints.some((h) => lineOf(span).includes(h)));
    const pool = anchored.length > 0 ? anchored : all;
    return pool.find((span) => span.start >= cursor) ?? pool[0] ?? first;
  };

  const medications: OrganizedMedication[] = [];
  let medicationCursor = 0;
  for (const m of capped('medication', answer.medications)) {
    const name = placeFact('medication', m.name, [m.dose, m.when], medicationCursor);
    if (name === null) continue;
    let doseText: string | null = null;
    if (m.dose !== null) {
      const dose = place('medication', m.dose);
      if (dose === null) continue;
      doseText = text.slice(dose.start, dose.end);
    }
    medicationCursor = name.start;
    const w = factWhen('medication', m.when, name.start, m.whenHint ?? null);
    medications.push({ ...name, name: text.slice(name.start, name.end), doseText, action: m.action, at: w.at, atApprox: w.approx });
  }

  const events: OrganizedEvent[] = [];
  let eventCursor = 0;
  for (const e of capped('event', answer.events)) {
    const span = placeFact('event', e.title, [e.when], eventCursor);
    if (span === null) continue;
    eventCursor = span.start;
    const w = factWhen('event', e.when, span.start, e.whenHint ?? null);
    events.push({ ...span, kind: e.kind, title: text.slice(span.start, span.end), at: w.at, atApprox: w.approx });
  }

  // 問題の名前が、問題の一覧と「#問題」の見出しの両方にあるときは、見出しの行の場所にする（その問題の範囲は、見出しから続く S・O・A・P。段3c）
  const headingLines = segments.filter((g) => g.label === 'problem_heading').map((g) => {
    const lineEnd = text.indexOf('\n', g.start);
    return { start: g.start, end: lineEnd < 0 ? g.end : Math.min(lineEnd, g.end) };
  });
  const onHeadingLine = (span: Span): boolean => headingLines.some((h) => span.start >= h.start && span.end <= h.end);
  const problems: OrganizedProblem[] = [];
  let problemCursor = 0;
  for (const p of capped('problem', answer.problems)) {
    const span = placeFact('problem', p.name, [], problemCursor, onHeadingLine);
    if (span === null) continue;
    problemCursor = span.start;
    problems.push({ ...span, name: text.slice(span.start, span.end), status: p.status, activity: p.activity, at });
  }

  // 測定値：検査結果・バイタルの文は、文全体を決定論で読む（AI の指した場所は使わない）。
  // ほかの文は、AI が指した場所だけを、決定論で読む（「K 3.5 を目標に」のような、測定でない数を、AI が指さないことに頼る）
  const observations: OrganizedObservation[] = [];
  if (READ_VALUES_KINDS.includes(kind)) {
    // 文全体を決定論で読む。ただし AI が尿の検査と指した範囲（CD-023）は、その範囲だけを尿の項目の名前で読み直す
    const urine: Span[] = [];
    for (const m of capped('measurement', answer.measurements)) {
      if (m.specimen !== 'urine' || !quoteShapeOk(m.quote)) continue;
      for (let from = 0; ; ) {
        const found = locate(text, folded, m.quote, from);
        if (found === null) break;
        if (!urine.some((u) => u.start === found.start)) {
          urine.push(found);
          break;
        }
        from = found.start + 1;
      }
    }
    const inUrine = (row: LabRow): boolean => urine.some((u) => row.start >= u.start && row.end <= u.end);
    for (const row of readLabText(text).rows) if (!inUrine(row)) observations.push({ row, at: atOfSpan(row.start), origin: 'parser', atApprox: null, readBy: 'rule', unseen: false });
    for (const u of urine) {
      for (const row of readLabText(text.slice(u.start, u.end), { specimen: 'urine' }).rows) observations.push({ row: { ...row, start: row.start + u.start, end: row.end + u.start }, at: atOfSpan(u.start), origin: 'parser', atApprox: null, readBy: 'rule', unseen: false });
    }
    observations.sort((a, b) => a.row.start - b.row.start);
  } else {
    const used: Span[] = [];
    for (const m of capped('measurement', answer.measurements)) {
      // 同じ引用が、文に何度も出るとき（時刻の違う同じ測定）は、まだ使っていない場所を、順に使う。
      // AI が読んだ値（推移の「12.4→6.8」を日時ごとに分けたものなど）は、同じ場所を使い直してよい
      let span: Span | null = null;
      if (quoteShapeOk(m.quote)) {
        let from = 0;
        let firstFound: Span | null = null;
        for (;;) {
          const found = locate(text, folded, m.quote, from);
          if (found === null) break;
          firstFound ??= found;
          if (!used.some((u) => u.start === found.start)) {
            span = found;
            break;
          }
          from = found.start + 1;
        }
        if (span === null && (m.values?.length ?? 0) > 0) span = firstFound;
        if (span === null) count(report, 'measurement', 'not_found');
      } else count(report, 'measurement', 'bad_quote');
      if (span === null) continue;
      if (findShapes(text.slice(span.start, span.end)).length > 0) {
        count(report, 'measurement', 'shape');
        continue;
      }
      used.push(span);
      const quoteText = text.slice(span.start, span.end);
      const read = readLabText(quoteText, { specimen: m.specimen });
      const ruleOk = read.rows.length > 0 && !read.unread.some((u) => u.reason !== 'unknown' && u.reason !== 'flag');
      const w = factWhen('measurement', m.when, span.start, m.whenHint ?? null);
      if (ruleOk) {
        for (const row of read.rows) observations.push({ row: { ...row, start: row.start + span.start, end: row.end + span.start }, at: w.at, origin: 'ai', atApprox: w.approx, readBy: 'rule', unseen: false });
        continue;
      }
      // 字を規則で読めない引用（「熱は38.5℃まで上昇」）：AI が読んだ項目と値を使う（CA-056）。読めた行は残し、足りない分を AI の値で補う
      const aiRows = (m.values ?? []).flatMap((v) => aiValueRows(v, m.specimen)).filter((r) => !read.rows.some((x) => (x.name ?? x.nameRaw) === (r.name ?? r.nameRaw)));
      for (const row of read.rows) observations.push({ row: { ...row, start: row.start + span.start, end: row.end + span.start }, at: w.at, origin: 'ai', atApprox: w.approx, readBy: 'rule', unseen: false });
      for (const row of aiRows) observations.push({ row: { ...row, start: span.start, end: span.end }, at: w.at, origin: 'ai', atApprox: w.approx, readBy: 'ai', unseen: !numbersSeen(row.valueText, quoteText) });
      if (read.rows.length === 0 && aiRows.length === 0) count(report, 'measurement', 'unread');
    }
  }

  // 経過の出来事（CA-056）
  const course: OrganizedCourse[] = [];
  const seenCourse = new Set<string>();
  for (const c of capped('course', answer.course ?? [])) {
    const span = place('course', c.quote);
    if (span === null) continue;
    const quoteText = text.slice(span.start, span.end);
    let summary = replaceShapes(c.summary.replace(/\s+/gu, ' ').trim()).text;
    if (summary === '' || summary.length > COURSE_SUMMARY_MAX || !numbersSeen(summary, quoteText)) {
      if (summary !== '' && !numbersSeen(summary, quoteText)) count(report, 'course', 'summary_number');
      summary = quoteText.slice(0, COURSE_SUMMARY_MAX);
    }
    const key = `${String(span.start)}:${summary}`;
    if (seenCourse.has(key)) continue;
    seenCourse.add(key);
    const w = factWhen('course', c.when, span.start, c.whenHint ?? null);
    course.push({ ...span, category: c.category, summary, at: w.at, atApprox: w.approx });
  }

  return { kind, at, segments, medications, events, problems, observations, course, report };
}

/** 確かめられなかった件数の合計 */
export function reportTotal(report: OrganizeReport): number {
  let n = 0;
  for (const reasons of Object.values(report)) for (const v of Object.values(reasons)) n += v;
  return n;
}

/** 数をそろえる（全角は半角に。先頭・末尾の 0 の違いは同じ数） */
const numbersOf = (text: string): string[] =>
  [...text.replace(/[０-９]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/．/gu, '.').matchAll(/\d+(?:\.\d+)?/gu)].map((m) => String(Number(m[0])));

/** 文の中の数が、すべて引用の字にあるか */
export function numbersSeen(text: string, quote: string): boolean {
  const inQuote = new Set(numbersOf(quote));
  return numbersOf(text).every((n) => inQuote.has(n));
}

/**
 * AI が読んだ項目と値を、測定値の行にする（CA-056）。名前と値を「名前 値 単位」の文にして、決定論の読み取りに通す（項目の名前は、ほかの値と同じ表で正規化する）。
 * 表にない名前は「名前: 値」で読む（名前は null）。読めなければ行にしない
 */
function aiValueRows(v: AiValue, specimen: 'urine' | null): LabRow[] {
  const name = v.name.trim().slice(0, 40);
  const value = v.value.trim().slice(0, 40);
  if (name === '' || value === '' || findShapes(`${name} ${value}`).length > 0) return [];
  const text = `${name} ${v.comparator ?? ''}${value}${v.unit === null || v.unit.trim() === '' ? '' : ` ${v.unit.trim().slice(0, 20)}`}`;
  const first = readLabText(text, { specimen });
  if (first.rows.length > 0) return [...first.rows];
  return [...readLabText(`${name}: ${v.comparator ?? ''}${value}`, { specimen }).rows];
}
