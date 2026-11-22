// グラフのための計算（保存しない。判定しない）。温度板・検査の推移・投薬の時間軸が、同じ時間の軸を使う。
// 正常範囲・基準・色分けは、ここにない（AGENTS.md の 1）。グラフに置くのは、数で書かれ、不等号のない値だけ。
// 単位は、書かれた単位がカタログの単位と違う値を、温度板に置かない（換算しない。表には残る）。
import { compareDateTime } from '../time/datetime.ts';
import { LAB_NAMES } from '../labs/catalog.gen.ts';

/** グラフの上の位置（ミリ秒。日本の時刻を、時刻帯の変換なしで数にしたもの）。日だけの値は、その日の正午に置き、印を付ける */
export interface ChartTime {
  readonly t: number;
  readonly dateOnly: boolean;
}

const DAY_MS = 86_400_000;

export function chartTime(at: string | null): ChartTime | null {
  if (at === null) return null;
  const y = Number(at.slice(0, 4));
  const m = Number(at.slice(5, 7));
  const d = Number(at.slice(8, 10));
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const base = Date.UTC(y, m - 1, d);
  if (at.length === 10) return { t: base + DAY_MS / 2, dateOnly: true };
  const h = Number(at.slice(11, 13));
  const min = Number(at.slice(14, 16));
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  return { t: base + h * 3_600_000 + min * 60_000, dateOnly: false };
}

