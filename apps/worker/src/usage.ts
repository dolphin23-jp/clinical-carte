// AI を呼んだ回数（日ごと。CA-022）。書くのは、日付と整数だけ。
import type { Db } from './db.ts';
import { int } from './db.ts';

/** 1日の上限の、仮の値（設定 DAILY_AI_LIMIT で変えられる。使ってから決める） */
export const DEFAULT_DAILY_AI_LIMIT = 300;

export async function callsOn(db: Db, day: string): Promise<number> {
  return int(await db.prepare('SELECT calls FROM usage_daily WHERE day = ?').bind(day).first(), 'calls') ?? 0;
}

export async function countCall(db: Db, day: string): Promise<void> {
  await db.prepare('INSERT INTO usage_daily (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1').bind(day).run();
}
