// 基準範囲の印（段K3。CA-059）：記録の値を、出典つきの基準範囲（reference.gen.ts。Playbook から取り込んだ JCCLS 共用基準範囲）と比べる。純関数。
//
// - 基準範囲は、健常者の中央 95%の区間で、臨床判断値ではない。本人が施設の範囲と照らして確かめるまで「未確認の目安」（REFERENCE_CONFIRMED）。
// - 比べるのは、(1) 名前がカタログの正規の名前で範囲がある、(2) 単位がカタログの単位と同じ（単位の書かれていない値は、その項目の書き方が1つだけのときだけ。
//   WBC・RBC・Plt は書き方が多く、単位がないと桁が読めないので比べない）、(3) 成人（REFERENCE_MIN_AGE 以上）、(4) 性別に合う範囲がある、のときだけ。
//   ほかは「比べない」（unknown）で、理由を返す。正常とはしない。
// - 不等号つきの値は、確かに言えるときだけ（「<0.1」は、下限が 0 以下で上限以下なら範囲内、下限以下なら低い。「>X」は上限以上なら高い）。
import type { Sex } from '../record/schema.ts';
import { LAB_NAMES } from './catalog.gen.ts';
import { LAB_REFERENCES, type LabReference, REFERENCE_MIN_AGE, REFERENCE_SOURCES, type ReferenceRange, type ReferenceSource } from './reference.gen.ts';

export type ReferenceState = 'high' | 'low' | 'in' | 'unknown';
export type ReferenceSkip = 'no_range' | 'unit' | 'age' | 'sex' | 'not_number' | 'comparator';

export const REFERENCE_SKIP_NAMES: Readonly<Record<ReferenceSkip, string>> = {
  no_range: '基準範囲の表にない項目',
  unit: '単位が表と違う・書かれていない',
  age: '成人の範囲のため（18歳未満）',
  sex: '性別に合う範囲がない',
  not_number: '数でない値',
  comparator: '不等号つきで、範囲の内外が言えない',
};

export interface ReferenceMark {
  readonly state: ReferenceState;
  /** 比べた範囲（比べなかったときは null） */
  readonly range: ReferenceRange | null;
  readonly unit: string | null;
  readonly source: ReferenceSource | null;
  readonly skip: ReferenceSkip | null;
}

export interface ReferenceValue {
  /** 正規の名前（なければ null） */
  readonly name: string | null;
  readonly value: number | null;
  readonly comparator: string | null;
  readonly unit: string | null;
}

const norm = (u: string): string => u.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/** 値を基準範囲と比べる（比べられないときは unknown と理由） */
export function referenceMark(v: ReferenceValue, patient: { readonly age: number; readonly sex: Sex }): ReferenceMark {
  const skip = (why: ReferenceSkip, ref: LabReference | null = null): ReferenceMark => ({ state: 'unknown', range: null, unit: ref?.unit ?? null, source: null, skip: why });
  const ref = v.name === null ? undefined : LAB_REFERENCES.find((r) => r.name === v.name);
  if (ref === undefined) return skip('no_range');
  if (v.value === null || !Number.isFinite(v.value)) return skip('not_number', ref);
  if (v.unit === null) {
    const units = LAB_NAMES.find((e) => e.name === ref.name)?.units ?? [];
    if (units.length !== 1) return skip('unit', ref);
  } else if (norm(v.unit) !== norm(ref.unit)) return skip('unit', ref);
  if (patient.age < REFERENCE_MIN_AGE) return skip('age', ref);
  const want = patient.sex === 'male' ? 'M' : patient.sex === 'female' ? 'F' : null;
  const range = ref.ranges.find((r) => r.sex === 'any') ?? (want === null ? undefined : ref.ranges.find((r) => r.sex === want));
  if (range === undefined) return skip('sex', ref);
  const source = REFERENCE_SOURCES.find((s) => s.id === ref.source) ?? null;
  const mark = (state: ReferenceState): ReferenceMark => ({ state, range, unit: ref.unit, source, skip: null });
  const x = v.value;
  switch (v.comparator) {
    case null:
    case '':
    case '=':
      return mark(x > range.high ? 'high' : x < range.low ? 'low' : 'in');
    case '<':
    case '<=':
    case '≦':
    case '≤':
      if (x <= range.low) return mark('low');
      if (range.low <= 0 && x <= range.high) return mark('in');
      return skip('comparator', ref);
    case '>':
    case '>=':
    case '≧':
    case '≥':
      if (x >= range.high) return mark('high');
      return skip('comparator', ref);
    default:
      return skip('comparator', ref);
  }
}

/** 範囲の短い書き方（「13.7–16.8 g/dL」） */
export function rangeText(m: ReferenceMark): string {
  return m.range === null ? '' : `${String(m.range.low)}–${String(m.range.high)}${m.unit === null ? '' : ` ${m.unit}`}`;
}

export { LAB_REFERENCES, REFERENCE_CONFIRMED, REFERENCE_MIN_AGE, REFERENCE_NOTE, REFERENCE_SOURCES } from './reference.gen.ts';
export type { LabReference, ReferenceRange, ReferenceSource } from './reference.gen.ts';
