// 文に書かれた日時の言い方を、決まった規則で、日時（YYYY-MM-DD か YYYY-MM-DDTHH:mm）にする（docs/04 の 2 の 5）。
// AI に日時を作らせない：AI は「どこに書いてあるか」（引用）を返すだけで、日時にするのは、ここ。読めなければ null（推測で埋めない）。
//
// 読む形（全角・半角を問わない）：
//  - 年月日：2026-11-20、2026/11/20、2026年11月20日、R8.11.20 は読まない（元号は読まない）
//  - 月日：11/20、11月20日 … 年は、基準の日にいちばん近い年（前の年・同じ年・次の年のうち）
//  - 時刻：8:30、08:30、8時30分、8時 … 日がなければ、基準の日の時刻
//  - 相対：今日・本日・昨日・一昨日・おととい・明日・昨夜・今朝・N日前・N日後 … 基準の日から
//  - 病日：入院N日目・第N病日・N病日目 … 受診の開始の日から（第1病日＝開始の日）
import { daysBetween } from './datetime.ts';
import { isDay } from './day.ts';

export interface WhenContext {
  /** 基準の日（その記載の日）。分からなければ null：相対の言い方・年のない月日は読まない */
  readonly refDay: string | null;
  /** 受診の開始の日（病日を読むため）。なければ null */
  readonly encounterStart: string | null;
}

const two = (n: number): string => String(n).padStart(2, '0');

function toDay(y: number, m: number, d: number): string | null {
  const day = `${String(y).padStart(4, '0')}-${two(m)}-${two(d)}`;
  return isDay(day) ? day : null;
}

function addDays(day: string, n: number): string {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 全角の英数字・記号を半角に、空白をつめる */
function normalize(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000\s]+/g, ' ')
    .trim();
}

const TIME = /(?<![\d:])(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分)?)(?![\d:])/u;

function readTime(text: string): string | null {
  const m = TIME.exec(text);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : 0;
  if (h > 23 || min > 59) return null;
  return `${two(h)}:${two(min)}`;
}

/** 年のない月日に、基準の日にいちばん近い年を付ける */
function nearestYear(m: number, d: number, refDay: string): string | null {
  const y = Number(refDay.slice(0, 4));
  const candidates = [y - 1, y, y + 1].map((year) => toDay(year, m, d)).filter((day): day is string => day !== null);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, day) => (Math.abs(daysBetween(refDay, day)) < Math.abs(daysBetween(refDay, best)) ? day : best));
}

/** 日の言い方を読む。日の言い方がなければ NO_DAY、読めなければ null */
const NO_DAY = Symbol('no-day');

function readDay(text: string, ctx: WhenContext): string | null | typeof NO_DAY {
  let m = /(?<!\d)(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?!\d)/u.exec(text);
  if (m !== null) return toDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(?<![\d/])(\d{1,2})(?:\/|月)(\d{1,2})日?(?![\d/])/u.exec(text);
  if (m !== null) return ctx.refDay === null ? null : nearestYear(Number(m[1]), Number(m[2]), ctx.refDay);
  m = /(?:入院|第)(\d{1,3})(?:日目|病日)|(?<!\d)(\d{1,3})病日目?/u.exec(text);
  if (m !== null) {
    const n = Number(m[1] ?? m[2]);
    return ctx.encounterStart === null || n < 1 ? null : addDays(ctx.encounterStart.slice(0, 10), n - 1);
  }
  m = /(?<!\d)(\d{1,3})日(前|後)/u.exec(text);
  if (m !== null) return ctx.refDay === null ? null : addDays(ctx.refDay, (m[2] === '前' ? -1 : 1) * Number(m[1]));
  const relative: readonly [RegExp, number][] = [
    [/一昨日|おととい/u, -2],
    [/昨日|昨夜|昨晩|きのう/u, -1],
    [/今日|本日|今朝|今夕|今夜|きょう/u, 0],
    [/明日|あす|あした/u, 1],
  ];
  for (const [re, n] of relative) if (re.test(text)) return ctx.refDay === null ? null : addDays(ctx.refDay, n);
  return NO_DAY;
}

/**
 * 日時の言い方を読む。読めなければ null。
 * 日も時刻も書かれていない（日時の言い方がない）ときも null。
 */
export function parseWhen(quote: string, ctx: WhenContext): string | null {
  const text = normalize(quote);
  if (text === '') return null;
  const day = readDay(text, ctx);
  if (day === null) return null;
  const time = readTime(text.replace(/(?<!\d)\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/u, '').replace(/\d{1,2}(?:\/|月)\d{1,2}日?/u, ''));
  if (day === NO_DAY) return time === null || ctx.refDay === null ? null : `${ctx.refDay}T${time}`;
  return time === null ? day : `${day}T${time}`;
}
