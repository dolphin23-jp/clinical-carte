// 日（YYYY-MM-DD）。carte は暦日をそのまま持つ（CA-004）。時刻帯は日本だけで、変換をしない（docs/04 の 4）。
// core は時計に触れないので、いまの時刻（ミリ秒）は引数で受け取る。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** その時刻（UNIX のミリ秒）の、日本の日（YYYY-MM-DD）。 */
export function japanDay(timeMs: number): string {
  if (!Number.isFinite(timeMs)) throw new RangeError('時刻は有限の数（ミリ秒）');
  return new Date(timeMs + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 実在する日（YYYY-MM-DD）か。2月30日などは false。 */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY_PATTERN.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1900 || year > 2199) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}
