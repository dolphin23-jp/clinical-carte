// 段K9：予定と実施の突き合わせ（CA-058 の B2。CA-071。CA-026 の改訂）。A/P に書いた予定の行ごとに、その後の記録に、
// 行ったことの記載（できごと・薬・経過の出来事・値）が見つかったかを並べる。ToDo の表は作らない（記録から作る見方）。
// 警告ではなく、記録の状態の一覧（CA-059：印・色はよい。画面の外への知らせは作らない）。
//
// 予定と実施を結びつけるには読みが要るので、AI に、患者ごとに1回、**記号だけ**を返させる（結果待ち〔段K6〕と同じ考え）。AI は文を書かない。
// 予定の字・日時は、記録に書かれたもの（保存した文の P・A/P の区切りの行と、その記載の日時）。予定の日は、AI の「基準とずれ」から決定論で計算する（time/hint.ts）。
//
// この組は純関数：
// - 範囲：結果待ちと同じ（recentEncounters：いまの受診と、直前の救急の受診）
// - 資料（planMaterial）：予定の行の候補（P・A/P の区切りを行と文に分けたもの P…）と、実施になりうる記録
//   （できごと E…・薬 M…・経過の出来事 C…・記載ごとの値 V…）。長いときは古い記録から落とし、数を返す
// - AI の答えの形（PlanAnswer。構造化出力の上限の中：null になりうる欄・必須でない欄は 0）
// - 確かめ（checkPlans）：記号が資料にある・予定の記号である・同じ予定は1回・実施は予定より前でない・予定と同じ記載でない・予定の日は予定の記載より前でない。
//   通らないものは理由ごとに数える。「実施あり」と言ったのに確かめられる実施が1つもない予定と、AI が振り分けなかった予定は、「振り分けられなかった」として字を残す
// - 先生の印（実施を確かめた・中止・不要・外す）：組み直しても、同じ記載の同じ場所の行に引き継ぐ（carryPlanMarks）
import { z } from 'zod';

import { EVENT_KIND_NAMES, type EventKind, hintFromWire, MEDICATION_ACTION_NAMES, type MedicationAction, type SegmentLabel, WhenHintWire, COURSE_CATEGORY_NAMES, type CourseCategory } from '../organize/answer.ts';
import { notBefore, recentEncounters, type ScopeEncounter } from '../pending/pending.ts';
import { listBasis } from '../problems/list.ts';
import { sharedPlanSegments } from '../problems/threads.ts';
import { SOURCE_KIND_LABELS, type SourceKind } from '../record/schema.ts';
import { compareDateTime } from '../time/datetime.ts';
import { resolveHint } from '../time/hint.ts';

// ---------------------------------------------------------------------------
// 上限

/** 資料の長さの上限（字。JSON の長さ） */
export const PLAN_MATERIAL_MAX = 60_000;
/** 予定の行の候補の数（新しいものから） */
export const PLAN_CANDIDATES_MAX = 80;
/** 1つの予定に結びつける実施の数 */
export const PLAN_DONE_MAX = 6;
/** 資料に入れる引用・予定の行の長さ */
export const PLAN_QUOTE_MAX = 160;
/** 1つの記載の値を、資料に並べる数 */
const VALUES_PER_SOURCE = 16;

// ---------------------------------------------------------------------------
// 入力

export interface PlanSource {
  readonly id: string;
  readonly encounterId: string;
  readonly kind: SourceKind;
  readonly at: string | null;
  readonly text: string;
}

export interface PlanSegment {
  readonly sourceId: string;
  readonly label: SegmentLabel;
  readonly start: number;
  readonly end: number;
}

interface Spanned {
  readonly sourceId: string;
  readonly encounterId: string;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
}

export interface PlanEvent extends Spanned {
  readonly kind: EventKind;
  readonly title: string;
  readonly atApprox?: string | null;
}

