// 段K6：結果待ちを追う（CA-058 の A3。CA-065。2026-11-22）。「提出した・依頼した」と書かれた検査のうち、結果の記載がまだ記録にないものの一覧。
// 警告ではなく、記録の状態の一覧（CA-059：印・色はよい。画面の外への知らせは作らない）。
//
// 提出と結果を結びつけるには読みが要るので、AI に、患者ごとに1回、**記号だけ**を返させる（つなぎ〔段3a〕と同じ考え）。AI は文を書かない。
// 名前・日時・引用は、記録に書かれたもの（できごとの題・経過の出来事の要約と、その字）から決める。
//
// この組は純関数：
// - 範囲（recentEncounters）：いまの受診（いちばん新しい受診）と、その直前の救急の受診（いまの受診の始まりの前の日から）
// - 資料（pendingMaterial）：提出の候補（できごとの「検査の実施」E…・経過の出来事の「検査」C…）と、結果になりうるもの
//   （できごと E…・経過の出来事 C…・検査値とバイタルの、項目と日ごとのまとまり V…）。長いときは、候補でない古いものから落とし、数を返す
// - AI の答えの形（PendingAnswer。構造化出力の上限の中：null になりうる欄・必須でない欄は 0）
// - 確かめ（checkPending）：記号が資料にある・候補の記号である・同じ候補は1回・結果は提出より前でない・自分自身でない。通らないものは理由ごとに数える。
//   「結果あり」と言ったのに確かめられる結果が1つもない候補と、AI が振り分けなかった候補は、「振り分けられなかった」として名前を残す（黙って捨てない）
// - 指示簿の検査の予定（段K11。CA-078）：指示簿の候補 O… も、同じ1回で渡し、後の記録の結果の記載を結びつける。結びつけは PendingBody.orders に分けて持ち、
//   結果待ちの一覧（items）には出さない（提出の記載ではなく、指示の予定なので。指示簿の項目の下に出す）
// - 先生の印（結果を確かめた・外す）：組み直しても、同じ記載の同じ場所の項目に引き継ぐ（carryPendingMarks）
import { z } from 'zod';

import { COURSE_CATEGORY_NAMES, type CourseCategory, EVENT_KIND_NAMES, type EventKind } from '../organize/answer.ts';
import type { PendingOrder } from '../orders/board.ts';
import { listBasis } from '../problems/list.ts';
import { type EncounterKind, SOURCE_KIND_LABELS, type SourceKind } from '../record/schema.ts';
import { compareDateTime, daysBetween } from '../time/datetime.ts';

// ---------------------------------------------------------------------------
// 範囲

export interface ScopeEncounter {
  readonly id: string;
  readonly kind: EncounterKind;
  readonly start: string;
  readonly end: string | null;
}

/** いまの受診（始まりのいちばん新しい受診）と、その直前の救急の受診（いまの受診の始まりの前の日から、その日まで）。古い順 */
export function recentEncounters<T extends ScopeEncounter>(encounters: readonly T[]): T[] {
  const sorted = [...encounters].sort((a, b) => compareDateTime(a.start, b.start) || a.id.localeCompare(b.id));
  const current = sorted.at(-1);
  if (current === undefined) return [];
  const start = current.start.slice(0, 10);
  const prior = sorted.filter((e) => e.id !== current.id && e.kind === 'er' && e.start.slice(0, 10) <= start && daysBetween(e.start.slice(0, 10), start) <= 1);
  return [...prior, current];
}

// ---------------------------------------------------------------------------
// 上限

/** 資料の長さの上限（字。JSON の長さ） */
export const PENDING_MATERIAL_MAX = 60_000;
/** 提出の候補の数（新しいものから） */
export const PENDING_CANDIDATES_MAX = 60;
/** 1つの候補に結びつける結果の数 */
export const PENDING_RESULTS_MAX = 6;
/** 資料に入れる引用の長さ */
export const PENDING_QUOTE_MAX = 160;
/** 指示簿の検査の候補の数（段K11。予定の日時の新しいものから） */
export const PENDING_ORDERS_MAX = 40;

// ---------------------------------------------------------------------------
// 資料

export interface PendingSource {
  readonly id: string;
  readonly encounterId: string;
  readonly kind: SourceKind;
  readonly at: string | null;
  readonly text: string;
}

