// 時刻の手がかり（CA-056）を、決まった規則で日時にする。純関数。AI は「基準と、ずれ」を返すだけで、日時の計算はここ。
// - base：note＝その記載の日時、arrival＝受診（来院・入院）の始まり
// - days・hours・minutes：ずれ（前は負）。time：その日の時刻（HH:MM）。part：時間帯（代表の時刻にし、「ごろ」）。spanDays：幅（「数日前」「先週」）
// - 基準の時刻が分からないのに時間のずれがあるとき、幅があるとき、時間帯だけのときは、「ごろ」の印（approx）を付ける。読めなければ null（推測で埋めない）
import { type DayPart, DAY_PART_NAMES, type WhenHint } from '../organize/answer.ts';

const DAY_MS = 86_400_000;
const two = (n: number): string => String(n).padStart(2, '0');

/** 時間帯の代表の時刻（「ごろ」の印と一緒に使う。並べるための仮の時刻） */
export const DAY_PART_TIMES: Readonly<Record<DayPart, string>> = {
  early_morning: '05:00',
  morning: '08:00',
  noon: '12:00',
  afternoon: '15:00',
  evening: '17:00',
  night: '21:00',
  late_night: '01:00',
};

export interface HintContext {
  /** 記載の日時（日だけ・日時・不明） */
  readonly noteAt: string | null;
  /** 受診の始まりの日時 */
  readonly encounterStart: string;
}

export interface ResolvedWhen {
  readonly at: string;
  /** おおよその印（「夕方ごろ」「11/15〜11/17ごろ」「ごろ」）。正確に決まるときは null */
  readonly approx: string | null;
}

const ms = (day: string, minutes: number): number => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) + minutes * 60_000;
const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const timeOf = (t: number): string => new Date(t).toISOString().slice(11, 16);
const short = (day: string): string => `${String(Number(day.slice(5, 7)))}/${String(Number(day.slice(8, 10)))}`;
const okNumber = (n: number | null, max: number): boolean => n === null || (Number.isFinite(n) && Math.abs(n) <= max);

export function resolveHint(hint: WhenHint, ctx: HintContext): ResolvedWhen | null {
  if (hint === null) return null;
  const { days, hours, minutes, time, part, spanDays } = hint;
  if (days === null && hours === null && minutes === null && time === null && part === null && spanDays === null) return null;
  if (!okNumber(days, 3650) || !okNumber(hours, 240) || !okNumber(minutes, 1440) || !okNumber(spanDays, 400) || (spanDays !== null && spanDays < 0)) return null;
  const base = hint.base === 'arrival' ? ctx.encounterStart : ctx.noteAt;
  if (base === null || !/^\d{4}-\d{2}-\d{2}/u.test(base)) return null;
  const baseDay = base.slice(0, 10);
  const baseTime = base.length >= 16 ? base.slice(11, 16) : null;
  const baseMin = baseTime === null ? 0 : Number(baseTime.slice(0, 2)) * 60 + Number(baseTime.slice(3, 5));
  const shiftMin = (days ?? 0) * 1440 + (hours ?? 0) * 60 + (minutes ?? 0);
  const t = ms(baseDay, baseMin + shiftMin);
  const day = dayOf(t);
  const marks: string[] = [];
  let at: string;
  const hm = time === null ? null : /^(\d{1,2}):(\d{2})$/u.exec(time);
  if (time !== null && (hm === null || Number(hm[1]) > 23 || Number(hm[2]) > 59)) return null;
  if (hm !== null) at = `${day}T${two(Number(hm[1]))}:${hm[2] ?? '00'}`;
  else if (part !== null) {
    at = `${day}T${DAY_PART_TIMES[part]}`;
    marks.push(`${DAY_PART_NAMES[part]}ごろ`);
  } else if ((hours ?? 0) !== 0 || (minutes ?? 0) !== 0) {
    // 時間のずれ：基準の時刻が分かれば、その時刻から。分からなければ日だけにして「ごろ」
    if (baseTime === null) {
      at = day;
      marks.push('ごろ');
    } else at = `${day}T${timeOf(t)}`;
  } else at = day;
  if (spanDays !== null && spanDays > 0) {
    const half = Math.round(spanDays / 2);
    marks.length = 0;
    marks.push(`${short(dayOf(t - half * DAY_MS))}〜${short(dayOf(t + half * DAY_MS))}ごろ`);
  }
  return { at, approx: marks.length === 0 ? null : marks.join('・') };
}
