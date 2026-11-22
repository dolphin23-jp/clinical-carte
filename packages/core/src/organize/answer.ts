// AI の整理の答えの形（段2。docs/00 の 5、docs/04 の 5）。AI が返すのは、分類と、文の中の引用だけ。
// 文は書かない。数は写させない（測定値は、引用を決定論で読む）。日時は作らせない（引用を決定論で読む。time/when.ts）。
// 確かめて記録にするのは apply.ts。選べる値と画面の名前は、ここの1か所。
import { z } from 'zod';

import { SOURCE_KINDS } from '../record/schema.ts';

/** 文の区切りの見出し（記載の型をまたいで、1つの集まり） */
export const SEGMENT_LABELS = [
  'chief_complaint',
  'present_illness',
  'past_history',
  'home_medications',
  'allergy',
  'social_history',
  'family_history',
  'review_of_systems',
  'physical_exam',
  'labs',
  'imaging',
  'subjective',
  'objective',
  'assessment',
  'plan',
  'assessment_plan',
  'problem_heading',
  'course',
  'handover',
  'other',
] as const;
export type SegmentLabel = (typeof SEGMENT_LABELS)[number];
export const SEGMENT_LABEL_NAMES: Readonly<Record<SegmentLabel, string>> = {
  chief_complaint: '主訴',
  present_illness: '現病歴',
  past_history: '既往歴',
  home_medications: '内服・常用薬',
  allergy: 'アレルギー',
  social_history: '生活歴',
  family_history: '家族歴',
  review_of_systems: 'システムレビュー',
  physical_exam: '身体所見',
  labs: '検査',
  imaging: '画像',
  subjective: 'S',
  objective: 'O',
  assessment: 'A（評価）',
  plan: 'P（方針）',
  assessment_plan: 'A/P',
  problem_heading: '#問題',
  course: '経過',
  handover: '申し送り',
  other: 'その他',
};

/** 投薬の、書かれた動き。書かれていなければ null（補わない） */
export const MEDICATION_ACTIONS = ['start', 'change', 'stop', 'continue'] as const;
export type MedicationAction = (typeof MEDICATION_ACTIONS)[number];
export const MEDICATION_ACTION_NAMES: Readonly<Record<MedicationAction, string>> = { start: '開始', change: '変更', stop: '中止', continue: '継続' };

export const EVENT_KINDS = ['procedure', 'surgery', 'test', 'consult', 'transfer', 'deterioration', 'explanation', 'other'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const EVENT_KIND_NAMES: Readonly<Record<EventKind, string>> = {
  procedure: '処置',
  surgery: '手術',
  test: '検査の実施',
  consult: 'コンサルト',
  transfer: '転棟・転科・転院',
  deterioration: '急変',
  explanation: '説明',
  other: 'その他',
};

/** 問題・診断の、書かれた確からしさ。AI が確度を決めない：書かれているとおり（「疑い」「否定的」と書かれていれば、そのとおり） */
export const PROBLEM_STATUSES = ['problem', 'diagnosis', 'suspected', 'ruled_out'] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];
export const PROBLEM_STATUS_NAMES: Readonly<Record<ProblemStatus, string>> = {
  problem: '問題',
  diagnosis: '診断',
  suspected: '疑い',
  ruled_out: '否定的と書かれている',
};

/** 問題の、書かれた活動の状態（CA-025）。確からしさとは別の軸。書かれていなければ null（「状態の記載なし」） */
export const PROBLEM_ACTIVITIES = ['resolved', 'inactive'] as const;
export type ProblemActivity = (typeof PROBLEM_ACTIVITIES)[number];
export const PROBLEM_ACTIVITY_NAMES: Readonly<Record<ProblemActivity, string>> = {
  resolved: '解決と書かれている',
  inactive: '非活動・既往と書かれている',
};

/** 測定値の検体の種類（AI が指す。書かれた見出し・行から）。いまは尿だけ（血液・バイタル・そのほかは null） */
export const MEASUREMENT_SPECIMENS = ['urine'] as const;
export type MeasurementSpecimen = (typeof MEASUREMENT_SPECIMENS)[number];

/** 時間帯の言い方（「夕方」「深夜」など）。日時にするときは、代表の時刻にし、「ごろ」の印を付ける */
export const DAY_PARTS = ['early_morning', 'morning', 'noon', 'afternoon', 'evening', 'night', 'late_night'] as const;
export type DayPart = (typeof DAY_PARTS)[number];
export const DAY_PART_NAMES: Readonly<Record<DayPart, string>> = {
  early_morning: '早朝',
  morning: '朝',
  noon: '昼',
  afternoon: '午後',
  evening: '夕方',
  night: '夜',
  late_night: '深夜',
};