export interface PendingEvent {
  readonly sourceId: string;
  readonly encounterId: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
  readonly atApprox?: string | null;
  readonly start: number;
  readonly end: number;
}

export interface PendingCourse {
  readonly sourceId: string;
  readonly encounterId: string;
  readonly category: CourseCategory;
  readonly summary: string;
  readonly at: string | null;
  readonly atApprox: string | null;
  readonly start: number;
  readonly end: number;
}

export interface PendingObservation {
  readonly sourceId: string;
  readonly encounterId: string;
  readonly name: string | null;
  readonly nameRaw: string;
  readonly kind: 'lab' | 'vital' | null;
  readonly comparator?: string | null;
  readonly valueText: string;
  readonly unit: string | null;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
}

/** 呼ぶ側が、外した事実・字に見つからない AI の数を除いてから渡す */
export interface PendingInput {
  readonly encounters: readonly ScopeEncounter[];
  readonly sources: readonly PendingSource[];
  readonly events: readonly PendingEvent[];
  readonly course: readonly PendingCourse[];
  readonly observations: readonly PendingObservation[];
  /** 指示簿の検査の予定（段K11。なければ []） */
  readonly orders?: readonly PendingOrder[];
}

/** 記録の中の場所（文の id と字の範囲。整理し直すと事実の id が変わるので、場所で持つ） */
export const PendingPointer = z.object({ sourceId: z.string(), start: z.number(), end: z.number() });
export type PendingPointer = z.infer<typeof PendingPointer>;

export const PENDING_RESULT_KINDS = ['event', 'course', 'value'] as const;
export type PendingResultKind = (typeof PENDING_RESULT_KINDS)[number];

/** 結果の記載（画面に出す短い名前と、元の字の場所） */
export const PendingResult = PendingPointer.extend({ kind: z.enum(PENDING_RESULT_KINDS), label: z.string(), at: z.string().nullable() });
export type PendingResult = z.infer<typeof PendingResult>;

interface Candidate extends PendingPointer {
  readonly kind: 'event' | 'course';
  readonly name: string;
  readonly at: string | null;
  readonly atApprox: string | null;
}

export interface PendingMaterial {
  /** AI に送る資料（JSON にして送る） */
  readonly payload: Record<string, unknown>;
  /** 提出の候補（E…・C…） */
  readonly candidates: ReadonlyMap<string, Candidate>;
  /** 結果になりうるもの（E…・C…・V…。候補も含む） */
  readonly items: ReadonlyMap<string, PendingResult>;
  /** 指示簿の検査の候補（O…。段K11） */
  readonly orderCandidates: ReadonlyMap<string, PendingOrder>;
  /** 長さ・数の上限で落とした数 */
  readonly dropped: { readonly candidates: number; readonly results: number };
}

const show = (at: string | null): string => (at === null ? '日時不明' : at.replace('T', ' '));
const sameSpan = (a: PendingPointer, b: PendingPointer): boolean => a.sourceId === b.sourceId && a.start < b.end && b.start < a.end;

interface ValueGroup extends PendingPointer {
  readonly name: string;
  readonly day: string | null;
  readonly at: string | null;
  readonly values: readonly string[];
}

