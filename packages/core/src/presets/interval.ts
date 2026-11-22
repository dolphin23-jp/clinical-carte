// clinical-playbook の packages/core/src/presets/interval.ts から写した（2026-11-22）。carte に合わせて変えたところ：なし（計算はそのまま）。
//
// 区間の計算（P004a。旧 JOSLER-core の presets/interval.ts を、計算はそのままで持ち込んだ。docs/12-scores.md の 3）【案】。
//
// - 範囲の値（4000~8000）・比較記号の値（<0.3）・同じ幅の中の複数の値から式を計算するため、値を区間で持つ。
//   端を含むか（loIn・hiIn）も持つ（範囲は両端を含まない間。旧 repo の D-042）。無限の端は含まない。
// - 足し算・引き算・最小・最大・単調な関数（ln・log10・sqrt）・clamp は、端を含むかをそのまま運ぶ。
//   掛け算・割り算・べき乗は、端を含むとみなす（広めにとる。本当の値はいつも区間の中にあり、答えが逆にならない）。
// - 0 を含む区間で割るとき、関数の定義域の外だけの区間は、分からない（null）。定義域に一部だけ入る区間は、定義域の中だけを使う。
// - 比べ（compareInterval）は3つの答え：区間のすべてが成り立てば true、すべてが成り立たなければ false、またがれば null（分からない）。
//   比べる前に両端をそろえる（snap12。有効数字12桁、小さい結果は小数点以下9桁）。10進の小数を2進の浮動小数で引く・割ると、1.4 − 1.1 = 0.2999999999999998 のように
//   境目の閾値（>= 0.3）から外れるため。端の値そのもの（make の結果）は変えない（含む・含まないの組と端の値の対応を保つ）。
import type { CompareOp } from './schema.ts';

export type Interval = { lo: number; loIn: boolean; hi: number; hiIn: boolean };
// 3つの答え：true（成り立つ）、false（成り立たない）、null（分からない）
export type Tri = boolean | null;

export const pointInterval = (x: number): Interval => ({ lo: x, loIn: true, hi: x, hiIn: true });

// 12桁の有効数字にそろえる（無限・NaN はそのまま）。3桁までの小数の足し算・引き算・割り算・掛け算の誤差（1e-16 の程度）は消え、
// 閾値と本当に違う値（3桁の小数の比なら少なくとも 1e-8 の程度）は残る。
// 絶対値が100より小さい結果は、小数点以下9桁にそろえる（有効数字12桁より粗い）。大きな数どうしの引き算は桁が落ち
// （100 − 99.993 = 0.007000000000005002）、結果の有効数字12桁では誤差の割合が大きすぎて 0.007 に戻らないため
export const snap12 = (x: number): number => (!Number.isFinite(x) ? x : Math.abs(x) < 100 ? Number(x.toFixed(9)) : Number(x.toPrecision(12)));

// 端をそろえる：無限の端は含まない。空の区間・NaN は null
function make(lo: number, loIn: boolean, hi: number, hiIn: boolean): Interval | null {
  if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
  const l = lo === -Infinity ? false : loIn;
  const h = hi === Infinity ? false : hiIn;
  if (lo > hi || (lo === hi && !(l && h)) || lo === Infinity || hi === -Infinity) return null;
  return { lo, loIn: l, hi, hiIn: h };
}

export function intervalOf(lo: number, loIn: boolean, hi: number, hiIn: boolean): Interval | null {
  return make(lo, loIn, hi, hiIn);
}

// 2つを覆う最小の区間
export function hull(a: Interval, b: Interval): Interval {
  const lo = Math.min(a.lo, b.lo);
  const hi = Math.max(a.hi, b.hi);
  const loIn = (a.lo === lo && a.loIn) || (b.lo === lo && b.loIn);
  const hiIn = (a.hi === hi && a.hiIn) || (b.hi === hi && b.hiIn);
  return { lo, loIn, hi, hiIn };
}

export function addInterval(a: Interval, b: Interval): Interval | null {
  return make(a.lo + b.lo, a.loIn && b.loIn, a.hi + b.hi, a.hiIn && b.hiIn);
}

function negInterval(a: Interval): Interval {
  return { lo: -a.hi, loIn: a.hiIn, hi: -a.lo, hiIn: a.loIn };
}

export function subInterval(a: Interval, b: Interval): Interval | null {
  return addInterval(a, negInterval(b));
}

// 端どうしの積（0 と無限の積は 0）
const times = (x: number, y: number) => (x === 0 || y === 0 ? 0 : x * y);

export function mulInterval(a: Interval, b: Interval): Interval | null {
  const ps = [times(a.lo, b.lo), times(a.lo, b.hi), times(a.hi, b.lo), times(a.hi, b.hi)];
  return make(Math.min(...ps), true, Math.max(...ps), true);
}

// 区間が 0 を含むか
const hasZero = (a: Interval) => (a.lo < 0 || (a.lo === 0 && a.loIn)) && (a.hi > 0 || (a.hi === 0 && a.hiIn));

