// 経過の見方の「表示の窓」と「日の帯」（段H。2026-11-21）。純関数：画面の状態（いま見ている範囲・選んだ日）から、表示に使う数を計算するだけ。
// 時刻は chartTime と同じ数（日本の時刻を、時刻帯の変換なしで数にしたミリ秒）。判定しない（色・正常範囲・警告を作らない）。
// いま見ている範囲・選んだ日は、画面のメモリだけに持つ（端末に保存しない。AGENTS.md の 2）。
import { chartTime, dayOfTime, type DayTick, dayTicks } from './chart.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type Window = readonly [number, number];

export const RANGE_PRESETS = ['24h', '3d', '7d', 'all'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_PRESET_NAMES: Readonly<Record<RangePreset, string>> = { '24h': '24時間', '3d': '3日', '7d': '7日', all: '全期間' };
const PRESET_MS: Readonly<Record<Exclude<RangePreset, 'all'>, number>> = { '24h': DAY_MS, '3d': 3 * DAY_MS, '7d': 7 * DAY_MS };

/** 既定の範囲：最後の記録までの3日（2026-11-21 の本人の決定。CA-053） */
export const DEFAULT_RANGE: RangePreset = '3d';
/** いちばん狭い窓（これより拡大しない） */
export const WINDOW_MIN_MS = 2 * HOUR_MS;
/** 窓の右端の余白（最後の記録が、端に張りつかないように） */
const RIGHT_PAD = 0.04;

/** 窓を、全体の範囲の中に収める。幅は WINDOW_MIN_MS 以上・全体の幅以下 */
export function clampWindow(w: Window, full: Window): Window {
  const fullSpan = full[1] - full[0];
  let span = Math.max(WINDOW_MIN_MS, w[1] - w[0]);
  if (span >= fullSpan) return [full[0], full[1]];
  let from = w[0];
  if (from < full[0]) from = full[0];
  if (from + span > full[1]) from = full[1] - span;
  span = Math.min(span, fullSpan);
  return [from, from + span];
}

/**
 * 決まった範囲の窓：anchor（最後の記録の時刻）が右端の近くに来るようにする。
 * 全期間、または全体の幅より広い範囲なら、全体
 */
export function presetWindow(preset: RangePreset, full: Window, anchor: number): Window {
  if (preset === 'all') return [full[0], full[1]];
  const span = PRESET_MS[preset];
  const to = anchor + span * RIGHT_PAD;
  return clampWindow([to - span, to], full);
}

/** 窓を、時間の向きに動かす（delta は、ミリ秒。正なら新しい向き） */
export function panWindow(w: Window, full: Window, delta: number): Window {
  return clampWindow([w[0] + delta, w[1] + delta], full);
}

/** 窓を、center の時刻を中心に拡大・縮小する（factor が 1 より小さければ拡大） */
export function zoomWindow(w: Window, full: Window, factor: number, center: number): Window {
  const span = (w[1] - w[0]) * factor;
  const ratio = w[1] === w[0] ? 0.5 : (center - w[0]) / (w[1] - w[0]);
  const from = center - span * ratio;
  return clampWindow([from, from + span], full);
}

/** 1日の窓（その日の 0時〜24時） */
export function dayWindow(day: string): Window {
  const t = chartTime(day);
  const start = t === null ? 0 : t.t - DAY_MS / 2;
  return [start, start + DAY_MS];
}

/** 窓の中にある時刻か */
export const inWindow = (w: Window, t: number): boolean => t >= w[0] && t <= w[1];

export interface AxisTick extends DayTick {
  /** 日の始まり（day）か、時刻（hour） */
  readonly kind: 'day' | 'hour';
}

const HOUR_STEPS = [1, 2, 3, 6, 12] as const;

/**
 * 時間の目盛り：窓が2日以内なら時刻の目盛り（1・2・3・6・12時間ごとのうち、maxTicks に収まるもの。0時の目盛りは日付と病日）、
 * それより広ければ日の目盛り（dayTicks）
 */
export function axisTicks(w: Window, maxTicks: number, inpatientStart: string | null): AxisTick[] {
  const span = w[1] - w[0];
  if (span > 2 * DAY_MS) return dayTicks([w[0], w[1]], maxTicks, inpatientStart).map((t) => ({ ...t, kind: 'day' as const }));
  const step = (HOUR_STEPS.find((h) => span / (h * HOUR_MS) <= Math.max(2, maxTicks)) ?? 24) * HOUR_MS;
  const days = new Map(dayTicks([w[0] - DAY_MS, w[1] + DAY_MS], 1000, inpatientStart).map((d) => [d.t, d]));
  const out: AxisTick[] = [];
  for (let t = Math.ceil(w[0] / step) * step; t <= w[1]; t += step) {
    const dayStart = Math.floor(t / DAY_MS) * DAY_MS;
    const d = days.get(dayStart);
    if (t === dayStart && d !== undefined) out.push({ ...d, kind: 'day' });
    else out.push({ t, day: dayOfTime(t), label: `${String(Math.round((t - dayStart) / HOUR_MS))}時`, hospitalDay: null, kind: 'hour' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 日の帯：受診の始まりの日から、最後の記録の日（終わりが入っていれば、終わりの日）まで。
// 各日に、記録・バイタル・検査値・投薬・できごとが「あるか」の数だけを持つ（判定しない・値を見ない）

export interface StripDay {
  readonly day: string;
  /** 「11/18」 */
  readonly label: string;
  /** 曜日（日〜土） */
  readonly weekday: string;
  /** 病日（入院の受診だけ） */
  readonly hospitalDay: number | null;
  readonly sources: number;
  readonly vitals: number;
  readonly labs: number;
  readonly medications: number;
  readonly events: number;
}

export interface StripInput {
  readonly encounter: { readonly kind: 'er' | 'outpatient' | 'inpatient'; readonly start: string; readonly end: string | null };
  readonly sources: readonly { readonly at: string | null }[];
  readonly observations: readonly { readonly at: string | null; readonly kind: 'lab' | 'vital' | null }[];
  readonly medications: readonly { readonly at: string | null }[];
  readonly events: readonly { readonly at: string | null }[];
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;
/** 日の帯の、いちばん長い日数（それより長い受診は、新しい日から） */
export const STRIP_DAYS_MAX = 120;

export function dayStrip(input: StripInput): StripDay[] {
  const startDay = input.encounter.start.slice(0, 10);
  const all = [...input.sources, ...input.observations, ...input.medications, ...input.events].map((x) => x.at).filter((at): at is string => at !== null);
  let lastDay = startDay;
  for (const at of all) if (at.slice(0, 10) > lastDay) lastDay = at.slice(0, 10);
  if (input.encounter.end !== null && input.encounter.end.slice(0, 10) > lastDay) lastDay = input.encounter.end.slice(0, 10);
  const counts = new Map<string, { sources: number; vitals: number; labs: number; medications: number; events: number }>();
  const bump = (at: string | null, key: 'sources' | 'vitals' | 'labs' | 'medications' | 'events'): void => {
    if (at === null) return;
    const d = at.slice(0, 10);
    const c = counts.get(d) ?? { sources: 0, vitals: 0, labs: 0, medications: 0, events: 0 };
    c[key] += 1;
    counts.set(d, c);
  };
  for (const s of input.sources) bump(s.at, 'sources');
  for (const o of input.observations) bump(o.at, o.kind === 'vital' ? 'vitals' : 'labs');
  for (const m of input.medications) bump(m.at, 'medications');
  for (const e of input.events) bump(e.at, 'events');
  const first = chartTime(startDay);
  const last = chartTime(lastDay);
  if (first === null || last === null) return [];
  const out: StripDay[] = [];
  for (let t = first.t; t <= last.t; t += DAY_MS) {
    const day = dayOfTime(t);
    const c = counts.get(day) ?? { sources: 0, vitals: 0, labs: 0, medications: 0, events: 0 };
    out.push({
      day,
      label: `${String(Number(day.slice(5, 7)))}/${String(Number(day.slice(8, 10)))}`,
      weekday: WEEKDAYS[new Date(t).getUTCDay()] ?? '',
      hospitalDay: input.encounter.kind === 'inpatient' ? Math.round((t - first.t) / DAY_MS) + 1 : null,
      ...c,
    });
  }
  return out.slice(-STRIP_DAYS_MAX);
}
