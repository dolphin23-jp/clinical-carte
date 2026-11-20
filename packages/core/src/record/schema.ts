// 記録の型（docs/04 の 3）。段1 で使う分：患者・受診・取り込んだ文・測定値。
// 選べる値と、その画面の名前を、ここの1か所に置く（画面とサーバーが同じものを使う）。
import { z } from 'zod';

import { isUlid } from '../ids/ulid.ts';
import { isDateTime } from '../time/datetime.ts';
import { isDay } from '../time/day.ts';

export const Ulid = z.custom<string>(isUlid);
export const Day = z.custom<string>(isDay);
export const DateTime = z.custom<string>(isDateTime);

// --- 患者（docs/04 の 3.1）。氏名・ID・呼び名・病室の欄は、ない（CA-003・CA-014）

export const SEXES = ['male', 'female', 'other'] as const;
export type Sex = (typeof SEXES)[number];
export const SEX_LABELS: Readonly<Record<Sex, string>> = { male: '男', female: '女', other: 'その他・不明' };

export const AGE_MAX = 130;
/** 年齢（歳の整数。乳児は 0）と、その年齢だった日。生年月日は持たない */
export const Age = z.number().int().min(0).max(AGE_MAX);

// --- 受診（docs/04 の 3.2）

export const ENCOUNTER_KINDS = ['er', 'outpatient', 'inpatient'] as const;
export type EncounterKind = (typeof ENCOUNTER_KINDS)[number];
export const ENCOUNTER_KIND_LABELS: Readonly<Record<EncounterKind, string>> = { er: '救急', outpatient: '外来', inpatient: '入院' };

export const NewEncounter = z.strictObject({
  kind: z.enum(ENCOUNTER_KINDS),
  /** 開始の日時（暦日のまま。CA-004） */
  start: DateTime,
});
export type NewEncounter = z.infer<typeof NewEncounter>;

export const NewPatient = z.strictObject({
  age: Age,
  ageOn: Day,
  sex: z.enum(SEXES),
  /** 患者は、最初の受診と一緒に作る */
  encounter: NewEncounter,
});
export type NewPatient = z.infer<typeof NewPatient>;

export const PatientPatch = z.strictObject({ age: Age, ageOn: Day, sex: z.enum(SEXES) });
export type PatientPatch = z.infer<typeof PatientPatch>;

/** 受診の終わり（退院・帰宅の日時）。null で、終わりを消す */
export const EncounterPatch = z.strictObject({ end: DateTime.nullable() });
export type EncounterPatch = z.infer<typeof EncounterPatch>;

// --- 取り込んだ文（docs/04 の 3.3）

export const SOURCE_KINDS = [
  'unsorted',
  'er_note',
  'outpatient_first',
  'outpatient_revisit',
  'admission_note',
  'progress_note',
  'interim_summary',
  'discharge_summary',
  'nursing',
  'lab',
  'vital',
  'report',
  'orders',
  'referral',
  'memo',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_LABELS: Readonly<Record<SourceKind, string>> = {
  unsorted: '未分類',
  er_note: '救急記録',
  outpatient_first: '外来初診',
  outpatient_revisit: '外来再診',
  admission_note: '入院時初診',
  progress_note: '経過（プログレスノート）',
  interim_summary: '中間サマリー',
  discharge_summary: '退院サマリー',
  nursing: '看護記録',
  lab: '検査結果',
  vital: 'バイタル',
  report: 'レポート（画像・病理・培養など）',
  orders: '処方・注射',
  referral: '紹介状・他院の情報',
  memo: '自分のメモ',
};

/** 文字から、測定値を決定論で読む種類（docs/00 の 5 の 3）。ほかの種類の文からは、段1 では値を読まない */
export const READ_VALUES_KINDS: readonly SourceKind[] = ['lab', 'vital'];
/** 病院のカルテにない、carte だけの記録 */
export const CARTE_ONLY_KINDS: readonly SourceKind[] = ['memo'];

export const AUTHOR_ROLES = ['self', 'senior', 'other_dept', 'nurse', 'other', 'unknown'] as const;
export type AuthorRole = (typeof AUTHOR_ROLES)[number];
export const AUTHOR_ROLE_LABELS: Readonly<Record<AuthorRole, string>> = {
  self: '自分',
  senior: '上級医',
  other_dept: '他科',
  nurse: '看護',
  other: 'その他',
  unknown: '不明',
};

/** 1回に入れる文の上限（文字） */
export const TEXT_LIMIT = 20_000;

export const NewSource = z.strictObject({
  kind: z.enum(SOURCE_KINDS),
  authorRole: z.enum(AUTHOR_ROLES),
  /** 記載・実施の日時。分からなければ null（推測で埋めない。docs/04 の 2 の 5） */
  at: DateTime.nullable(),
  text: z.string().min(1).max(TEXT_LIMIT),
});
export type NewSource = z.infer<typeof NewSource>;
