// グラフの文字（日時の短い書き方など）。
import type { ChartTime } from '@clinical-carte/core';

/** 「11/20 09:00」「11/20（日のみ）」 */
export function shortWhen(at: string, time?: ChartTime): string {
  const md = `${String(Number(at.slice(5, 7)))}/${String(Number(at.slice(8, 10)))}`;
  if (at.length === 10 || time?.dateOnly === true) return `${md}（日のみ）`;
  return `${md} ${at.slice(11, 16)}`;
}

/** 縦の目盛りの数の書き方（小数は必要なだけ） */
export function tickText(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}
