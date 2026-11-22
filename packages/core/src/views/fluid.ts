// 水分の出入りと体重の、日ごとの集計（段K8。CA-069。CA-058 の A7）。決定論で、AI を使わない。保存しない。判定しない。
// 記録が読んだ値（経過表と同じ、外した値・同じ値の二重を除いたもの）から、書かれた日ごとに、入る量・出る量を項目ごとに足し、体重を並べる。
//  - **同じ単位の値だけを足す**（mL は mL、mL/日 は mL/日、cc は cc。換算しない）。単位の書かれていない値・不等号つきの値・数で書かれていない値・
//    時間あたり・体重あたりの値（mL/hr・mL/kg/hr）・字に見つからない AI の数は、足さずに理由つきで並べる（黙って捨てない）。
//  - **書かれていない量を補わない**：合計はいつも「書かれた分だけの合計」。差（入 − 出）は、その日に入・出の両方に同じ単位の合計があるときだけ（「書かれた分の差」）。
//  - 日は、値に書かれた日時の日（集計の区切り〔朝の締めの時刻など〕は補わない）。日時のない値は、どの日にも入れず、数だけを返す。値のない日は返さない。
//  - 体重は、書かれたとおりに日ごとに並べ、前に書かれた体重（同じ単位の数）との差を添える。良い・悪いの語は使わない。
import { compareDateTime } from '../time/datetime.ts';

/** 入る量の項目（名前の表の正規の名前。carte で足した名前は labs/extra-names.ts） */
export const FLUID_IN_NAMES: readonly string[] = ['輸液量', '飲水量', '経口摂取量', '経管栄養量'];
/** 出る量の項目 */
export const FLUID_OUT_NAMES: readonly string[] = ['尿量', 'ドレーン排液量', '胃管排液量', '嘔吐量', '出血量'];
export const FLUID_WEIGHT_NAME = '体重';

/** 足さなかった理由 */
export const FLUID_SKIPS = ['no_unit', 'comparator', 'not_number', 'rate', 'unseen'] as const;
export type FluidSkip = (typeof FLUID_SKIPS)[number];
export const FLUID_SKIP_LABELS: Readonly<Record<FluidSkip, string>> = {
  no_unit: '単位の記載なし（足していません）',
  comparator: '不等号つき（足していません）',
  not_number: '数で書かれていない（足していません）',
  rate: '時間あたり・体重あたりの値（足していません。換算しません）',
  unseen: '字に見つからない AI の数（足していません）',
};

/** 集計に使う値の形（サーバーの行の、使う分だけ） */
export interface FluidObservation {
  readonly id: string;
  readonly sourceId: string;
  readonly at: string | null;
  readonly name: string | null;
  readonly value: number | null;
  readonly comparator: string | null;
  readonly valueText: string;
  readonly unit: string | null;
  readonly unseen?: boolean;
}

export interface FluidEntry {
  readonly id: string;
  readonly sourceId: string;
  readonly at: string;
  readonly name: string;
  /** 書かれた値（不等号・値・単位。書かれたとおり） */
  readonly text: string;
  readonly value: number | null;
  readonly unit: string | null;
  /** 足さなかった理由（足した値は null） */
  readonly skip: FluidSkip | null;
}

/** 同じ単位の値の和 */
export interface FluidSum {
  /** 書かれた単位（最初に出てきた書き方） */
  readonly unit: string;
  readonly total: number;
  /** 和の字（足した値の小数の桁にそろえる） */
  readonly text: string;
  /** 足した値の数 */
  readonly count: number;
}

export interface FluidItem {
  readonly name: string;
  /** 書かれた値（時刻の順） */
  readonly entries: readonly FluidEntry[];
  /** 項目の中の、単位ごとの和（足した値があるときだけ） */
  readonly sums: readonly FluidSum[];
}

export interface FluidSide {
  /** 書かれた項目だけ（書かれていない項目は出さない） */
  readonly items: readonly FluidItem[];
  /** 項目をまたいだ、単位ごとの和（書かれた分だけの合計） */
  readonly totals: readonly FluidSum[];
  /** 足さなかった値の数 */
  readonly skipped: number;
}

export interface FluidWeight {
  readonly entry: FluidEntry;
  /** 前に書かれた体重（同じ単位の、不等号のない数）からの差。前がない・単位が違う・この値が数でないときは null */
  readonly change: { readonly value: number; readonly text: string; readonly unit: string; readonly fromAt: string } | null;
}

export interface FluidDay {
  readonly day: string;
  readonly intake: FluidSide;
  readonly output: FluidSide;
  /** 書かれた分の差（入 − 出）。その日に、入・出の両方に和がある単位だけ */
  readonly balance: readonly FluidSum[];
  readonly weights: readonly FluidWeight[];
}

export interface FluidSummary {
  /** 値のある日だけ（古い順） */
  readonly days: readonly FluidDay[];
  /** 日時がなく、どの日にも入れなかった値の数 */
  readonly undated: number;
}

const unitKey = (u: string): string => u.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
/** 時間あたり・体重あたりの単位（量ではない。足さない） */
const RATE = /\/(?:h|hr|時|時間|分|min|kg)(?![a-z])/u;