/** 値は、項目と日ごとにまとめる（「CRP 11/22」）。場所は、その日のいちばん早い値 */
function valueGroups(observations: readonly PendingObservation[]): ValueGroup[] {
  const groups = new Map<string, PendingObservation[]>();
  for (const o of [...observations].sort((a, b) => compareDateTime(a.at, b.at))) {
    const name = o.name ?? o.nameRaw;
    const key = `${name}|${o.at === null ? '' : o.at.slice(0, 10)}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups.values()].map((list) => {
    const first = list[0] as PendingObservation;
    return {
      name: first.name ?? first.nameRaw,
      day: first.at === null ? null : first.at.slice(0, 10),
      at: first.at,
      values: list.map((o) => `${o.at !== null && o.at.length > 10 ? `${o.at.slice(11)} ` : ''}${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`),
      sourceId: first.sourceId,
      start: first.start,
      end: first.end,
    };
  });
}

export function pendingMaterial(input: PendingInput): PendingMaterial {
  const scope = recentEncounters(input.encounters);
  const ids = new Set(scope.map((e) => e.id));
  const current = scope.at(-1);
  const textOf = new Map(input.sources.map((s) => [s.id, s.text]));
  const sourceOf = new Map(input.sources.map((s) => [s.id, s]));
  const quote = (p: PendingPointer): string => (textOf.get(p.sourceId) ?? '').slice(p.start, p.end).replace(/\s+/gu, ' ').trim().slice(0, PENDING_QUOTE_MAX);
  const from = (sourceId: string): string => {
    const s = sourceOf.get(sourceId);
    return s === undefined ? '' : `${SOURCE_KIND_LABELS[s.kind]} ${show(s.at)}`;
  };

  const events = input.events.filter((e) => ids.has(e.encounterId)).sort((a, b) => compareDateTime(a.at, b.at) || a.start - b.start);
  const course = input.course.filter((c) => ids.has(c.encounterId)).sort((a, b) => compareDateTime(a.at, b.at) || a.start - b.start);
  const values = valueGroups(input.observations.filter((o) => ids.has(o.encounterId)));
  const orderList = (input.orders ?? [])
    .filter((o) => ids.has(o.encounterId))
    .sort((a, b) => compareDateTime(a.at, b.at) || a.id.localeCompare(b.id))
    .slice(-PENDING_ORDERS_MAX);
  const orderRefs = new Map(orderList.map((o, i) => [`O${String(i + 1)}`, o]));

  // 提出の候補：できごとの「検査の実施」と、経過の出来事の「検査」（新しいものから決まった数）
  const allCandidates = [
    ...events.filter((e) => e.kind === 'test').map((e) => ({ kind: 'event' as const, fact: e })),
    ...course.filter((c) => c.category === 'test').map((c) => ({ kind: 'course' as const, fact: c })),
  ].sort((a, b) => compareDateTime(a.fact.at, b.fact.at));
  const keptCandidates = new Set(allCandidates.slice(-PENDING_CANDIDATES_MAX).map((c) => c.fact));
  const droppedCandidates = allCandidates.length - keptCandidates.size;

  // 長さの上限：候補でない、古いものから落とす（値 → 経過の出来事 → できごと）
  let vals = values;
  let crs = course.filter((c) => c.category !== 'test' || keptCandidates.has(c));
  let evs = events.filter((e) => e.kind !== 'test' || keptCandidates.has(e));
  // 数の上限で落とした候補は、候補の数にだけ数える（結果としても資料に入れない）
  let droppedResults = 0;

  const build = () => {
    const eventRefs = new Map(evs.map((e, i) => [`E${String(i + 1)}`, e]));
    const courseRefs = new Map(crs.map((c, i) => [`C${String(i + 1)}`, c]));
    const valueRefs = new Map(vals.map((v, i) => [`V${String(i + 1)}`, v]));
    const submitted = [...[...eventRefs].filter(([, e]) => e.kind === 'test'), ...[...courseRefs].filter(([, c]) => c.category === 'test')].map(([ref]) => ref);
    const payload = {
      encounter: current === undefined ? null : { kind: { er: '救急', outpatient: '外来', inpatient: '入院' }[current.kind], start: show(current.start), end: current.end === null ? null : show(current.end) },
      submitted,
      events: [...eventRefs].map(([ref, e]) => ({ ref, at: show(e.at), approx: e.atApprox ?? null, kind: EVENT_KIND_NAMES[e.kind], title: e.title, quote: quote(e), from: from(e.sourceId) })),
      course: [...courseRefs].map(([ref, c]) => ({ ref, at: show(c.at), approx: c.atApprox, category: COURSE_CATEGORY_NAMES[c.category], summary: c.summary, quote: quote(c), from: from(c.sourceId) })),
      values: [...valueRefs].map(([ref, v]) => ({ ref, name: v.name, day: v.day ?? '日時不明', values: v.values.join('、') })),
      // 指示簿の検査の予定（段K11）：あるときだけ
      ...(orderRefs.size === 0 ? {} : { orders: [...orderRefs].map(([ref, o]) => ({ ref, name: o.name, interval: o.interval, at: show(o.at) })) }),
    };
    return { payload, eventRefs, courseRefs, valueRefs };
  };
  let built = build();
  const removable = <T>(list: readonly T[], keep: (x: T) => boolean): number => list.findIndex((x) => !keep(x));
  while (JSON.stringify(built.payload).length > PENDING_MATERIAL_MAX) {
    if (vals.length > 0) vals = vals.slice(1);
    else {
      const ci = removable(crs, (c) => c.category === 'test');
      const ei = removable(evs, (e) => e.kind === 'test');
      if (ci >= 0) crs = [...crs.slice(0, ci), ...crs.slice(ci + 1)];
      else if (ei >= 0) evs = [...evs.slice(0, ei), ...evs.slice(ei + 1)];
      else break;
    }
    droppedResults += 1;
    built = build();
  }

  const candidates = new Map<string, Candidate>();
  const items = new Map<string, PendingResult>();
  for (const [ref, e] of built.eventRefs) {
    items.set(ref, { kind: 'event', sourceId: e.sourceId, start: e.start, end: e.end, label: `${EVENT_KIND_NAMES[e.kind]}「${e.title}」`, at: e.at });
    if (e.kind === 'test') candidates.set(ref, { kind: 'event', sourceId: e.sourceId, start: e.start, end: e.end, name: e.title, at: e.at, atApprox: e.atApprox ?? null });
  }
  for (const [ref, c] of built.courseRefs) {
    items.set(ref, { kind: 'course', sourceId: c.sourceId, start: c.start, end: c.end, label: `経過「${c.summary}」`, at: c.at });
    if (c.category === 'test') candidates.set(ref, { kind: 'course', sourceId: c.sourceId, start: c.start, end: c.end, name: c.summary, at: c.at, atApprox: c.atApprox });
  }
  for (const [ref, v] of built.valueRefs) items.set(ref, { kind: 'value', sourceId: v.sourceId, start: v.start, end: v.end, label: `値 ${v.name}（${v.day ?? '日時不明'}）${v.values.join('、')}`, at: v.at });
  return { payload: built.payload, candidates, items, orderCandidates: orderRefs, dropped: { candidates: droppedCandidates, results: droppedResults } };
}

// ---------------------------------------------------------------------------
// AI の答えの形（記号と状態だけ。文を書かせない）

export const PENDING_STATUSES = ['resulted', 'pending', 'not_a_submission'] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];
export const PENDING_STATUS_NAMES: Readonly<Record<PendingStatus, string>> = { resulted: '結果の記載がある', pending: '結果待ち', not_a_submission: '提出ではない' };

export const PendingAnswer = z.object({
  items: z.array(
    z.object({
      /** 提出の候補の記号（E…・C…） */
      id: z.string(),
      status: z.enum(PENDING_STATUSES),
      /** 結果が書かれた記号（resulted のときだけ。ほかは []） */
      results: z.array(z.string()),
    }),
  ),
});
export type PendingAnswer = z.infer<typeof PendingAnswer>;

// ---------------------------------------------------------------------------
// 確かめた後の形（保存する形）

/** 先生の印：なし・結果を確かめた・外す */
export const PENDING_MARKS = ['none', 'checked', 'hidden'] as const;
export type PendingMark = (typeof PENDING_MARKS)[number];
export const PENDING_MARK_NAMES: Readonly<Record<PendingMark, string>> = { none: '印なし', checked: '結果を確かめた', hidden: '外した' };

/** 項目の状態：結果待ち・結果の記載がある・振り分けられなかった（AI が振り分けなかった、または結果を確かめられなかった） */
export const PENDING_ITEM_STATES = ['pending', 'resulted', 'unsorted'] as const;
export type PendingItemState = (typeof PENDING_ITEM_STATES)[number];

export const PendingItem = PendingPointer.extend({
  /** 組み直しても同じ項目と分かる鍵（種類・文の id・場所） */
  key: z.string(),
  kind: z.enum(['event', 'course']),
  /** 記録に書かれた名前（できごとの題・経過の出来事の要約） */
  name: z.string(),
  at: z.string().nullable(),
  atApprox: z.string().nullable(),
  state: z.enum(PENDING_ITEM_STATES),
  results: z.array(PendingResult),
  mark: z.enum(PENDING_MARKS),
});
export type PendingItem = z.infer<typeof PendingItem>;

export const PENDING_REJECT_REASONS = ['unknown_ref', 'not_candidate', 'duplicate', 'unknown_result', 'earlier_result', 'self_result', 'no_result', 'too_many'] as const;
export type PendingRejectReason = (typeof PENDING_REJECT_REASONS)[number];
export const PENDING_REJECT_NAMES: Readonly<Record<PendingRejectReason, string>> = {
  unknown_ref: '資料にない記号を指していた',
  not_candidate: '提出の候補でない記号だった',
  duplicate: '同じ候補が重なった',
  unknown_result: '結果に、資料にない記号を指していた',
  earlier_result: '結果が、提出より前の記載だった',
  self_result: '結果に、提出の記載そのものを指していた',
  no_result: '「結果あり」と言ったが、確かめられる結果がなかった',
  too_many: '結果が多すぎた',
};

/** 指示簿の検査の予定への結びつけ（段K11）。結果待ちの一覧とは分けて、指示簿の項目の下に出す */
export const PendingOrderLink = z.object({
  orderId: z.string(),
  state: z.enum(PENDING_ITEM_STATES),
  results: z.array(PendingResult),
});
export type PendingOrderLink = z.infer<typeof PendingOrderLink>;

export const PendingBody = z.object({
  items: z.array(PendingItem),
  /** 指示簿の検査の予定への結びつけ（段K11。前の版の一覧にはないので、ないときは []） */
  orders: z.array(PendingOrderLink).default([]),
  /** 「提出ではない」と振り分けた候補の数（名前は出さない：検査をその場で行った記載などで、結果待ちではない） */
  notSubmission: z.number(),
  rejected: z.partialRecord(z.enum(PENDING_REJECT_REASONS), z.number()),
  dropped: z.object({ candidates: z.number(), results: z.number() }),
});
export type PendingBody = z.infer<typeof PendingBody>;

export const pendingKey = (kind: 'event' | 'course', p: PendingPointer): string => `${kind}:${p.sourceId}:${String(p.start)}`;

/** 結果は、提出より前でない（どちらも時刻があれば時刻で、そうでなければ日で比べる。日時の分からないものは比べない） */
export function notBefore(result: string | null, submitted: string | null): boolean {
  if (result === null || submitted === null) return true;
  if (result.length > 10 && submitted.length > 10) return result >= submitted;
  return result.slice(0, 10) >= submitted.slice(0, 10);
}

export interface CheckedPending {
  readonly items: readonly PendingItem[];
  readonly orders: readonly PendingOrderLink[];
  readonly notSubmission: number;
  readonly rejected: Partial<Record<PendingRejectReason, number>>;
}

/** AI の答えを確かめる。印は、まだ付けない（carryPendingMarks で引き継ぐ） */
export function checkPending(answer: PendingAnswer, material: PendingMaterial): CheckedPending {
  const rejected: Partial<Record<PendingRejectReason, number>> = {};
  const count = (r: PendingRejectReason): void => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  const decided = new Map<string, { state: PendingItemState | 'not_submission'; results: PendingResult[] }>();
  const orderDecided = new Map<string, { state: PendingItemState; results: PendingResult[] }>();
  let notSubmission = 0;
  for (const a of answer.items) {
    // 指示簿の検査の予定（O…）：結果の記載があるか、まだないか（「提出ではない」は、まだないと同じに扱う）
    const order = material.orderCandidates.get(a.id);
    if (order !== undefined) {
      if (orderDecided.has(a.id)) {
        count('duplicate');
        continue;
      }
      if (a.status !== 'resulted') {
        orderDecided.set(a.id, { state: 'pending', results: [] });
        continue;
      }
      const results: PendingResult[] = [];
      for (const r of [...new Set(a.results)]) {
        const item = material.items.get(r);
        if (item === undefined) {
          count('unknown_result');
          continue;
        }
        if (!notBefore(item.at, order.at)) {
          count('earlier_result');
          continue;
        }
        if (results.length >= PENDING_RESULTS_MAX) {
          count('too_many');
          continue;
        }
        results.push(item);
      }
      if (results.length === 0) count('no_result');
      orderDecided.set(a.id, results.length === 0 ? { state: 'unsorted', results: [] } : { state: 'resulted', results: results.sort((x, y) => compareDateTime(x.at, y.at)) });
      continue;
    }
    const candidate = material.candidates.get(a.id);
    if (candidate === undefined) {
      count(material.items.has(a.id) ? 'not_candidate' : 'unknown_ref');
      continue;
    }
    if (decided.has(a.id)) {
      count('duplicate');
      continue;
    }
    if (a.status === 'not_a_submission') {
      notSubmission += 1;
      decided.set(a.id, { state: 'not_submission', results: [] });
      continue;
    }
    if (a.status === 'pending') {
      decided.set(a.id, { state: 'pending', results: [] });
      continue;
    }
    const results: PendingResult[] = [];
    for (const r of [...new Set(a.results)]) {
      const item = material.items.get(r);
      if (item === undefined) {
        count('unknown_result');
        continue;
      }
      if (r === a.id || (item.kind !== 'value' && sameSpan(item, candidate))) {
        count('self_result');
        continue;
      }
      if (!notBefore(item.at, candidate.at)) {
        count('earlier_result');
        continue;
      }
      if (results.length >= PENDING_RESULTS_MAX) {
        count('too_many');
        continue;
      }
      results.push(item);
    }
    if (results.length === 0) {
      count('no_result');
      decided.set(a.id, { state: 'unsorted', results: [] });
      continue;
    }
    decided.set(a.id, { state: 'resulted', results: results.sort((x, y) => compareDateTime(x.at, y.at)) });
  }
  const items: PendingItem[] = [];
  for (const [ref, c] of material.candidates) {
    const d = decided.get(ref) ?? { state: 'unsorted' as const, results: [] };
    // 「提出ではない」は、一覧に出さない（数だけ）
    if (d.state === 'not_submission') continue;
    items.push({ key: pendingKey(c.kind, c), kind: c.kind, sourceId: c.sourceId, start: c.start, end: c.end, name: c.name, at: c.at, atApprox: c.atApprox, state: d.state, results: d.results, mark: 'none' });
  }
  // 日時の順。同じ日時は、書かれた順（同じ記載なら前の字から）
  items.sort((a, b) => compareDateTime(a.at, b.at) || a.sourceId.localeCompare(b.sourceId) || a.start - b.start || a.kind.localeCompare(b.kind));
  const orders: PendingOrderLink[] = [...material.orderCandidates].map(([ref, o]) => ({ orderId: o.id, ...(orderDecided.get(ref) ?? { state: 'unsorted' as const, results: [] }) }));
  return { items, orders, notSubmission, rejected };
}

/** 組み直した一覧に、前の一覧の先生の印を引き継ぐ（同じ鍵：同じ記載の同じ場所の、同じ種類の候補） */
export function carryPendingMarks(items: readonly PendingItem[], previous: readonly PendingItem[]): PendingItem[] {
  const marks = new Map(previous.map((p) => [p.key, p.mark]));
  return items.map((item) => ({ ...item, mark: marks.get(item.key) ?? 'none' }));
}

/** 先生の印（ボタンだけ。打つ欄はない） */
export const PendingPatch = z.strictObject({ key: z.string().min(1).max(200), mark: z.enum(PENDING_MARKS) });
export type PendingPatch = z.infer<typeof PendingPatch>;

/** 印を当てる（純関数）。鍵がなければ null */
export function applyPendingMark(items: readonly PendingItem[], patch: PendingPatch): PendingItem[] | null {
  const i = items.findIndex((x) => x.key === patch.key);
  const item = items[i];
  if (item === undefined) return null;
  const next = [...items];
  next[i] = { ...item, mark: patch.mark };
  return next;
}

/** 一覧の元になった記録の印（プロブレムリストと同じ：記載の数・整理の終わった数・最後の記載）。
 *  指示簿の検査の予定（段K11）があれば、その id と直した日時も（入れた・直したら組み直す）。なければ、前の版と同じ印 */
export function pendingBasis(sources: Parameters<typeof listBasis>[0], orders: readonly Pick<PendingOrder, 'id' | 'stamp'>[] = []): string {
  const base = listBasis(sources);
  if (orders.length === 0) return base;
  return `${base}|o:${[...orders].map((o) => `${o.id}@${o.stamp}`).sort().join(',')}`;
}

/** 提出の候補（指示簿の検査の予定を含む）が範囲にあるか（ないときは、AI を呼ばない） */
export function hasPendingCandidates(input: Pick<PendingInput, 'encounters' | 'events' | 'course' | 'orders'>): boolean {
  const ids = new Set(recentEncounters(input.encounters).map((e) => e.id));
  return (
    input.events.some((e) => ids.has(e.encounterId) && e.kind === 'test') ||
    input.course.some((c) => ids.has(c.encounterId) && c.category === 'test') ||
    (input.orders ?? []).some((o) => ids.has(o.encounterId))
  );
}
