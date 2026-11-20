// 日時（docs/04 の 4）：`YYYY-MM-DD` か `YYYY-MM-DDTHH:mm`。日本の時刻で、時刻帯の変換をしない。日だけ分かるときは、日だけ。
// 分からないときは null（推測で埋めない）。
import { isDay } from './day.ts';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 日、または、日と時刻（分まで）。 */
export function isDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 10) return isDay(value);
  if (value.length !== 16 || value.charAt(10) !== 'T') return false;
  return isDay(value.slice(0, 10)) && TIME.test(value.slice(11));
}

export function dayOf(dateTime: string): string {
  return dateTime.slice(0, 10);
}

/** 時刻（HH:mm）。日だけのときは null */
export function timeOf(dateTime: string): string | null {
  return dateTime.length === 16 ? dateTime.slice(11) : null;
}

/**
 * 並べる順（古い順）。日時のないもの（null）は、最後。同じ日の中では、時刻のないものが先（文字の順のまま）。
 */
export function compareDateTime(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** 2つの日の間の日数（b − a）。どちらも実在する日であること */
export function daysBetween(a: string, b: string): number {
  const ms = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}
