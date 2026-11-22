// 段K3（CA-059）：基準範囲の印。値は架空（synthetic）。範囲の数は、取り込んだ表（reference.gen.ts）から読む（試験に数を直書きしない）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { LAB_REFERENCES, rangeText, REFERENCE_CONFIRMED, REFERENCE_SOURCES, referenceMark } from '../src/index.ts';

const man = { age: 72, sex: 'male' as const };
const ref = (name: string) => {
  const r = LAB_REFERENCES.find((x) => x.name === name);
  if (r === undefined) throw new Error(name);
  return r;
};
const rangeFor = (name: string, sex: 'any' | 'M' | 'F') => {
  const r = ref(name).ranges.find((x) => x.sex === sex) ?? ref(name).ranges.find((x) => x.sex === 'any');
  if (r === undefined) throw new Error(name);
  return r;
};

describe('基準範囲の印（K3）', () => {
  test('表は出典つきで、本人の確認まで未確認', () => {
    expect(REFERENCE_CONFIRMED).toBe(false);
    for (const r of LAB_REFERENCES) expect(REFERENCE_SOURCES.some((s) => s.id === r.source)).toBe(true);
  });
  test('上限より上は高い・下限より下は低い・間は範囲内。性別ごとの範囲を使う', () => {
    const hb = rangeFor('Hb', 'M');
    expect(referenceMark({ name: 'Hb', value: hb.high + 0.1, comparator: null, unit: 'g/dL' }, man).state).toBe('high');
    expect(referenceMark({ name: 'Hb', value: hb.low - 0.1, comparator: null, unit: null }, man).state).toBe('low');
    expect(referenceMark({ name: 'Hb', value: (hb.low + hb.high) / 2, comparator: null, unit: 'g/dL' }, man)).toMatchObject({ state: 'in', range: hb });
    const f = rangeFor('Hb', 'F');
    expect(referenceMark({ name: 'Hb', value: f.low + 0.01, comparator: null, unit: 'g/dL' }, { age: 40, sex: 'female' }).state).toBe('in');
    expect(rangeText(referenceMark({ name: 'Hb', value: 10, comparator: null, unit: 'g/dL' }, man))).toBe(`${String(hb.low)}–${String(hb.high)} g/dL`);
  });
  test('比べないとき（正常としない）：単位が違う・書き方が多い項目の単位なし・小児・性別に合う範囲なし・表にない・数でない', () => {
    expect(referenceMark({ name: 'Hb', value: 10, comparator: null, unit: 'g/L' }, man)).toMatchObject({ state: 'unknown', skip: 'unit' });
    expect(referenceMark({ name: 'WBC', value: 12.3, comparator: null, unit: null }, man)).toMatchObject({ state: 'unknown', skip: 'unit' });
    expect(referenceMark({ name: 'Hb', value: 10, comparator: null, unit: null }, { age: 10, sex: 'male' })).toMatchObject({ state: 'unknown', skip: 'age' });
    expect(referenceMark({ name: 'Hb', value: 10, comparator: null, unit: null }, { age: 50, sex: 'other' })).toMatchObject({ state: 'unknown', skip: 'sex' });
    expect(referenceMark({ name: 'プロカルシトニン', value: 10, comparator: null, unit: null }, man)).toMatchObject({ state: 'unknown', skip: 'no_range' });
    expect(referenceMark({ name: 'Hb', value: null, comparator: null, unit: null }, man)).toMatchObject({ state: 'unknown', skip: 'not_number' });
  });
  test('不等号：言えるときだけ', () => {
    const crp = rangeFor('CRP', 'any');
    if (crp.low <= 0) expect(referenceMark({ name: 'CRP', value: crp.high, comparator: '<', unit: 'mg/dL' }, man).state).toBe('in');
    expect(referenceMark({ name: 'CRP', value: crp.high + 1, comparator: '>', unit: 'mg/dL' }, man).state).toBe('high');
    expect(referenceMark({ name: 'CRP', value: crp.high + 1, comparator: '<', unit: 'mg/dL' }, man)).toMatchObject({ state: 'unknown', skip: 'comparator' });
  });
  test('性質：不等号のない数は、範囲との大小どおり', () => {
    const r = rangeFor('Na', 'any');
    fc.assert(
      fc.property(fc.double({ min: 50, max: 200, noNaN: true }), (x) => {
        const m = referenceMark({ name: 'Na', value: x, comparator: null, unit: 'mEq/L' }, man);
        expect(m.state).toBe(x > r.high ? 'high' : x < r.low ? 'low' : 'in');
      }),
    );
  });
});
