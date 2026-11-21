// 文に書かれた日時の言い方を、決まった規則で、日時（YYYY-MM-DD か YYYY-MM-DDTHH:mm）にする（docs/04 の 2 の 5）。
// AI に日時を作らせない：AI は「どこに書いてあるか」（引用）を返すだけで、日時にするのは、ここ。読めなければ null（推測で埋めない）。
//
// 読む形（全角・半角を問わない）：
//  - 年月日：2026-11-20、2026/11/20、2026年11月20日、R8.11.20 は読まない（元号は読まない）
//  - 月日：11/20、11月20日 … 年は、基準の日にいちばん近い年（前の年・同じ年・次の年のうち）
//  - 時刻：8:30、08:30、8時30分、8時 … 日がなければ、基準の日の時刻
//  - 相対：今日・本日・昨日・一昨日・おととい・明日・昨夜・今朝・前日・翌日・翌朝・N日前・N日後・N週間前（7×N 日） … 基準の日から
//    （「Nか月前」は、日が決まらないので読まない）
//    （「N時間後」は読まない。「6時間後」の「6時」を時刻と取り違えない）
//  - 病日：入院N日目・第N病日・N病日目 … 受診の開始の日から（第1病日＝開始の日）
import { daysBetween } from './datetime.ts';
import { isDay } from './day.ts';

export interface WhenContext {
  /** 基準の日（その記載の日）。分からなければ null：相対の言い方・年のない月日は読まない */
  readonly refDay: string | null;
  /** 受診の開始の日（病日を読むため）。なければ null */
  readonly encounterStart: string | null;
  /** 日の書かれていない時刻だけの言い方（「0:15」）を読む日。なければ refDay。
   *  記載の中で日をまたいだと本人が確かめた場所より後ろの時刻は、翌日（CA-047） */
  readonly timeDay?: string | null;
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

// 「6時間後」の「6時」は時刻ではない（「時」のすぐ後ろに「間」が続くものは読まない）
const TIME = /(?<![\d:])(\d{1,2})(?::(\d{2})|時(?!間)(?:(\d{1,2})分)?)(?![\d:])/u;

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
  // N週間前・N週前（7×N 日。書かれた数のとおりに数える）。「Nか月前」は日が決まらないので読まない
  m = /(?<!\d)(\d{1,2})週間?(前|後)/u.exec(text);
  if (m !== null) return ctx.refDay === null ? null : addDays(ctx.refDay, (m[2] === '前' ? -1 : 1) * 7 * Number(m[1]));
  const relative: readonly [RegExp, number][] = [
    [/一昨日|おととい/u, -2],
    [/昨日|昨夜|昨晩|きのう|前日/u, -1],
    [/今日|本日|今朝|今夕|今夜|きょう/u, 0],
    [/明日|あす|あした|翌日|翌朝/u, 1],
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
  if (day === NO_DAY) {
    const base = ctx.timeDay ?? ctx.refDay;
    return time === null || base === null ? null : `${base}T${time}`;
  }
  return time === null ? day : `${day}T${time}`;
}

/** 文の中の日時の候補を探す形：年月日（と時刻）・月日（と時刻）・時刻。「3/3 mm」のような、単位の続く「数/数」は月日にしない */
const CANDIDATE =
  /(?<!\d)\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?: ?\d{1,2}:\d{2}(?![\d:]))?|(?<![\d/])\d{1,2}(?:\/\d{1,2}(?![\d/]| ?[A-Za-zμ%])|月\d{1,2}日)(?: ?\d{1,2}:\d{2}(?![\d:]))?|(?<![\d:])\d{1,2}:\d{2}(?![\d:])/gu;

/**
 * 文に書かれた日時の候補（書かれた順・重なりなし・max 件まで）。入れる欄で、記載の日時を選ぶ手がかりにするだけで、
 * 自動では使わない（どれがこの記載の日時かは、本人が選ぶ）。読み方は parseWhen と同じ。
 */
export function whenCandidates(text: string, ctx: WhenContext, max = 3): string[] {
  const out: string[] = [];
  for (const m of normalize(text).matchAll(CANDIDATE)) {
    const at = parseWhen(m[0], ctx);
    if (at === null || out.includes(at)) continue;
    out.push(at);
    if (out.length >= max) break;
  }
  return out;
}

/** 日を足す（YYYY-MM-DD）。実在する日であること */
export function shiftDay(day: string, n: number): string {
  return addDays(day, n);
}

/**
 * 行の頭に書かれた日時（「16:00 BT 39.0…」の 16:00、「11/17 9:30 回診」）の引用。なければ null。
 * 温度板・経過の行を写した文で、その行の値の時刻にする（AI に頼らない。2026-11-21）。
 * 「16時〜22時」のような幅の始まり、「1/2 量」のような単位の続く「数/数」は、日時にしない。
 */
const LINE_HEAD =
  /^[ \t\u3000]*((?:\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}\/\d{1,2}(?![\d/]|[A-Za-zμ%])|\d{1,2}月\d{1,2}日)(?:[ \t\u3000]*\d{1,2}:\d{2}(?![\d:]))?|\d{1,2}:\d{2}(?![\d:])|\d{1,2}時(?!間)(?:\d{1,2}分)?)(?![ \t\u3000]*[〜~～\-－])/u;

/** 全角の英数字・記号を半角に（長さを変えない） */
const halfWidth = (text: string): string => text.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

export function lineHeadWhen(line: string): string | null {
  return LINE_HEAD.exec(halfWidth(line))?.[1] ?? null;
}

/** 時刻だけの言い方（日の書かれていない「0:15」「6時」）か */
const TIME_TOKEN = /(?<![\d:/])(\d{1,2})(?::(\d{2})|時(?!間)(?:(\d{1,2})分)?)(?![\d:])/gu;
/** 時刻の直前に、日が書かれている（「11/18 22:00」「11月18日 22時」「2026-11-18 22:00」） */
const DAY_BEFORE = /(?:\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)[ \u3000]*$/u;

/** 日をまたいだと見る、時刻の逆戻りの幅（時間）。これより小さい逆戻り（経過の行を、あとから書き足したもの）は聞かない */
export const NEXT_DAY_BACK_HOURS = 12;

export interface NextDayPoint {
  /** 逆戻りした時刻の、文の中の場所（そろえた文の場所。長さは変えていない） */
  readonly at: number;
  /** その時刻（HH:mm） */
  readonly time: string;
  /** それまでの、いちばん遅い時刻（HH:mm） */
  readonly before: string;
}

/**
 * 記載の中で、日をまたいだかもしれない場所：日の書かれていない時刻が、それまでのいちばん遅い時刻から
 * NEXT_DAY_BACK_HOURS 時間以上さかのぼった、最初の場所（「23:30 … 0:15 …」の 0:15）。なければ null。
 * 日をまたいだかどうかは決めない（書かれていない）。入れる欄で、本人に1回だけ確かめる（CA-047）。
 */
export function nextDayPoint(text: string): NextDayPoint | null {
  const folded = halfWidth(text);
  let max = -1;
  for (const m of folded.matchAll(TIME_TOKEN)) {
    const at = m.index;
    if (DAY_BEFORE.test(folded.slice(Math.max(0, at - 16), at))) continue;
    const h = Number(m[1]);
    const min = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : 0;
    if (h > 23 || min > 59) continue;
    const t = h * 60 + min;
    if (max >= 0 && max - t >= NEXT_DAY_BACK_HOURS * 60) return { at, time: `${two(h)}:${two(min)}`, before: `${two(Math.floor(max / 60))}:${two(max % 60)}` };
    if (t > max) max = t;
  }
  return null;
}