/**
 * 時刻の手がかり（CA-056。2026-11-21 の本人の決定）：「来院2時間前」「3日前の夕方」「数日前」「先週」のように、引用を決まった規則で読めない言い方を、
 * AI が「基準と、ずれ」で返す。日時にする計算は、サーバーが決定論でする（time/hint.ts）。幅のある言い方は spanDays に幅（日）を入れ、「ごろ」の印を付ける。
 * base：note＝その記載の日時から、arrival＝受診（来院・入院）の始まりから
 */
export const WhenHint = z
  .object({
    base: z.enum(['note', 'arrival']),
    /** 日のずれ（前は負の数。「3日前」は -3） */
    days: z.number().nullable(),
    /** 時間のずれ（「2時間前」は -2） */
    hours: z.number().nullable(),
    minutes: z.number().nullable(),
    /** その日の時刻が書かれていれば「HH:MM」 */
    time: z.string().nullable(),
    part: z.enum(DAY_PARTS).nullable(),
    /** 幅のある言い方（「数日前」「先週」）の幅（日）。幅がなければ null */
    spanDays: z.number().nullable(),
  })
  .nullable();
export type WhenHint = z.infer<typeof WhenHint>;

/** 経過の出来事の種類（CA-056。病歴・経過の文から、日ごとに振り分ける） */
export const COURSE_CATEGORIES = ['onset', 'change', 'intake', 'visit', 'test', 'treatment', 'finding', 'other'] as const;
export type CourseCategory = (typeof COURSE_CATEGORIES)[number];
export const COURSE_CATEGORY_NAMES: Readonly<Record<CourseCategory, string>> = {
  onset: '症状の出現',
  change: '症状の変化',
  intake: '内服・服薬',
  visit: '受診・搬送',
  test: '検査',
  treatment: '処置・治療',
  finding: '所見・測定',
  other: 'その他',
};

/** AI が読んだ測定値（CA-056：AI が数も書いてよい。書かれた場所の字に同じ数がないものは、印を付ける） */
export const AiValue = z.object({
  /** 項目の名前（「体温」「BT」「収縮期血圧」など） */
  name: z.string(),
  /** 値（数か定性。血圧は「90/50」でもよい） */
  value: z.string(),
  unit: z.string().nullable(),
  comparator: z.enum(['<', '>', '<=', '>=']).nullable(),
});
export type AiValue = z.infer<typeof AiValue>;

// ---------------------------------------------------------------------------
// AI に求める形（wire）。構造化出力は、null になりうる欄（anyOf）が 16 までという上限がある（API の決まり。2026-11-22：
// organize-6 で 41 になり、整理がすべて 400 で断られた）。CA-056 で足した欄は null を使わず、「なし」の値で返させ、ここで中の形に直す。

/** 時刻の手がかり（wire）：手がかりがなければ base は none。数は 0・time は ""・part は none・spanDays は 0 が「なし」 */
export const WhenHintWire = z.object({
  base: z.enum(['none', 'note', 'arrival']),
  days: z.number(),
  hours: z.number(),
  minutes: z.number(),
  time: z.string(),
  part: z.enum([...DAY_PARTS, 'none']),
  spanDays: z.number(),
});
export type WhenHintWire = z.infer<typeof WhenHintWire>;

/** AI が読んだ値（wire）：単位・不等号がなければ "" */
export const AiValueWire = z.object({ name: z.string(), value: z.string(), unit: z.string(), comparator: z.enum(['', '<', '>', '<=', '>=']) });
export type AiValueWire = z.infer<typeof AiValueWire>;

/** wire の手がかりを、中の形にする（なしは null） */
export function hintFromWire(w: WhenHintWire): WhenHint {
  if (w.base === 'none') return null;
  const n = (x: number): number | null => (x === 0 ? null : x);
  const hint = { base: w.base, days: n(w.days), hours: n(w.hours), minutes: n(w.minutes), time: w.time.trim() === '' ? null : w.time.trim(), part: w.part === 'none' ? null : w.part, spanDays: n(w.spanDays) };
  return hint.days === null && hint.hours === null && hint.minutes === null && hint.time === null && hint.part === null && hint.spanDays === null ? null : hint;
}

/** wire の値を、中の形にする */
export const valueFromWire = (v: AiValueWire): AiValue => ({ name: v.name, value: v.value, unit: v.unit.trim() === '' ? null : v.unit, comparator: v.comparator === '' ? null : v.comparator });