// 割り算。割る区間が 0 を含めば分からない（null）。端どうしを直接割る（1/b を掛けない。3.3 ÷ 1.1 が 3 ちょうどのまま）
export function divInterval(a: Interval, b: Interval): Interval | null {
  if (hasZero(b)) return null;
  // b はすべて正かすべて負。端の 0（含まない）は無限になる（分子の符号の側へ。0 と無限の商は 0）
  const positive = b.lo >= 0;
  const quot = (x: number, y: number): number => {
    if (x === 0) return 0;
    if (y === 0) return (x > 0) === positive ? Infinity : -Infinity;
    // 両方が無限の端なら、符号の側の無限（広めにとる）。有限を無限で割れば 0（-0 にしない）
    if (!Number.isFinite(x) && !Number.isFinite(y)) return (x > 0) === (y > 0) ? Infinity : -Infinity;
    return x / y + 0;
  };
  const qs = [quot(a.lo, b.lo), quot(a.lo, b.hi), quot(a.hi, b.lo), quot(a.hi, b.hi)];
  return make(Math.min(...qs), true, Math.max(...qs), true);
}

export function minInterval(a: Interval, b: Interval): Interval {
  const lo = Math.min(a.lo, b.lo);
  const loIn = a.lo === b.lo ? a.loIn || b.loIn : a.lo < b.lo ? a.loIn : b.loIn;
  const hi = Math.min(a.hi, b.hi);
  const hiIn = a.hi === b.hi ? a.hiIn && b.hiIn : a.hi < b.hi ? a.hiIn : b.hiIn;
  return { lo, loIn, hi, hiIn };
}

export function maxInterval(a: Interval, b: Interval): Interval {
  return negInterval(minInterval(negInterval(a), negInterval(b)));
}

// 定義域 [lo, ∞) か (lo, ∞) との重なり
function fromDomain(a: Interval, lo: number, loIn: boolean): Interval | null {
  if (a.lo > lo || (a.lo === lo && (loIn || !a.loIn))) return a;
  return make(lo, loIn, a.hi, a.hiIn);
}

// 増える関数を端に当てる（端を含むかはそのまま）
function monotone(a: Interval | null, f: (x: number) => number): Interval | null {
  return a === null ? null : make(f(a.lo), a.loIn, f(a.hi), a.hiIn);
}

export const lnInterval = (a: Interval): Interval | null => monotone(fromDomain(a, 0, false), Math.log);
export const log10Interval = (a: Interval): Interval | null => monotone(fromDomain(a, 0, false), Math.log10);
export const sqrtInterval = (a: Interval): Interval | null => monotone(fromDomain(a, 0, true), Math.sqrt);

// べき乗（指数は定数）。整数の指数は負の数にも使い、整数でない指数は 0 以上（負の指数は 0 より大きい）の値だけに使う
export function powInterval(a: Interval, e: number): Interval | null {
  if (!Number.isFinite(e)) return null;
  if (e === 0) return pointInterval(1);
  const f = (x: number) => x ** e;
  if (!Number.isInteger(e)) {
    const d = fromDomain(a, 0, e > 0);
    if (d === null) return null;
    const [x, y] = [f(d.lo), f(d.hi)];
    return make(Math.min(x, y), true, Math.max(x, y), true);
  }
  if (e < 0 && hasZero(a)) return null;
  // 開いた 0 の端は、その側からの極限（負の側の 0 は -0。(-0) ** -1 は −∞）
  const ends = [f(a.lo === 0 ? 0 : a.lo), f(a.hi === 0 ? -0 : a.hi)];
  // 偶数の指数で 0 をまたぐときは、最小が 0
  if (e > 0 && e % 2 === 0 && a.lo < 0 && a.hi > 0) return make(0, true, Math.max(...ends), true);
  return make(Math.min(...ends), true, Math.max(...ends), true);
}

// clamp(v, lo, hi) = max(lo, min(v, hi))
export function clampInterval(v: Interval, lo: Interval, hi: Interval): Interval {
  return maxInterval(lo, minInterval(v, hi));
}

// 区間のすべての値が「x op t」を満たすか（3つの答え。D-042）。比べる前に両端を12桁にそろえる（snap12）
export function compareInterval(a0: Interval, op: CompareOp, t: number): Tri {
  const a: Interval = { lo: snap12(a0.lo), loIn: a0.loIn, hi: snap12(a0.hi), hiIn: a0.hiIn };
  switch (op) {
    case '>=':
      return a.lo >= t ? true : a.hi < t || (a.hi === t && !a.hiIn) ? false : null;
    case '>':
      return a.lo > t || (a.lo === t && !a.loIn) ? true : a.hi <= t ? false : null;
    case '<=':
      return a.hi <= t ? true : a.lo > t || (a.lo === t && !a.loIn) ? false : null;
    case '<':
      return a.hi < t || (a.hi === t && !a.hiIn) ? true : a.lo >= t ? false : null;
  }
}

// 点の値が「x op t」を満たすか（2つの答え）
export function compareNumber(x: number, op: CompareOp, t: number): boolean {
  switch (op) {
    case '>=':
      return x >= t;
    case '>':
      return x > t;
    case '<=':
      return x <= t;
    case '<':
      return x < t;
  }
}

export function intervalContains(a: Interval, x: number): boolean {
  return (x > a.lo || (x === a.lo && a.loIn)) && (x < a.hi || (x === a.hi && a.hiIn));
}

// 3つの答えの論理（Kleene）
export const triNot = (a: Tri): Tri => (a === null ? null : !a);
export function triAll(xs: readonly Tri[]): Tri {
  if (xs.includes(false)) return false;
  return xs.includes(null) ? null : true;
}
export function triAny(xs: readonly Tri[]): Tri {
  if (xs.includes(true)) return true;
  return xs.includes(null) ? null : false;
}
