// 「いまの状態」（段3b。CA-023・CA-026・CA-027。docs/03 の 3）：患者の現在地を1画面にまとめる。純関数。保存しない。
//
// - 作文しない：1行の要約は、年齢・性別・受診・病日・問題の名前から作る決定論のひな形。ほかは、整理した事実と、保存した文の区切り（場所だけ）。
// - 「いま」は、記録の上で最後の日時（asOf）。端末の時計の「いま」ではない（carte は写しで、最新とは限らない）。
// - 判定しない：並べるだけ。投薬は「薬ごとの最後の記載」で、いま続いているかを補わない。
import { type EventKind, type MedicationAction, type SegmentLabel, SEGMENT_LABEL_NAMES } from '../organize/answer.ts';
import { medicationTimeline, nameKey } from '../organize/views.ts';
import { type ProblemNote, problemNotes, relatedFacts, sharedPlanSegments, type ThreadMention, type ThreadRow, type ThreadView, threadViews } from '../problems/threads.ts';
import { ageNow, hospitalDay } from '../record/headline.ts';
import { ENCOUNTER_KIND_LABELS, type EncounterKind, type Sex } from '../record/schema.ts';
import { compareDateTime } from '../time/datetime.ts';
import { chartTime } from './chart.ts';

const SEX_WORDS: Readonly<Record<Sex, string>> = { male: '男性', female: '女性', other: '性別その他・不明' };

/** 背景として出す区切り（CA-027） */
export const BACKGROUND_LABELS: readonly SegmentLabel[] = ['past_history', 'home_medications', 'allergy', 'social_history', 'family_history'];

/** 「この期間に入ったこと」の幅（時間） */
export const RECENT_HOURS = 24;
/** 1行の要約に名前を出す、いまの問題の数（残りは「ほか N」。2026-11-21：1日の濃い記録で、要約が問題の羅列になったため） */
export const ONE_LINER_PROBLEMS = 5;

export interface StateSource {
  readonly id: string;
  readonly encounterId: string;
  readonly at: string | null;
  readonly enteredAt: string;
}

export interface StateSegment {
  readonly sourceId: string;
  readonly label: SegmentLabel;
  readonly start: number;
  readonly end: number;
}

export interface StateMedication {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly doseText: string | null;
  readonly action: MedicationAction | null;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
}

export interface StateEvent {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
}

export interface StateObservation {
  readonly id: string;
  readonly sourceId: string;
  readonly at: string | null;
  readonly name: string | null;
  readonly nameRaw: string;
  readonly kind: 'lab' | 'vital' | null;
  /** 不等号（valueText には入らない。表示で添える） */
  readonly comparator?: string | null;
  readonly valueText: string;
  readonly unit: string | null;
  readonly start: number;
  readonly end: number;
}

export interface StateInput {
  readonly patient: { readonly age: number; readonly ageOn: string; readonly sex: Sex };
  readonly encounter: { readonly id: string; readonly kind: EncounterKind; readonly start: string; readonly end: string | null };
  /** 日本の今日（年齢の概算にだけ使う） */
  readonly today: string;
  /** 患者のすべての文・区切り・問題（問題と背景は、受診をまたぐ） */
  readonly sources: readonly StateSource[];
  readonly segments: readonly StateSegment[];
  readonly threads: readonly ThreadRow[];
  readonly mentions: readonly ThreadMention[];
  /** この受診の事実 */
  readonly medications: readonly StateMedication[];
  readonly events: readonly StateEvent[];
  readonly observations: readonly StateObservation[];
}

export type RecentItem =
  | { readonly type: 'problem_new'; readonly at: string; readonly name: string; readonly threadId: string }
  | { readonly type: 'problem_activity'; readonly at: string; readonly name: string; readonly activity: 'resolved' | 'inactive' }
  | { readonly type: 'medication'; readonly at: string; readonly name: string; readonly action: MedicationAction; readonly doseText: string | null }
  | { readonly type: 'event'; readonly at: string; readonly kind: EventKind; readonly title: string }
  | { readonly type: 'lab'; readonly at: string; readonly name: string; readonly comparator: string | null; readonly valueText: string; readonly unit: string | null };

export interface CurrentProblem {
  readonly thread: ThreadView;
  /** いちばん新しい記載の A・P（同じ記載の区切りをまとめて。なければ空） */
  readonly notes: readonly ProblemNote[];
  /** その問題の記載の中に書かれた検査・バイタルの名前ごとの、この受診でいちばん新しい値（段3c） */
  readonly values: readonly StateObservation[];
  /** その問題の記載の中に書かれた薬の、薬ごとの最後の記載（段3c） */
  readonly medications: readonly MedicationLast[];
}