export interface PlanMedication extends Spanned {
  readonly name: string;
  readonly doseText: string | null;
  readonly action: MedicationAction | null;
  readonly atApprox?: string | null;
}

export interface PlanCourse extends Spanned {
  readonly category: CourseCategory;
  readonly summary: string;
  readonly atApprox: string | null;
}

export interface PlanObservation extends Spanned {
  readonly name: string | null;
  readonly nameRaw: string;
  readonly comparator?: string | null;
  readonly valueText: string;
  readonly unit: string | null;
}

/** 呼ぶ側が、外した事実・字に見つからない AI の数を除いてから渡す */
export interface PlanInput {
  readonly encounters: readonly ScopeEncounter[];
  readonly sources: readonly PlanSource[];
  readonly segments: readonly PlanSegment[];
  readonly events: readonly PlanEvent[];
  readonly medications: readonly PlanMedication[];
  readonly course: readonly PlanCourse[];
  readonly observations: readonly PlanObservation[];
}

/** 記録の中の場所（文の id と字の範囲） */
export const PlanPointer = z.object({ sourceId: z.string(), start: z.number(), end: z.number() });
export type PlanPointer = z.infer<typeof PlanPointer>;

export const PLAN_DONE_KINDS = ['event', 'medication', 'course', 'value'] as const;
export type PlanDoneKind = (typeof PLAN_DONE_KINDS)[number];

/** 実施の記載（画面に出す短い名前と、元の字の場所） */
export const PlanDone = PlanPointer.extend({ kind: z.enum(PLAN_DONE_KINDS), label: z.string(), at: z.string().nullable() });
export type PlanDone = z.infer<typeof PlanDone>;

// ---------------------------------------------------------------------------
// 予定の行（P・A/P の区切りを、行と文に分ける。決定論）

const PLAN_LABELS: readonly SegmentLabel[] = ['plan', 'assessment_plan'];
/** 行の頭の印（箇条の記号・「P)」「方針：」などの見出し）。行の字には含めない（場所は、その後ろから） */
const LEAD = /^(?:[\s・\-－*＊●○◯▶►>＞→⇒]+|(?:A\/P|Ａ／Ｐ|AP|P|Ｐ|Plan|plan|方針|予定)\s*[)）:：]\s*)+/u;

export interface PlanLine extends PlanPointer {
  readonly encounterId: string;
  readonly at: string | null;
  /** 記載の字（その場所の字そのまま） */
  readonly text: string;
  /** 同じ記載で、この行の前にある「#問題」の見出しの1行（記載全体の P・見出しがなければ ""） */
  readonly problem: string;
}

/** 区切りの字を、行（改行）と文（「。」）に分ける。空の行・記号だけの行は除く */
export function splitPlanLines(text: string, start: number, end: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const body = text.slice(start, end);
  const pieces = /[^\n。]+。?/gu;
  for (const m of body.matchAll(pieces)) {
    let s = start + m.index;
    let e = s + m[0].length;
    const lead = LEAD.exec(text.slice(s, e));
    if (lead !== null) s += lead[0].length;
    while (e > s && /\s/u.test(text.charAt(e - 1))) e -= 1;
    const piece = text.slice(s, e);
    // 字の数が2つ未満・文字のない行（記号だけ）は、予定の行にしない
    if (piece.replace(/[\s。、.,・]/gu, '').length < 2 || !/[\p{L}\p{N}]/u.test(piece)) continue;
    out.push({ start: s, end: e });
  }
  return out;
}

