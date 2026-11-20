// 画面の表示の、小さな道具（文字を作るだけ）。
import { IDENTIFIER_KINDS, IDENTIFIER_LABELS, SHAPE_KINDS, SHAPE_LABELS } from '@clinical-carte/core';

/** 端末の、いまの日（YYYY-MM-DD）と時刻（HH:mm）。入力欄の初期値に使う（保存する日時は、本人が確かめて送ったもの） */
export function nowLocal(): { day: string; time: string } {
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  return { day: `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, time: `${two(d.getHours())}:${two(d.getMinutes())}` };
}

/** 日と時刻の欄から、日時を作る（時刻が空なら、日だけ） */
export function joinDateTime(day: string, time: string): string {
  return time === '' ? day : `${day}T${time}`;
}

/** 日時の表示：「2026-11-20 09:00」「2026-11-20」「日時不明」 */
export function showDateTime(at: string | null): string {
  return at === null ? '日時不明' : at.replace('T', ' ');
}

const LABELS: Readonly<Record<string, string>> = { ...Object.fromEntries(IDENTIFIER_KINDS.map((k) => [k, IDENTIFIER_LABELS[k]])), ...Object.fromEntries(SHAPE_KINDS.map((k) => [k, SHAPE_LABELS[k]])) };

/** 置き換えた種類と件数の文（なければ null）。置き換えた文字そのものは、どこにもない */
export function replacedSummary(replaced: Readonly<Record<string, number>>): string | null {
  const parts = Object.entries(replaced)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${LABELS[kind] ?? kind} ${String(n)}`);
  return parts.length === 0 ? null : parts.join('、');
}