export interface MedicationLast {
  readonly name: string;
  /** 薬ごとの、いちばん新しい記載 */
  readonly action: MedicationAction | null;
  readonly doseText: string | null;
  readonly at: string | null;
  /** 記載の数 */
  readonly entries: number;
}

export interface BackgroundPart {
  readonly label: SegmentLabel;
  readonly name: string;
  /** いちばん新しい記載のその区切り（場所だけ。画面が保存した文から切り出す） */
  readonly sourceId: string;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
  /** ほかの記載にも同じ区切りがある数 */
  readonly others: number;
}

export interface PatientState {
  /** 1行の要約（決定論のひな形） */
  readonly oneLiner: string;
  /** 記録の上で最後の日時（この受診の文・事実の日時の最大。なければ null） */
  readonly asOf: string | null;
  /** 最後に入れた日時（この受診の文を入れた日時の最大） */
  readonly lastEntered: string | null;
  readonly current: readonly CurrentProblem[];
  /** 記載全体の P（問題に分けて書かれていない A・P）の、この受診でいちばん新しい記載のもの。なければ null */
  readonly sharedPlan: { readonly sourceId: string; readonly at: string | null; readonly parts: readonly ProblemNote[] } | null;
  readonly closed: readonly ThreadView[];
  readonly ruledOut: readonly ThreadView[];
  /** まだ筋につないでいない問題の記載の数 */
  readonly unlinked: number;
  /** asOf までの RECENT_HOURS 時間（asOf がなければ null）。新しい順 */
  readonly recent: { readonly from: string; readonly to: string; readonly items: readonly RecentItem[] } | null;
  /** 薬ごとの最後の記載。中止と書かれたものは別に */
  readonly medications: readonly MedicationLast[];
  readonly stoppedMedications: readonly MedicationLast[];
  readonly background: readonly BackgroundPart[];
}

/** 日時のいちばん新しいもの（日時のないものは、日時のあるものがなければ、最後のもの） */
function latestBy<T extends { readonly at: string | null }>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of items) if (item.at !== null && (best === null || compareDateTime(item.at, best.at) >= 0)) best = item;
  return best ?? items.at(-1) ?? null;
}

const latestOf = (values: readonly (string | null)[]): string | null =>
  values.reduce<string | null>((best, v) => (v !== null && (best === null || compareDateTime(v, best) > 0) ? v : best), null);

/** ミリ秒の時刻を、日時の形（YYYY-MM-DDTHH:MM。日本の時計の数字のまま）に戻す */
function fromTime(t: number): string {
  const d = new Date(t);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear())}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** 1行の要約の材料：年齢・性別・受診・記録の上で最後の日時・いまの問題の名前だけ */
export interface OneLinerInput {
  readonly patient: { readonly age: number; readonly ageOn: string; readonly sex: Sex };
  readonly encounter: { readonly kind: EncounterKind; readonly start: string; readonly end: string | null };
  readonly today: string;
  readonly asOf: string | null;
  readonly problems: readonly string[];
}

/** 記録の上での病日（入院で、記録の上で最後の日時があるときだけ） */
export function dayOnRecord(encounter: OneLinerInput['encounter'], asOf: string | null): number | null {
  return encounter.kind === 'inpatient' && asOf !== null ? hospitalDay(encounter.start, asOf) : null;
}

/** 1行の要約（決定論のひな形。作文しない）。「いまの状態」と回診リストが同じものを使う */
export function oneLinerOf(input: OneLinerInput): string {
  const who = `${String(ageNow(input.patient.age, input.patient.ageOn, input.today))}歳 ${SEX_WORDS[input.patient.sex]}`;
  const { encounter } = input;
  const start = encounter.start.slice(0, 10);
  const span = encounter.kind === 'inpatient' ? `${start}〜${encounter.end === null ? '' : encounter.end.slice(0, 10)}` : start;
  const day = dayOnRecord(encounter, input.asOf);
  const dayText = day === null ? '' : `（記録の上では ${String(day)}病日まで）`;
  const shown = input.problems.slice(0, ONE_LINER_PROBLEMS);
  const rest = input.problems.length - shown.length;
  const problemText = input.problems.length === 0 ? 'いまの問題の記載なし' : `いまの問題：${shown.join('、')}${rest > 0 ? ` ほか ${String(rest)}` : ''}`;
  return `${who}。${ENCOUNTER_KIND_LABELS[encounter.kind]} ${span}${dayText}。${problemText}。`;
}

export interface RoundInput {
  readonly encounter: { readonly id: string };
  /** その患者の文（いちばん新しい受診のものから、記録の上で最後の日時を取る） */
  readonly sources: readonly { readonly encounterId: string; readonly at: string | null; readonly enteredAt: string }[];
  readonly threads: readonly ThreadRow[];
  readonly mentions: readonly ThreadMention[];
}