/** 範囲の受診の、P・A/P の区切りの行（古い順） */
export function planLines(input: Pick<PlanInput, 'encounters' | 'sources' | 'segments'>): PlanLine[] {
  const ids = new Set(recentEncounters(input.encounters).map((e) => e.id));
  const sourceOf = new Map(input.sources.filter((s) => ids.has(s.encounterId)).map((s) => [s.id, s]));
  const segments = input.segments.filter((g) => sourceOf.has(g.sourceId));
  const shared = new Set(sharedPlanSegments(segments).map((g) => `${g.sourceId}:${String(g.start)}`));
  const bySource = new Map<string, PlanSegment[]>();
  for (const g of segments) bySource.set(g.sourceId, [...(bySource.get(g.sourceId) ?? []), g]);
  const out: PlanLine[] = [];
  for (const [sourceId, list] of bySource) {
    const source = sourceOf.get(sourceId);
    if (source === undefined) continue;
    const sorted = [...list].sort((a, b) => a.start - b.start);
    let heading = '';
    for (const g of sorted) {
      if (g.label === 'problem_heading') {
        heading = (source.text.slice(g.start, g.end).split('\n')[0] ?? '').trim().slice(0, 60);
        continue;
      }
      if (!PLAN_LABELS.includes(g.label)) continue;
      const problem = shared.has(`${g.sourceId}:${String(g.start)}`) ? '' : heading;
      for (const line of splitPlanLines(source.text, g.start, Math.min(g.end, source.text.length))) {
        out.push({ sourceId, encounterId: source.encounterId, at: source.at, start: line.start, end: line.end, text: source.text.slice(line.start, line.end), problem });
      }
    }
  }
  return out.sort((a, b) => compareDateTime(a.at, b.at) || a.sourceId.localeCompare(b.sourceId) || a.start - b.start);
}

/** 予定の行の候補が範囲にあるか（ないときは、AI を呼ばない） */
export function hasPlanCandidates(input: Pick<PlanInput, 'encounters' | 'sources' | 'segments'>): boolean {
  return planLines(input).length > 0;
}

// ---------------------------------------------------------------------------
// 資料

interface Candidate extends PlanLine {
  readonly encounterStart: string;
}

export interface PlanMaterial {
  /** AI に送る資料（JSON にして送る） */
  readonly payload: Record<string, unknown>;
  /** 予定の行の候補（P…） */
  readonly candidates: ReadonlyMap<string, Candidate>;
  /** 実施になりうる記録（E…・M…・C…・V…） */
  readonly items: ReadonlyMap<string, PlanDone>;
  /** 数・長さの上限で落とした数 */
  readonly dropped: { readonly candidates: number; readonly done: number };
}

const show = (at: string | null): string => (at === null ? '日時不明' : at.replace('T', ' '));
const overlaps = (a: PlanPointer, b: PlanPointer): boolean => a.sourceId === b.sourceId && a.start < b.end && b.start < a.end;

interface ValueGroup extends Spanned {
  readonly names: readonly string[];
  readonly values: readonly string[];
}

/** 値は、記載ごとにまとめる（「明朝採血」の実施は、その記載の値のまとまり）。場所と日時は、その記載のいちばん早い値 */
function valueGroups(observations: readonly PlanObservation[]): ValueGroup[] {
  const groups = new Map<string, PlanObservation[]>();
  for (const o of [...observations].sort((a, b) => compareDateTime(a.at, b.at) || a.start - b.start)) groups.set(o.sourceId, [...(groups.get(o.sourceId) ?? []), o]);
  return [...groups.values()].map((list) => {
    const first = list[0] as PlanObservation;
    return {
      sourceId: first.sourceId,
      encounterId: first.encounterId,
      at: first.at,
      start: first.start,
      end: first.end,
      names: [...new Set(list.map((o) => o.name ?? o.nameRaw))],
      values: list.map((o) => `${o.name ?? o.nameRaw} ${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`),
    };
  });
}