/** AI の答えの形（構造化した出力の型）。長さ・場所などの検査は apply.ts がする */
export const OrganizeAnswerWire = z.object({
  /** 記載の種類（文から分かれば）。種類が「未分類」の文だけに使う */
  kind: z.enum(SOURCE_KINDS).nullable(),
  /** 記載そのものの日時が書かれた場所（引用）。なければ null */
  when: z.string().nullable(),
  /** 見出しと、その区切りが始まる場所（引用。文の順）。when は、その区切りの時刻が書かれた場所（「初期評価（10:44）」の 10:44。なければ null）。
   *  区切りの中の事実で、自分の日時の書かれていないものは、この日時になる（2026-11-21 の本人の決定） */
  segments: z.array(z.object({ label: z.enum(SEGMENT_LABELS), start: z.string(), when: z.string().nullable() })),
  medications: z.array(
    z.object({
      /** 薬の名前（引用） */
      name: z.string(),
      /** 用量・用法・経路（引用。書かれていなければ null） */
      dose: z.string().nullable(),
      action: z.enum(MEDICATION_ACTIONS).nullable(),
      /** その動きの日時が書かれた場所（引用。なければ null＝記載の日時） */
      when: z.string().nullable(),
      /** 引用を規則で読めない日時の言い方の手がかり（CA-056。wire の形） */
      whenHint: WhenHintWire,
    }),
  ),
  events: z.array(z.object({ kind: z.enum(EVENT_KINDS), title: z.string(), when: z.string().nullable(), whenHint: WhenHintWire })),
  problems: z.array(z.object({ name: z.string(), status: z.enum(PROBLEM_STATUSES), activity: z.enum(PROBLEM_ACTIVITIES).nullable() })),
  /** 測定値が書かれた場所（引用。「Na 128」「BT 38.5」など。数は、ここから決定論で読む）。
   *  specimen は、尿の検査の引用なら urine（尿の項目の名前で読む。CD-023 の答え：2026-11-21 の本人の決定）。ほかは null */
  measurements: z.array(
    z.object({
      quote: z.string(),
      when: z.string().nullable(),
      whenHint: WhenHintWire,
      specimen: z.enum(MEASUREMENT_SPECIMENS).nullable(),
      /** AI が読んだ項目と値（CA-056）。引用を決定論で読めないとき（「熱は38.5℃まで上昇」）に使う */
      values: z.array(AiValueWire),
    }),
  ),
  /**
   * 経過の出来事（CA-056）：病歴・経過の文に書かれた「いつ・何があったか」（症状の出現と変化・内服・受診・検査・処置・所見）。
   * quote は、その出来事が書かれた部分の引用、summary は AI の短い要約（80 字まで。数は引用にあるものだけ）
   */
  course: z.array(z.object({ quote: z.string(), summary: z.string(), category: z.enum(COURSE_CATEGORIES), when: z.string().nullable(), whenHint: WhenHintWire })),
});
export type OrganizeAnswerWire = z.infer<typeof OrganizeAnswerWire>;

type Wire = OrganizeAnswerWire;
type Hinted<T> = Omit<T, 'whenHint'> & { readonly whenHint?: WhenHint };
/**
 * 整理の答え（中で使う形）。AI に求める形（OrganizeAnswerWire）から organizeFromWire で直したもの。CA-056 で足した欄（日時の手がかり・AI の値・経過の出来事）は、
 * 前の版の答え・試験の答えにはないので、ここでは省いてよい（省いたものは、ないものとして扱う）
 */
export type OrganizeAnswer = Omit<Wire, 'medications' | 'events' | 'measurements' | 'course'> & {
  readonly medications: readonly Hinted<Wire['medications'][number]>[];
  readonly events: readonly Hinted<Wire['events'][number]>[];
  readonly measurements: readonly (Hinted<Omit<Wire['measurements'][number], 'values'>> & { readonly values?: readonly AiValue[] })[];
  readonly course?: readonly Hinted<Wire['course'][number]>[];
};

/** AI の答え（wire）を、中の形にする */
export function organizeFromWire(w: OrganizeAnswerWire): OrganizeAnswer {
  return {
    ...w,
    medications: w.medications.map((m) => ({ ...m, whenHint: hintFromWire(m.whenHint) })),
    events: w.events.map((e) => ({ ...e, whenHint: hintFromWire(e.whenHint) })),
    measurements: w.measurements.map((m) => ({ ...m, whenHint: hintFromWire(m.whenHint), values: m.values.map(valueFromWire) })),
    course: w.course.map((c) => ({ ...c, whenHint: hintFromWire(c.whenHint) })),
  };
}