export interface RoundSummary {
  /** 記録の上で最後の日時（その受診の文の日時の最大） */
  readonly asOf: string | null;
  readonly lastEntered: string | null;
  /** いまの問題の名前（最初の記載の順） */
  readonly problems: readonly string[];
  /** 解決・非活動・否定的と書かれた問題の数 */
  readonly otherProblems: number;
  /** まだ筋につないでいない問題の記載の数 */
  readonly unlinked: number;
}

/** 回診リストの1行の材料（段3d。CA-028）。サーバーが患者ごとに作る（記録の全体を送らないため） */
export function roundSummary(input: RoundInput): RoundSummary {
  const own = input.sources.filter((s) => s.encounterId === input.encounter.id);
  const views = threadViews(input.threads, input.mentions);
  const current = views.threads.filter((t) => t.group === 'current');
  return {
    asOf: latestOf(own.map((s) => s.at)),
    lastEntered: latestOf(own.map((s) => s.enteredAt)),
    problems: current.map((t) => t.name),
    otherProblems: views.threads.length - current.length,
    unlinked: views.unlinked.length,
  };
}

export function patientState(input: StateInput): PatientState {
  const { encounter } = input;
  const encounterSources = input.sources.filter((s) => s.encounterId === encounter.id);
  const asOf = latestOf([
    ...encounterSources.map((s) => s.at),
    ...input.medications.map((m) => m.at),
    ...input.events.map((e) => e.at),
    ...input.observations.map((o) => o.at),
  ]);
  const lastEntered = latestOf(encounterSources.map((s) => s.enteredAt));

  // 投薬：薬ごとの最後の記載
  const lines = medicationTimeline(input.medications.map((m) => ({ ...m })));
  const medsLast: MedicationLast[] = lines.map((line) => {
    const dated = line.entries.filter((e) => e.at !== null);
    const e = dated.at(-1) ?? line.entries.at(-1);
    return { name: line.name, action: e?.action ?? null, doseText: e?.doseText ?? null, at: e?.at ?? null, entries: line.entries.length };
  });

  // 問題（受診をまたぐ）
  const views = threadViews(input.threads, input.mentions);
  const current = views.threads
    .filter((t) => t.group === 'current')
    .map((thread) => {
      const notes = problemNotes(thread.mentions, input.segments, input.mentions);
      const last = notes.at(-1);
      const related = relatedFacts(thread.mentions, input.segments, { observations: input.observations, medications: input.medications, events: input.events });
      const values = related.valueNames
        .map((name) => latestBy(input.observations.filter((o) => (o.name ?? o.nameRaw) === name)))
        .filter((o): o is StateObservation => o !== null);
      const medKeys = new Set(related.medicationNames.map(nameKey));
      return {
        thread,
        notes: last === undefined ? [] : notes.filter((n) => n.sourceId === last.sourceId),
        values,
        medications: medsLast.filter((m) => medKeys.has(nameKey(m.name))),
      };
    });
  // 記載全体の P：この受診の記載のうち、いちばん新しいもの（同じ日時なら、あとに入れたもの）
  const sharedSegs = sharedPlanSegments(input.segments.filter((g) => encounterSources.some((src) => src.id === g.sourceId)));
  const sharedSource = [...new Set(sharedSegs.map((g) => g.sourceId))]
    .map((id) => encounterSources.find((src) => src.id === id))
    .filter((src): src is StateSource => src !== undefined)
    .sort((a, b) => compareDateTime(a.at, b.at) || a.enteredAt.localeCompare(b.enteredAt))
    .at(-1);
  const sharedPlan =
    sharedSource === undefined
      ? null
      : { sourceId: sharedSource.id, at: sharedSource.at, parts: sharedSegs.filter((g) => g.sourceId === sharedSource.id).map((g) => ({ sourceId: g.sourceId, at: sharedSource.at, label: g.label, start: g.start, end: g.end })) };
  const closed = views.threads.filter((t) => t.group === 'closed');
  const ruledOut = views.threads.filter((t) => t.group === 'ruled_out');

  // 1行の要約
  const oneLiner = oneLinerOf({ patient: input.patient, encounter, today: input.today, asOf, problems: current.map((c) => c.thread.name) });

  // 最後の記録までの24時間
  let recent: PatientState['recent'] = null;
  const asOfTime = asOf === null ? null : chartTime(asOf);
  if (asOf !== null && asOfTime !== null) {
    const to = asOfTime.t;
    const from = to - RECENT_HOURS * 3600_000;
    const fromText = fromTime(from);
    // 日だけ分かる記載は、日で比べる（幅の最初の日〜最後の日に入れば入れる。正午に置くと、最後の日の朝が最後のとき外れるため）
    const inside = (at: string | null): at is string => {
      if (at === null) return false;
      if (at.length === 10) return at >= fromText.slice(0, 10) && at <= asOf.slice(0, 10);
      const c = chartTime(at);
      return c !== null && c.t > from && c.t <= to;
    };
    const items: RecentItem[] = [];
    const encounterSourceIds = new Set(encounterSources.map((s) => s.id));
    for (const t of views.threads) {
      const first = t.mentions[0];
      // はじめての記載に解決・非活動（既往）と書かれていれば、「はじめて書かれた」は出さず、下の状態の1行だけにする（同じ病名を2行にしない）
      if (first !== undefined && first.activity === null && encounterSourceIds.has(first.sourceId) && inside(first.at)) items.push({ type: 'problem_new', at: first.at, name: first.name, threadId: t.id });
      for (const m of t.mentions) {
        if (m.activity !== null && encounterSourceIds.has(m.sourceId) && inside(m.at)) items.push({ type: 'problem_activity', at: m.at, name: m.name, activity: m.activity });
      }
    }
    for (const m of input.medications) if (m.action !== null && inside(m.at)) items.push({ type: 'medication', at: m.at, name: m.name, action: m.action, doseText: m.doseText });
    for (const e of input.events) if (inside(e.at)) items.push({ type: 'event', at: e.at, kind: e.kind, title: e.title });
    for (const o of input.observations) if (o.kind !== 'vital' && inside(o.at)) items.push({ type: 'lab', at: o.at, name: o.name ?? o.nameRaw, comparator: o.comparator ?? null, valueText: o.valueText, unit: o.unit });
    items.sort((a, b) => compareDateTime(b.at, a.at));
    recent = { from: fromText, to: asOf, items };
  }


  // 背景（受診をまたぐ）：区切りごとに、いちばん新しい記載のもの
  const sourceAt = new Map(input.sources.map((s) => [s.id, s]));
  const background: BackgroundPart[] = [];
  for (const label of BACKGROUND_LABELS) {
    const parts = input.segments.filter((s) => s.label === label && sourceAt.has(s.sourceId));
    if (parts.length === 0) continue;
    const sorted = [...parts].sort((a, b) => {
      const sa = sourceAt.get(a.sourceId);
      const sb = sourceAt.get(b.sourceId);
      return compareDateTime(sa?.at ?? null, sb?.at ?? null) || (sa?.id ?? '').localeCompare(sb?.id ?? '') || a.start - b.start;
    });
    const newest = sorted.at(-1);
    if (newest === undefined) continue;
    const sources = new Set(parts.map((p) => p.sourceId));
    background.push({ label, name: SEGMENT_LABEL_NAMES[label], sourceId: newest.sourceId, at: sourceAt.get(newest.sourceId)?.at ?? null, start: newest.start, end: newest.end, others: sources.size - 1 });
  }

  return {
    oneLiner,
    asOf,
    lastEntered,
    current,
    sharedPlan,
    closed,
    ruledOut,
    unlinked: views.unlinked.length,
    recent,
    medications: medsLast.filter((m) => m.action !== 'stop'),
    stoppedMedications: medsLast.filter((m) => m.action === 'stop'),
    background,
  };
}