/** 位置から、日（YYYY-MM-DD） */
export function dayOfTime(t: number): string {
  return new Date(Math.floor(t / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** グラフに置ける測定値の形（サーバーの行の、使う分だけ） */
export interface ChartObservation {
  readonly id: string;
  readonly sourceId: string;
  readonly at: string | null;
  readonly name: string | null;
  readonly nameRaw: string;
  readonly kind: 'lab' | 'vital' | null;
  readonly value: number | null;
  readonly comparator: string | null;
  readonly valueText: string;
  readonly unit: string | null;
}

export interface ChartPoint extends ChartTime {
  readonly at: string;
  readonly value: number;
  /** 血圧の下の値（拡張期）。血圧だけ */
  readonly low?: number;
  /** 書かれた値（表示用） */
  readonly text: string;
}

export interface VitalPanel {
  /** 段の種類（色の見分けに使う）。map 以降は、値があるときだけの段 */
  readonly id: 'bt' | 'hr' | 'bp' | 'rr' | 'spo2' | 'map' | 'o2' | 'jcs' | 'gcs' | 'uo';
  /** 段ごとに違う鍵（尿量は、書かれた単位ごとに段を分けるため） */
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly points: readonly ChartPoint[];
}

const unitKey = (u: string): string => u.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/** カタログの単位（書き方）。カタログにない名前は、空 */
function catalogUnits(name: string): readonly string[] {
  return LAB_NAMES.find((e) => e.name === name)?.units.map(unitKey) ?? [];
}

/** 単位が書かれていないか、カタログの単位のどれかと同じ（換算せずに、同じ目盛りに置ける） */
function sameScale(o: ChartObservation, name: string): boolean {
  if (o.unit === null) return true;
  const units = catalogUnits(name);
  return units.length === 0 || units.includes(unitKey(o.unit));
}

/** グラフに置ける（数で書かれ、不等号がなく、日時がある） */
function plottable(o: ChartObservation): o is ChartObservation & { value: number; at: string } {
  return o.value !== null && Number.isFinite(o.value) && o.comparator === null && o.at !== null;
}

const byTime = (a: ChartPoint, b: ChartPoint): number => a.t - b.t;

const SINGLE: readonly { id: VitalPanel['id']; name: string; unit: string; item: string }[] = [
  { id: 'bt', name: '体温', unit: '℃', item: '体温' },
  { id: 'hr', name: '心拍数', unit: '/分', item: '心拍数' },
  { id: 'rr', name: '呼吸数', unit: '/分', item: '呼吸数' },
  { id: 'spo2', name: 'SpO2', unit: '%', item: 'SpO2' },
];

/** 温度板の段（体温・心拍数・血圧・呼吸数・SpO2 の順）。この5つは、値のない段も返す（空の段として描く）。MAP・酸素流量・JCS・GCS・尿量は、値があるときだけ */
export function vitalPanels(observations: readonly ChartObservation[]): VitalPanel[] {
  const point = (o: ChartObservation & { value: number; at: string }, extra: Partial<ChartPoint> = {}): ChartPoint | null => {
    const time = chartTime(o.at);
    return time === null ? null : { ...time, at: o.at, value: o.value, text: o.valueText, ...extra };
  };
  const single = (item: string): ChartPoint[] =>
    observations
      .filter((o) => o.name === item && plottable(o) && sameScale(o, item))
      .map((o) => point(o as ChartObservation & { value: number; at: string }))
      .filter((p): p is ChartPoint => p !== null)
      .sort(byTime);

  // 血圧：同じ文の、同じ日時の、収縮期と拡張期を組にする（「BP 120/80」は、2行になって入る）
  const systolic = observations.filter((o) => o.name === '収縮期血圧' && plottable(o) && sameScale(o, '収縮期血圧'));
  const diastolic = observations.filter((o) => o.name === '拡張期血圧' && plottable(o) && sameScale(o, '拡張期血圧'));
  const used = new Set<string>();
  const bp: ChartPoint[] = [];
  for (const s of systolic) {
    const pair = diastolic.find((d) => !used.has(d.id) && d.sourceId === s.sourceId && d.at === s.at);
    if (pair !== undefined) used.add(pair.id);
    const p = point(s as ChartObservation & { value: number; at: string }, pair === undefined ? { text: s.valueText } : { low: pair.value as number, text: `${s.valueText}/${pair.valueText}` });
    if (p !== null) bp.push(p);
  }

  const panels: VitalPanel[] = SINGLE.map((s) => ({ id: s.id, key: s.id, name: s.name, unit: s.unit, points: single(s.item) }));
  panels.splice(2, 0, { id: 'bp', key: 'bp', name: '血圧', unit: 'mmHg', points: bp.sort(byTime) });

  // 値があるときだけの段（2026-11-21 の本人の決定）：MAP・酸素流量・JCS・GCS・尿量。判定しない（範囲の帯・色分けなし）
  const extra = (id: VitalPanel['id'], name: string, unit: string, item: string): VitalPanel => ({ id, key: id, name, unit, points: single(item) });
  const optional: VitalPanel[] = [extra('map', 'MAP', 'mmHg', 'MAP'), extra('o2', '酸素流量', 'L/分', '酸素流量'), extra('jcs', 'JCS', '', 'JCS'), extra('gcs', 'GCS', '点', 'GCS')];
  // 尿量：書かれた単位ごとに段を分ける（合計・時間あたり・体重あたりを、同じ目盛りに混ぜない。換算しない）
  const urine = new Map<string, { unit: string; points: ChartPoint[] }>();
  for (const o of observations) {
    if (o.name !== '尿量' || !plottable(o)) continue;
    const p = point(o);
    if (p === null) continue;
    const k = o.unit === null ? '' : unitKey(o.unit);
    const group = urine.get(k) ?? { unit: o.unit ?? '', points: [] };
    group.points.push(p);
    urine.set(k, group);
  }
  for (const [k, g] of urine) optional.push({ id: 'uo', key: `uo:${k}`, name: g.unit === '' ? '尿量（単位の記載なし）' : '尿量', unit: g.unit, points: g.points.sort(byTime) });
  // MAP は血圧の下、酸素流量は SpO2 の下、意識と尿量は最後
  const order: VitalPanel['id'][] = ['bt', 'hr', 'bp', 'map', 'rr', 'spo2', 'o2', 'jcs', 'gcs', 'uo'];
  return [...panels, ...optional.filter((p) => p.points.length > 0)].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export interface LabTrend {
  /** まとめの鍵（名前と、書かれた単位） */
  readonly key: string;
  readonly name: string;
  /** 書かれた単位（書かれていなければ null。単位の違う値は、別の推移にする：換算しない） */
  readonly unit: string | null;
  readonly points: readonly ChartPoint[];
  /** グラフに置けなかった値の数（不等号・定性・日時なし） */
  readonly hidden: number;
  /** 先生が「同じ目盛り」と決めてつないだ推移（CA-051）：つないだ単位の書き方（書かれていないものは null）と、決めの id。つないでいなければ、ない */
  readonly joined?: { readonly units: readonly (string | null)[]; readonly linkIds: readonly string[] };
}

/** 先生が決めた「同じ目盛り」（CA-051。全患者に共通）：項目の名前と、2つの単位の書き方（'' は単位の記載なし）。換算はしない */
export interface ScaleLink {
  readonly id: string;
  readonly name: string;
  readonly unitA: string;
  readonly unitB: string;
}

/** 単位の書き方の、比べるための形（'' は単位の記載なし） */
export const scaleUnitKey = (unit: string | null): string => (unit === null ? '' : unitKey(unit.trim()));

/**
 * 検査の推移：項目と、書かれた単位ごとに、日時の順。最初に出てきた順。
 * 先生が「同じ目盛り」と決めた組（links。CA-051）は、1つの推移につなぐ（換算しない。点の字には、書かれた単位を添える）
 */
export function labTrends(observations: readonly ChartObservation[], links: readonly ScaleLink[] = []): LabTrend[] {
  // 決めた組を、項目ごとに、単位の鍵どうしでつなぐ（a〜b、b〜c なら a〜c も同じ推移）
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r) ?? r;
    return r;
  };
  const linkIdsOf = new Map<string, string[]>();
  for (const l of links) {
    const a = `${l.name}\u0000${scaleUnitKey(l.unitA === '' ? null : l.unitA)}`;
    const b = `${l.name}\u0000${scaleUnitKey(l.unitB === '' ? null : l.unitB)}`;
    if (a === b) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
    parent.set(a, find(a));
    parent.set(b, find(b));
  }
  for (const l of links) {
    const root = find(`${l.name}\u0000${scaleUnitKey(l.unitA === '' ? null : l.unitA)}`);
    linkIdsOf.set(root, [...(linkIdsOf.get(root) ?? []), l.id]);
  }
  const groups = new Map<string, { name: string; unit: string | null; units: (string | null)[]; points: ChartPoint[]; hidden: number }>();
  for (const o of observations) {
    if (o.kind === 'vital') continue;
    const name = o.name ?? o.nameRaw;
    const unit = o.unit === null ? null : o.unit.trim();
    const own = `${name}\u0000${scaleUnitKey(unit)}`;
    const key = find(own);
    const group = groups.get(key) ?? { name, unit, units: [], points: [], hidden: 0 };
    groups.set(key, group);
    if (!group.units.some((u) => scaleUnitKey(u) === scaleUnitKey(unit))) group.units.push(unit);
    if (!plottable(o)) {
      group.hidden += 1;
      continue;
    }
    const time = chartTime(o.at);
    if (time === null) {
      group.hidden += 1;
      continue;
    }
    // つないだ推移では、点の字に書かれた単位を添える（どの書き方の値かを、いつも見せる）
    const joined = linkIdsOf.has(key);
    group.points.push({ ...time, at: o.at, value: o.value, text: joined ? `${o.valueText}${unit === null ? '（単位の記載なし）' : ` ${unit}`}` : o.valueText });
  }
  // 同じ項目の推移（単位の違うもの・単位の書かれていないもの）は、隣どうしに並べる。単位の書かれていない値を、書かれた単位の推移に入れない
  // （「WBC 12.3」と「WBC 12300 /μL」のように、単位がないことは同じ目盛りであることを意味しない。桁を当てない・換算しない）
  const entries = [...groups.entries()];
  const firstIndex = new Map<string, number>();
  entries.forEach(([, g], i) => {
    if (!firstIndex.has(g.name)) firstIndex.set(g.name, i);
  });
  return entries
    .map(([key, g], i) => ({ key, g, i }))
    .sort((a, b) => (firstIndex.get(a.g.name) ?? 0) - (firstIndex.get(b.g.name) ?? 0) || a.i - b.i)
    .map(({ key, g }) => {
      const ids = linkIdsOf.get(key);
      const base = { key, name: g.name, unit: g.unit, points: g.points.sort(byTime), hidden: g.hidden };
      return ids !== undefined && g.units.length > 1 ? { ...base, joined: { units: g.units, linkIds: ids } } : base;
    });
}

/** 時間の範囲：値の最初から最後まで。受診の開始・終わりも含める。値が1つ・同じ時刻だけのときは、前後に半日ずつ広げる */
export function timeDomain(times: readonly number[], encounterStart: string | null, encounterEnd: string | null): [number, number] | null {
  const all = [...times];
  const start = chartTime(encounterStart);
  const end = chartTime(encounterEnd);
  if (start !== null) all.push(start.dateOnly ? start.t - DAY_MS / 2 : start.t);
  if (end !== null) all.push(end.dateOnly ? end.t + DAY_MS / 2 : end.t);
  if (all.length === 0) return null;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (max - min < DAY_MS) {
    const mid = (min + max) / 2;
    min = mid - DAY_MS / 2;
    max = mid + DAY_MS / 2;
  }
  return [min, max];
}

export interface DayTick {
  /** その日の始まり（0時）の位置 */
  readonly t: number;
  readonly day: string;
  /** 「11/18」 */
  readonly label: string;
  /** 病日（入院の受診だけ。開始の日を第1病日） */
  readonly hospitalDay: number | null;
}

/** 日の目盛り：範囲に入る日の始まり。多すぎるときは、間引く（maxTicks 以下に） */
export function dayTicks(domain: [number, number], maxTicks: number, inpatientStart: string | null): DayTick[] {
  const first = Math.ceil(domain[0] / DAY_MS) * DAY_MS;
  const days: number[] = [];
  for (let t = first; t <= domain[1]; t += DAY_MS) days.push(t);
  const step = Math.max(1, Math.ceil(days.length / Math.max(1, maxTicks)));
  const startDay = inpatientStart === null ? null : Date.UTC(Number(inpatientStart.slice(0, 4)), Number(inpatientStart.slice(5, 7)) - 1, Number(inpatientStart.slice(8, 10)));
  return days
    .filter((_, i) => i % step === 0)
    .map((t) => {
      const day = dayOfTime(t);
      return {
        t,
        day,
        label: `${String(Number(day.slice(5, 7)))}/${String(Number(day.slice(8, 10)))}`,
        hospitalDay: startDay === null || t < startDay ? null : Math.round((t - startDay) / DAY_MS) + 1,
      };
    });
}

/** 縦の目盛り：きりのよい値で、count 個ほど。値が1つ・同じ値だけのときも、幅を持たせる */
export function niceTicks(min: number, max: number, count = 4): { min: number; max: number; ticks: number[] } {
  let lo = min;
  let hi = max;
  if (hi - lo < 1e-9) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.05 : 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { min: start, max: end, ticks };
}

/** いちばん新しい値（日時のある値のうち） */
/**
 * いちばん新しい値。日時の比べ方は、どの画面でも同じ（compareDateTime：同じ日なら、時刻のない値〔日だけ〕は、時刻のある値より前）。
 * グラフの上では日だけの値を日の真ん中に置くが、「最新」はその位置で決めない（2026-11-21：画面ごとに「最新」が食い違ったため）
 */
export function latestPoint(points: readonly ChartPoint[]): ChartPoint | null {
  let best: ChartPoint | null = null;
  for (const p of points) if (best === null || compareDateTime(p.at, best.at) >= 0) best = p;
  return best;
}

/** 「最新」が時刻のある値で、同じ日に時刻のない（日だけの）値もある：どちらが新しいかは、記録から分からない */
export function untimedSameDay(points: readonly ChartPoint[], latest: ChartPoint | null): boolean {
  return latest !== null && !latest.dateOnly && points.some((p) => p.dateOnly && p.at === latest.at.slice(0, 10));
}

export interface MedicationSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * 投薬の帯：日時の分かる記録を順にたどり、「中止」の記録のあとを除いて、隣り合う記録のあいだをつなぐ。
 * 最後の記録より先へは伸ばさない（続いているかどうかは、書かれていないので補わない）。
 */
export function medicationSpans(entries: readonly { readonly action: string | null; readonly at: string | null }[]): MedicationSpan[] {
  const dated = entries
    .map((e) => ({ action: e.action, time: chartTime(e.at) }))
    .filter((e): e is { action: string | null; time: ChartTime } => e.time !== null)
    .sort((a, b) => a.time.t - b.time.t);
  const spans: MedicationSpan[] = [];
  for (let i = 1; i < dated.length; i += 1) {
    const prev = dated[i - 1];
    const cur = dated[i];
    if (prev === undefined || cur === undefined || prev.action === 'stop' || cur.time.t === prev.time.t) continue;
    const last = spans[spans.length - 1];
    if (last !== undefined && last.to === prev.time.t) spans[spans.length - 1] = { from: last.from, to: cur.time.t };
    else spans.push({ from: prev.time.t, to: cur.time.t });
  }
  return spans;
}

/** 二重をたたむ値の形（サーバーの行の、使う分だけ） */
export interface FoldObservation {
  readonly id: string;
  readonly sourceId: string;
  readonly at: string | null;
  readonly name: string | null;
  readonly nameRaw: string;
  readonly value: number | null;
  readonly comparator: string | null;
  readonly valueText: string;
  /** バイタルは1日に何度も測るので、時刻が 60 分より離れていれば別の測定（2026-11-22） */
  readonly kind?: 'lab' | 'vital' | null;
}

/**
 * 同じ値の二重（CA-049）：経過・入院時などの記載の中で挙げ直した値のうち、同じ日に、検査結果・バイタルの文に、同じ項目・同じ値（不等号も同じ）が
 * あるもの。経過表・検査の推移と表・いま・問題では出さない（消さない。記録の各記載の「整理した事実」には残る）。
 * 検査結果・バイタルの文どうしは、たたまない（別の時刻に測った同じ値でありうる）。fromValueSheet は、その文が検査結果・バイタルの文か。
 */
export function foldedObservationIds(list: readonly FoldObservation[], fromValueSheet: (sourceId: string) => boolean): Set<string> {
  const key = (o: FoldObservation): string | null => {
    if (o.at === null) return null;
    const name = o.name ?? o.nameRaw.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    const value = o.value !== null && Number.isFinite(o.value) ? String(o.value) : o.valueText.normalize('NFKC').replace(/\s+/g, '');
    return `${o.at.slice(0, 10)}|${name}|${o.comparator ?? ''}|${value}`;
  };
  // バイタルは、同じ日・同じ項目・同じ値でも、どちらにも時刻があって 60 分より離れていれば、別の測定（14:25 の BP 92/54 と、18:00 の BP 96/54 の 54 は別。2026-11-22）。
  // 検査値は、朝の採血を回診の記載で挙げ直すので、これまでどおり同じ日なら同じ
  const minutes = (at: string): number | null => (at.length >= 16 ? Number(at.slice(11, 13)) * 60 + Number(at.slice(14, 16)) : null);
  const sheet = new Map<string, (number | null)[]>();
  for (const o of list) {
    const k = key(o);
    if (k !== null && o.at !== null && fromValueSheet(o.sourceId)) sheet.set(k, [...(sheet.get(k) ?? []), minutes(o.at)]);
  }
  const out = new Set<string>();
  for (const o of list) {
    const k = key(o);
    if (k === null || o.at === null || fromValueSheet(o.sourceId)) continue;
    const times = sheet.get(k);
    if (times === undefined) continue;
    const mine = minutes(o.at);
    if (o.kind !== 'vital' || mine === null || times.some((t) => t === null || Math.abs(t - mine) <= 60)) out.add(o.id);
  }
  return out;
}