export function planMaterial(input: PlanInput): PlanMaterial {
  const scope = recentEncounters(input.encounters);
  const ids = new Set(scope.map((e) => e.id));
  const startOf = new Map(scope.map((e) => [e.id, e.start]));
  const current = scope.at(-1);
  const textOf = new Map(input.sources.map((s) => [s.id, s.text]));
  const sourceOf = new Map(input.sources.map((s) => [s.id, s]));
  const quote = (p: PlanPointer): string => (textOf.get(p.sourceId) ?? '').slice(p.start, p.end).replace(/\s+/gu, ' ').trim().slice(0, PLAN_QUOTE_MAX);
  const from = (sourceId: string): string => {
    const s = sourceOf.get(sourceId);
    return s === undefined ? '' : `${SOURCE_KIND_LABELS[s.kind]} ${show(s.at)}`;
  };

  const lines = planLines(input);
  const kept = lines.slice(-PLAN_CANDIDATES_MAX);
  const droppedCandidates = lines.length - kept.length;
  // 実施は予定より前でないので、いちばん早い予定より前の記録は、資料に入れない（日時の分からないものは入れる）
  const earliest = kept.map((l) => l.at).filter((a): a is string => a !== null).sort()[0] ?? null;
  const usable = <T extends Spanned>(list: readonly T[]): T[] =>
    list.filter((x) => ids.has(x.encounterId) && (earliest === null || notBefore(x.at, earliest))).sort((a, b) => compareDateTime(a.at, b.at) || a.start - b.start);

  let evs = usable(input.events);
  let meds = usable(input.medications);
  let crs = usable(input.course);
  let vals = valueGroups(usable(input.observations));
  let droppedDone = 0;

  const build = () => {
    const planRefs = new Map(kept.map((l, i) => [`P${String(i + 1)}`, l]));
    const eventRefs = new Map(evs.map((e, i) => [`E${String(i + 1)}`, e]));
    const medRefs = new Map(meds.map((m, i) => [`M${String(i + 1)}`, m]));
    const courseRefs = new Map(crs.map((c, i) => [`C${String(i + 1)}`, c]));
    const valueRefs = new Map(vals.map((v, i) => [`V${String(i + 1)}`, v]));
    const payload = {
      encounter: current === undefined ? null : { kind: { er: '救急', outpatient: '外来', inpatient: '入院' }[current.kind], start: show(current.start), end: current.end === null ? null : show(current.end) },
      plans: [...planRefs].map(([ref, l]) => ({ ref, at: show(l.at), from: from(l.sourceId), problem: l.problem, text: l.text.replace(/\s+/gu, ' ').trim().slice(0, PLAN_QUOTE_MAX) })),
      events: [...eventRefs].map(([ref, e]) => ({ ref, at: show(e.at), approx: e.atApprox ?? null, kind: EVENT_KIND_NAMES[e.kind], title: e.title, quote: quote(e), from: from(e.sourceId) })),
      medications: [...medRefs].map(([ref, m]) => ({ ref, at: show(m.at), approx: m.atApprox ?? null, name: m.name, action: m.action === null ? '記載なし' : MEDICATION_ACTION_NAMES[m.action], dose: m.doseText ?? '', quote: quote(m), from: from(m.sourceId) })),
      course: [...courseRefs].map(([ref, c]) => ({ ref, at: show(c.at), approx: c.atApprox, category: COURSE_CATEGORY_NAMES[c.category], summary: c.summary, quote: quote(c), from: from(c.sourceId) })),
      values: [...valueRefs].map(([ref, v]) => ({ ref, at: show(v.at), from: from(v.sourceId), values: v.values.slice(0, VALUES_PER_SOURCE).join('、') })),
    };
    return { payload, planRefs, eventRefs, medRefs, courseRefs, valueRefs };
  };
  let built = build();
  // 長さの上限：古い記録から落とす（値 → 経過の出来事 → 薬 → できごと）。予定の行は落とさない（数の上限だけ）
  while (JSON.stringify(built.payload).length > PLAN_MATERIAL_MAX) {
    if (vals.length > 0) vals = vals.slice(1);
    else if (crs.length > 0) crs = crs.slice(1);
    else if (meds.length > 0) meds = meds.slice(1);
    else if (evs.length > 0) evs = evs.slice(1);
    else break;
    droppedDone += 1;
    built = build();
  }

  const candidates = new Map<string, Candidate>();
  for (const [ref, l] of built.planRefs) candidates.set(ref, { ...l, encounterStart: startOf.get(l.encounterId) ?? '' });
  const items = new Map<string, PlanDone>();
  for (const [ref, e] of built.eventRefs) items.set(ref, { kind: 'event', sourceId: e.sourceId, start: e.start, end: e.end, label: `${EVENT_KIND_NAMES[e.kind]}「${e.title}」`, at: e.at });
  for (const [ref, m] of built.medRefs) items.set(ref, { kind: 'medication', sourceId: m.sourceId, start: m.start, end: m.end, label: `薬「${m.name}」${m.action === null ? '' : MEDICATION_ACTION_NAMES[m.action]}`, at: m.at });
  for (const [ref, c] of built.courseRefs) items.set(ref, { kind: 'course', sourceId: c.sourceId, start: c.start, end: c.end, label: `経過「${c.summary}」`, at: c.at });
  for (const [ref, v] of built.valueRefs) {
    const names = v.names.length > 4 ? `${v.names.slice(0, 4).join('・')} ほか ${String(v.names.length - 4)}` : v.names.join('・');
    items.set(ref, { kind: 'value', sourceId: v.sourceId, start: v.start, end: v.end, label: `値 ${names}`, at: v.at });
  }
  return { payload: built.payload, candidates, items, dropped: { candidates: droppedCandidates, done: droppedDone } };
}