/** 小数の桁（和・差の字を、足した値の桁にそろえるため） */
function decimals(v: number): number {
  const s = String(v);
  if (s.includes('e')) return 0;
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function sumOf(values: readonly { value: number; unit: string }[]): FluidSum[] {
  const groups = new Map<string, { unit: string; values: number[] }>();
  for (const v of values) {
    const k = unitKey(v.unit);
    const g = groups.get(k) ?? { unit: v.unit, values: [] };
    g.values.push(v.value);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => {
    const places = Math.max(0, ...g.values.map(decimals));
    const total = round(g.values.reduce((a, b) => a + b, 0), places);
    return { unit: g.unit, total, text: total.toFixed(places), count: g.values.length };
  });
}

function skipOf(o: FluidObservation): FluidSkip | null {
  if (o.unseen === true) return 'unseen';
  if (o.comparator !== null) return 'comparator';
  if (o.value === null || !Number.isFinite(o.value)) return 'not_number';
  if (o.unit === null || o.unit.trim() === '') return 'no_unit';
  if (RATE.test(unitKey(o.unit))) return 'rate';
  return null;
}

const entryOf = (o: FluidObservation & { at: string; name: string }): FluidEntry => ({
  id: o.id,
  sourceId: o.sourceId,
  at: o.at,
  name: o.name,
  text: `${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`,
  value: o.value,
  unit: o.unit,
  skip: skipOf(o),
});

function sideOf(entries: readonly FluidEntry[], names: readonly string[]): FluidSide {
  const items: FluidItem[] = [];
  for (const name of names) {
    const own = entries.filter((e) => e.name === name);
    if (own.length === 0) continue;
    items.push({ name, entries: own, sums: sumOf(own.filter((e) => e.skip === null).map((e) => ({ value: e.value as number, unit: e.unit as string }))) });
  }
  const used = entries.filter((e) => e.skip === null && names.includes(e.name));
  return { items, totals: sumOf(used.map((e) => ({ value: e.value as number, unit: e.unit as string }))), skipped: entries.filter((e) => e.skip !== null && names.includes(e.name)).length };
}

/** 差の字（+300・−300・±0）。桁は、和の字の桁にそろえる */
export function signedText(value: number, places: number): string {
  if (value === 0) return `±${(0).toFixed(places)}`;
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(places)}`;
}

const placesOf = (text: string): number => {
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
};

/** 日ごとの水分の出入りと体重 */
export function fluidDays(observations: readonly FluidObservation[]): FluidSummary {
  const watched = new Set([...FLUID_IN_NAMES, ...FLUID_OUT_NAMES, FLUID_WEIGHT_NAME]);
  const mine = observations
    .map((o, index) => ({ o, index }))
    .filter(({ o }) => o.name !== null && watched.has(o.name));
  const undated = mine.filter(({ o }) => o.at === null).length;
  const dated = mine
    .filter((x): x is { o: FluidObservation & { at: string; name: string }; index: number } => x.o.at !== null)
    .sort((a, b) => compareDateTime(a.o.at, b.o.at) || a.index - b.index)
    .map(({ o }) => entryOf(o));
  const days = [...new Set(dated.map((e) => e.at.slice(0, 10)))].sort();

  // 体重：前に書かれた体重（同じ単位の数）との差
  let previous: { readonly value: number; readonly unit: string; readonly at: string } | null = null;
  const weightOf = new Map<string, FluidWeight>();
  for (const e of dated.filter((x) => x.name === FLUID_WEIGHT_NAME)) {
    const usable = e.value !== null && Number.isFinite(e.value) && e.skip !== 'comparator' && e.skip !== 'unseen' && e.unit !== null && e.unit.trim() !== '' ? { value: e.value, unit: e.unit, at: e.at } : null;
    let change: FluidWeight['change'] = null;
    if (usable !== null && previous !== null && unitKey(previous.unit) === unitKey(usable.unit)) {
      const places = Math.max(decimals(previous.value), decimals(usable.value));
      const value = round(usable.value - previous.value, places);
      change = { value, text: signedText(value, places), unit: usable.unit, fromAt: previous.at };
    }
    weightOf.set(e.id, { entry: e, change });
    if (usable !== null) previous = usable;
  }

  return {
    undated,
    days: days.map((day) => {
      const own = dated.filter((e) => e.at.slice(0, 10) === day);
      const intake = sideOf(own, FLUID_IN_NAMES);
      const output = sideOf(own, FLUID_OUT_NAMES);
      const balance: FluidSum[] = [];
      for (const i of intake.totals) {
        const o = output.totals.find((x) => unitKey(x.unit) === unitKey(i.unit));
        if (o === undefined) continue;
        const places = Math.max(placesOf(i.text), placesOf(o.text));
        const total = round(i.total - o.total, places);
        balance.push({ unit: i.unit, total, text: signedText(total, places), count: i.count + o.count });
      }
      const weights = own.filter((e) => e.name === FLUID_WEIGHT_NAME).map((e) => weightOf.get(e.id) as FluidWeight);
      return { day, intake, output, balance, weights };
    }),
  };
}

/** いちばん新しい日（値のある日のうち）。なければ null */
export function latestFluidDay(summary: FluidSummary): FluidDay | null {
  return summary.days.at(-1) ?? null;
}