/** 24時間の一覧を、種類ごとにまとめたもの（見せ方だけ。中身は items と同じ。新しい順） */
export interface RecentGroups {
  readonly problems: readonly RecentItem[];
  readonly medications: readonly RecentItem[];
  readonly events: readonly RecentItem[];
  /** 検査値は、項目ごとに、いちばん新しい値と、この間の件数 */
  readonly labs: readonly { readonly name: string; readonly latest: Extract<RecentItem, { type: 'lab' }>; readonly count: number }[];
  /** labs のうち、この間に2回以上書かれた項目（推移のあるもの。先に見せる） */
  readonly repeatedLabs: RecentGroups['labs'];
  /** labs のうち、この間に1回だけの項目（畳む） */
  readonly singleLabs: RecentGroups['labs'];
}

export function recentGroups(items: readonly RecentItem[]): RecentGroups {
  const labs = new Map<string, { name: string; latest: Extract<RecentItem, { type: 'lab' }>; count: number }>();
  for (const item of items) {
    if (item.type !== 'lab') continue;
    const found = labs.get(item.name);
    if (found === undefined) labs.set(item.name, { name: item.name, latest: item, count: 1 });
    else {
      found.count += 1;
      if (compareDateTime(item.at, found.latest.at) > 0) found.latest = item;
    }
  }
  const sortedLabs = [...labs.values()].sort((a, b) => compareDateTime(b.latest.at, a.latest.at));
  return {
    problems: items.filter((i) => i.type === 'problem_new' || i.type === 'problem_activity'),
    medications: items.filter((i) => i.type === 'medication'),
    events: items.filter((i) => i.type === 'event'),
    labs: sortedLabs,
    repeatedLabs: sortedLabs.filter((l) => l.count > 1),
    singleLabs: sortedLabs.filter((l) => l.count === 1),
  };
}