// ---------------------------------------------------------------------------
// AI の答えの形（記号と種類と、予定の日の手がかりだけ。文を書かせない）

/** 予定の種類（画面の札） */
export const PLAN_ITEM_KINDS = ['test', 'procedure', 'medication', 'consult', 'explanation', 'observation', 'other'] as const;
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];
export const PLAN_ITEM_KIND_NAMES: Readonly<Record<PlanItemKind, string>> = {
  test: '検査',
  procedure: '処置',
  medication: '投薬',
  consult: '相談',
  explanation: '説明',
  observation: '観察',
  other: 'その他',
};
/** AI が返す種類：予定の種類か、予定ではない（評価・所見・起きたことの行） */
export const PLAN_ANSWER_KINDS = [...PLAN_ITEM_KINDS, 'not_a_plan'] as const;
export type PlanAnswerKind = (typeof PLAN_ANSWER_KINDS)[number];

export const PlanAnswer = z.object({
  items: z.array(
    z.object({
      /** 予定の行の記号（P…） */
      id: z.string(),
      kind: z.enum(PLAN_ANSWER_KINDS),
      /** 予定の日の手がかり（「明日」は base note・days 1。書かれていなければ base none）。日時は、ここから決定論で計算する */
      due: WhenHintWire,
      /** 行ったことが書かれた記号（E・M・C・V。見つからなければ []） */
      done: z.array(z.string()),
    }),
  ),
});
export type PlanAnswer = z.infer<typeof PlanAnswer>;

// ---------------------------------------------------------------------------
// 確かめた後の形（保存する形）

/** 先生の印：なし・実施を確かめた・中止・不要・外す */
export const PLAN_MARKS = ['none', 'confirmed', 'cancelled', 'hidden'] as const;
export type PlanMark = (typeof PLAN_MARKS)[number];
export const PLAN_MARK_NAMES: Readonly<Record<PlanMark, string>> = { none: '印なし', confirmed: '実施を確かめた', cancelled: '中止・不要', hidden: '外した' };

/** 項目の状態：実施の記載あり・その後の記載に見つからない・振り分けられなかった */
export const PLAN_ITEM_STATES = ['done', 'open', 'unsorted'] as const;
export type PlanItemState = (typeof PLAN_ITEM_STATES)[number];

