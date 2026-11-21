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

/** AI の答えの形（構造化した出力の型）。長さ・場所などの検査は apply.ts がする */
export const OrganizeAnswer = z.object({
  /** 記載の種類（文から分かれば）。種類が「未分類」の文だけに使う */
  kind: z.enum(SOURCE_KINDS).nullable(),
  /** 記載そのものの日時が書かれた場所（引用）。なければ null */
  when: z.string().nullable(),
  /** 見出しと、その区切りが始まる場所（引用。文の順） */
  segments: z.array(z.object({ label: z.enum(SEGMENT_LABELS), start: z.string() })),
  medications: z.array(
    z.object({
      /** 薬の名前（引用） */
      name: z.string(),
      /** 用量・用法・経路（引用。書かれていなければ null） */
      dose: z.string().nullable(),
      action: z.enum(MEDICATION_ACTIONS).nullable(),
      /** その動きの日時が書かれた場所（引用。なければ null＝記載の日時） */
      when: z.string().nullable(),
    }),
  ),
  events: z.array(z.object({ kind: z.enum(EVENT_KINDS), title: z.string(), when: z.string().nullable() })),
  problems: z.array(z.object({ name: z.string(), status: z.enum(PROBLEM_STATUSES), activity: z.enum(PROBLEM_ACTIVITIES).nullable() })),
  /** 測定値が書かれた場所（引用。「Na 128」「BT 38.5」など。数は、ここから決定論で読む）。
   *  specimen は、尿の検査の引用なら urine（尿の項目の名前で読む。CD-023 の答え：2026-11-21 の本人の決定）。ほかは null */
  measurements: z.array(z.object({ quote: z.string(), when: z.string().nullable(), specimen: z.enum(MEASUREMENT_SPECIMENS).nullable() })),
});
export type OrganizeAnswer = z.infer<typeof OrganizeAnswer>;
