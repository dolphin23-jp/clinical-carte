// 患者の、自動の見出し（CA-014。保存しない）：年齢・性別・いちばん新しい受診の種類と開始日。
// 呼び名・病室・ベッドの番号は持たない。主な問題は、問題の表ができてから足す（段2）。
import { daysBetween } from '../time/datetime.ts';
import { type EncounterKind, ENCOUNTER_KIND_LABELS, type Sex } from './schema.ts';

/**
 * いまの年齢の概算：記録した年齢に、記録した日からの満年数を足す。生年月日を持たないので、最大で1歳ずれる。
 * today が、記録した日より前（さかのぼって入れた）なら、記録した年齢のまま。
 */
export function ageNow(age: number, ageOn: string, today: string): number {
  const days = daysBetween(ageOn, today);
  return days <= 0 ? age : age + Math.floor(days / 365.25);
}

const SEX_SHORT: Readonly<Record<Sex, string>> = { male: '男', female: '女', other: '性別その他・不明' };

export interface HeadlineInput {
  readonly age: number;
  readonly ageOn: string;
  readonly sex: Sex;
  /** いちばん新しい受診（なければ null） */
  readonly encounter: { readonly kind: EncounterKind; readonly start: string; readonly end: string | null } | null;
}

/** 例：「72歳 男 ｜ 入院 2026-11-18〜」「58歳 女 ｜ 外来 2026-11-20」 */
export function headline(input: HeadlineInput, today: string): string {
  const who = `${String(ageNow(input.age, input.ageOn, today))}歳 ${SEX_SHORT[input.sex]}`;
  const e = input.encounter;
  if (e === null) return who;
  const start = e.start.slice(0, 10);
  const span = e.kind === 'inpatient' ? `${start}〜${e.end === null ? '' : e.end.slice(0, 10)}` : start;
  return `${who} ｜ ${ENCOUNTER_KIND_LABELS[e.kind]} ${span}`;
}

/** 病日（入院の日を第1病日とする）。受診の開始より前の日は null */
export function hospitalDay(encounterStart: string, at: string): number | null {
  const days = daysBetween(encounterStart.slice(0, 10), at.slice(0, 10));
  return days < 0 ? null : days + 1;
}