export const PlanItem = PlanPointer.extend({
  /** 組み直しても同じ項目と分かる鍵（文の id・字の始まり） */
  key: z.string(),
  /** 予定の行の字（記録に書かれたまま） */
  text: z.string(),
  /** 同じ記載の「#問題」の見出し（なければ ""） */
  problem: z.string(),
  at: z.string().nullable(),
  /** 予定の種類（振り分けられなかったときは null） */
  kind: z.enum(PLAN_ITEM_KINDS).nullable(),
  /** 予定の日（AI の手がかりから決定論で計算した日・日時。書かれていなければ null） */
  due: z.string().nullable(),
  dueApprox: z.string().nullable(),
  state: z.enum(PLAN_ITEM_STATES),
  done: z.array(PlanDone),
  mark: z.enum(PLAN_MARKS),
});
export type PlanItem = z.infer<typeof PlanItem>;

export const PLAN_REJECT_REASONS = ['unknown_ref', 'not_candidate', 'duplicate', 'unknown_done', 'earlier_done', 'same_note', 'too_many', 'no_done', 'bad_due'] as const;
export type PlanRejectReason = (typeof PLAN_REJECT_REASONS)[number];
export const PLAN_REJECT_NAMES: Readonly<Record<PlanRejectReason, string>> = {
  unknown_ref: '資料にない記号を指していた',
  not_candidate: '予定の行でない記号だった',
  duplicate: '同じ予定が重なった',
  unknown_done: '実施に、資料にない記号を指していた',
  earlier_done: '実施が、予定より前の記載だった',
  same_note: '実施に、予定と同じ記載を指していた',
  too_many: '実施が多すぎた',
  no_done: '「実施あり」と言ったが、確かめられる実施がなかった',
  bad_due: '予定の日が読めない・予定の記載より前だった',
};

export const PlanBody = z.object({
  items: z.array(PlanItem),
  /** 「予定ではない」と振り分けた行の数（評価・所見の行など。字は出さない） */
  notPlan: z.number(),
  rejected: z.partialRecord(z.enum(PLAN_REJECT_REASONS), z.number()),
  dropped: z.object({ candidates: z.number(), done: z.number() }),
});
export type PlanBody = z.infer<typeof PlanBody>;

export const planKey = (p: PlanPointer): string => `plan:${p.sourceId}:${String(p.start)}`;

export interface CheckedPlans {
  readonly items: readonly PlanItem[];
  readonly notPlan: number;
  readonly rejected: Partial<Record<PlanRejectReason, number>>;
}

/** AI の答えを確かめる。印は、まだ付けない（carryPlanMarks で引き継ぐ） */
export function checkPlans(answer: PlanAnswer, material: PlanMaterial): CheckedPlans {
  const rejected: Partial<Record<PlanRejectReason, number>> = {};
  const count = (r: PlanRejectReason): void => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  type Decided = { readonly state: PlanItemState | 'not_plan'; readonly kind: PlanItemKind | null; readonly due: { at: string; approx: string | null } | null; readonly done: PlanDone[] };
  const decided = new Map<string, Decided>();
  let notPlan = 0;
  for (const a of answer.items) {
    const candidate = material.candidates.get(a.id);
    if (candidate === undefined) {
      count(material.items.has(a.id) ? 'not_candidate' : 'unknown_ref');
      continue;
    }
    if (decided.has(a.id)) {
      count('duplicate');
      continue;
    }
    if (a.kind === 'not_a_plan') {
      notPlan += 1;
      decided.set(a.id, { state: 'not_plan', kind: null, due: null, done: [] });
      continue;
    }
    // 予定の日：手がかりから決定論で。予定の記載より前の日になる手がかりは使わない
    let due: { at: string; approx: string | null } | null = null;
    const hint = hintFromWire(a.due);
    if (hint !== null) {
      const resolved = resolveHint(hint, { noteAt: candidate.at, encounterStart: candidate.encounterStart });
      if (resolved === null || (candidate.at !== null && resolved.at.slice(0, 10) < candidate.at.slice(0, 10))) count('bad_due');
      else due = resolved;
    }
    const done: PlanDone[] = [];
    for (const r of [...new Set(a.done)]) {
      const item = material.items.get(r);
      if (item === undefined) {
        count('unknown_done');
        continue;
      }
      // 予定と同じ記載の事実は、その記載を書いた時点のことで、予定の後に行った記載ではない
      if (item.sourceId === candidate.sourceId || overlaps(item, candidate)) {
        count('same_note');
        continue;
      }
      if (!notBefore(item.at, candidate.at)) {
        count('earlier_done');
        continue;
      }
      if (done.length >= PLAN_DONE_MAX) {
        count('too_many');
        continue;
      }
      done.push(item);
    }
    if (a.done.length > 0 && done.length === 0) {
      count('no_done');
      decided.set(a.id, { state: 'unsorted', kind: a.kind, due, done: [] });
      continue;
    }
    decided.set(a.id, { state: done.length > 0 ? 'done' : 'open', kind: a.kind, due, done: done.sort((x, y) => compareDateTime(x.at, y.at)) });
  }
  const items: PlanItem[] = [];
  for (const [ref, c] of material.candidates) {
    const d = decided.get(ref) ?? { state: 'unsorted' as const, kind: null, due: null, done: [] };
    // 「予定ではない」は、一覧に出さない（数だけ）
    if (d.state === 'not_plan') continue;
    items.push({
      key: planKey(c),
      sourceId: c.sourceId,
      start: c.start,
      end: c.end,
      text: c.text,
      problem: c.problem,
      at: c.at,
      kind: d.kind,
      due: d.due?.at ?? null,
      dueApprox: d.due?.approx ?? null,
      state: d.state,
      done: d.done,
      mark: 'none',
    });
  }
  items.sort((a, b) => compareDateTime(a.at, b.at) || a.sourceId.localeCompare(b.sourceId) || a.start - b.start);
  return { items, notPlan, rejected };
}

/** 組み直した一覧に、前の一覧の先生の印を引き継ぐ（同じ鍵：同じ記載の同じ場所の行） */
export function carryPlanMarks(items: readonly PlanItem[], previous: readonly PlanItem[]): PlanItem[] {
  const marks = new Map(previous.map((p) => [p.key, p.mark]));
  return items.map((item) => ({ ...item, mark: marks.get(item.key) ?? 'none' }));
}

/** 先生の印（ボタンだけ。打つ欄はない） */
export const PlanPatch = z.strictObject({ key: z.string().min(1).max(200), mark: z.enum(PLAN_MARKS) });
export type PlanPatch = z.infer<typeof PlanPatch>;

/** 印を当てる（純関数）。鍵がなければ null */
export function applyPlanMark(items: readonly PlanItem[], patch: PlanPatch): PlanItem[] | null {
  const i = items.findIndex((x) => x.key === patch.key);
  const item = items[i];
  if (item === undefined) return null;
  const next = [...items];
  next[i] = { ...item, mark: patch.mark };
  return next;
}

/** 一覧の元になった記録の印（結果待ち・プロブレムリストと同じ） */
export function planBasis(sources: Parameters<typeof listBasis>[0]): string {
  return listBasis(sources);
}

/** 画面の状態の札：実施の記載あり・予定の日を過ぎて記載なし・その後の記載に見つからない・振り分けられなかった（判定の語は使わない） */
export type PlanStatus = 'done' | 'past_due' | 'open' | 'unsorted';
/** 予定の日（日の単位）が、記録の上で最後の日より前で、実施の記載がないときだけ past_due */
export function planStatus(item: Pick<PlanItem, 'state' | 'due'>, asOf: string | null): PlanStatus {
  if (item.state !== 'open') return item.state;
  return item.due !== null && asOf !== null && item.due.slice(0, 10) < asOf.slice(0, 10) ? 'past_due' : 'open';
}
