// 段K8（CA-069）：水分の出入りと体重の、日ごとの集計。値はすべて架空（synthetic）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { EXTRA_LAB_NAMES, FLUID_IN_NAMES, FLUID_OUT_NAMES, FLUID_WEIGHT_NAME, type FluidObservation, fluidDays, LAB_NAMES, latestFluidDay, readLabText } from '../src/index.ts';

let seq = 0;
const obs = (name: string, at: string | null, valueText: string, unit: string | null, extra: Partial<FluidObservation> = {}): FluidObservation => {
  seq += 1;
  const value = Number(valueText.replace(/,/gu, ''));
  return { id: `o${String(seq)}`, sourceId: 's1', at, name, value: Number.isFinite(value) ? value : null, comparator: null, valueText, unit, ...extra };
};

describe('名前', () => {
  test('入・出・体重の項目は、名前の表にある（取り込んだ名前か、carte で足した名前）', () => {
    const all = new Set([...LAB_NAMES, ...EXTRA_LAB_NAMES].map((e) => e.name));
    for (const n of [...FLUID_IN_NAMES, ...FLUID_OUT_NAMES, FLUID_WEIGHT_NAME]) expect(all.has(n), n).toBe(true);
  });
  test('書かれた字から読める（量は書かれた単位のまま。cc は cc）', () => {
    const r = readLabText('輸液量 1500mL 飲水 300 mL ドレーン排液 120cc 尿量 1200 mL/日 BW 48.2kg');
    expect(r.rows.map((x) => `${x.name ?? ''}=${x.valueText} ${x.unit ?? ''}`)).toEqual(['輸液量=1500 mL', '飲水量=300 mL', 'ドレーン排液量=120 cc', '尿量=1200 mL/日', '体重=48.2 kg']);
    expect(r.unread).toEqual([]);
  });
});

describe('日ごとの集計', () => {
  test('同じ単位だけを足し、入・出の両方に和があるときだけ差を出す。書かれていない項目は出さない', () => {
    const s = fluidDays([
      obs('輸液量', '2026-11-20T10:00', '1000', 'mL'),
      obs('輸液量', '2026-11-20T18:00', '500', 'mL'),
      obs('飲水量', '2026-11-20', '300', 'mL'),
      obs('尿量', '2026-11-20T06:00', '1200', 'mL'),
      obs('ドレーン排液量', '2026-11-20T12:00', '80', 'mL'),
      obs('輸液量', '2026-11-21T10:00', '500', 'mL'),
    ]);
    expect(s.days.map((d) => d.day)).toEqual(['2026-11-20', '2026-11-21']);
    const d0 = s.days[0];
    expect(d0?.intake.items.map((i) => [i.name, i.sums.map((x) => x.text)])).toEqual([
      ['輸液量', ['1500']],
      ['飲水量', ['300']],
    ]);
    expect(d0?.intake.totals).toEqual([{ unit: 'mL', total: 1800, text: '1800', count: 3 }]);
    expect(d0?.output.totals.map((x) => x.text)).toEqual(['1280']);
    expect(d0?.balance.map((x) => x.text)).toEqual(['+520']);
    // 出の記載がない日は、差を出さない（補わない）
    const d1 = s.days[1];
    expect(d1?.output.items).toEqual([]);
    expect(d1?.balance).toEqual([]);
  });

  test('単位の違う値は足さない（mL と mL/日 と cc は別の和。差も同じ単位どうしだけ）', () => {
    const s = fluidDays([obs('輸液量', '2026-11-20T10:00', '1000', 'mL'), obs('尿量', '2026-11-20T10:00', '1500', 'mL/日'), obs('ドレーン排液量', '2026-11-20T12:00', '50', 'cc')]);
    const d = s.days[0];
    expect(d?.output.totals.map((x) => `${x.text} ${x.unit}`)).toEqual(['1500 mL/日', '50 cc']);
    expect(d?.balance).toEqual([]);
  });

  test('単位の記載なし・不等号つき・数でない・時間あたり・字に見つからない AI の数は足さず、理由つきで並べる', () => {
    const s = fluidDays([
      obs('尿量', '2026-11-20T08:00', '400', null),
      obs('尿量', '2026-11-20T09:00', '50', 'mL', { comparator: '<' }),
      obs('尿量', '2026-11-20T10:00', '少量', null, { value: null }),
      obs('尿量', '2026-11-20T11:00', '30', 'mL/hr'),
      obs('尿量', '2026-11-20T12:00', '200', 'mL', { unseen: true }),
      obs('尿量', '2026-11-20T13:00', '300', 'mL'),
    ]);
    const item = s.days[0]?.output.items[0];
    expect(item?.entries.map((e) => e.skip)).toEqual(['no_unit', 'comparator', 'not_number', 'rate', 'unseen', null]);
    expect(item?.sums).toEqual([{ unit: 'mL', total: 300, text: '300', count: 1 }]);
    expect(s.days[0]?.output.skipped).toBe(5);
  });

  test('日時のない値は、どの日にも入れず数だけ。値のない日は返さない', () => {
    const s = fluidDays([obs('輸液量', null, '500', 'mL'), obs('Cr', '2026-11-20', '1.2', 'mg/dL')]);
    expect(s.days).toEqual([]);
    expect(s.undated).toBe(1);
    expect(latestFluidDay(s)).toBeNull();
  });

  test('小数の和は、足した値の桁にそろえる', () => {
    const s = fluidDays([obs('出血量', '2026-11-20T10:00', '0.1', 'mL'), obs('出血量', '2026-11-20T11:00', '0.2', 'mL')]);
    expect(s.days[0]?.output.totals[0]?.text).toBe('0.3');
  });
});

describe('体重', () => {
  test('書かれたとおりに並べ、前に書かれた体重（同じ単位）との差を添える。単位が違う・ないときは差を出さない', () => {
    const s = fluidDays([
      obs('体重', '2026-11-18', '50.0', 'kg'),
      obs('体重', '2026-11-20T07:00', '49.4', 'kg'),
      obs('体重', '2026-11-21', '49', null),
      obs('体重', '2026-11-22', '49.6', 'kg'),
    ]);
    expect(s.days.map((d) => d.day)).toEqual(['2026-11-18', '2026-11-20', '2026-11-21', '2026-11-22']);
    expect(s.days.map((d) => d.weights.map((w) => w.change?.text ?? null))).toEqual([[null], ['−0.6'], [null], ['+0.2']]);
    expect(s.days[3]?.weights[0]?.change?.fromAt).toBe('2026-11-20T07:00');
    expect(fluidDays([obs('体重', '2026-11-18', '50', 'kg'), obs('体重', '2026-11-19', '50', 'kg')]).days[1]?.weights[0]?.change?.text).toBe('±0');
  });
});

describe('性質', () => {
  const items = [...FLUID_IN_NAMES, ...FLUID_OUT_NAMES];
  const arb = fc.array(
    fc.record({
      name: fc.constantFrom(...items, 'Cr', '体重'),
      day: fc.integer({ min: 18, max: 21 }),
      dated: fc.boolean(),
      value: fc.integer({ min: 0, max: 3000 }),
      unit: fc.constantFrom('mL', 'mL/日', 'cc', 'mL/hr', null),
      comparator: fc.constantFrom(null, null, null, '<'),
      unseen: fc.boolean(),
    }),
    { maxLength: 30 },
  );
  interface Row {
    name: string;
    day: number;
    dated: boolean;
    value: number;
    unit: string | null;
    comparator: string | null;
    unseen: boolean;
  }
  const build = (rows: readonly Row[]): FluidObservation[] =>
    rows.map((r, i) => ({ id: `p${String(i)}`, sourceId: 's', at: r.dated ? `2026-11-${String(r.day)}T10:00` : null, name: r.name, value: r.value, comparator: r.comparator, valueText: String(r.value), unit: r.unit, unseen: r.unseen }));

  test('和は、足した値の和に等しい。外した値（理由つき）は和に入らない。値のない日は返さない', () => {
    fc.assert(
      fc.property(arb, (rows) => {
        const list = build(rows);
        const s = fluidDays(list);
        for (const d of s.days) {
          for (const side of [d.intake, d.output]) {
            for (const item of side.items) {
              for (const sum of item.sums) {
                const used = item.entries.filter((e) => e.skip === null && e.unit === sum.unit);
                expect(sum.total).toBe(used.reduce((a, e) => a + (e.value ?? 0), 0));
                expect(sum.count).toBe(used.length);
              }
              // 足さなかった値（単位なし・不等号・時間あたり・字に見つからない数）は、どの和にも入らない
              const usedCount = item.sums.reduce((a, x) => a + x.count, 0);
              expect(usedCount).toBe(item.entries.filter((e) => e.skip === null).length);
              for (const e of item.entries.filter((x) => x.skip === null)) expect(e.unit).not.toBeNull();
            }
          }
          const mine = list.filter((o) => o.at?.slice(0, 10) === d.day && (items.includes(o.name ?? '') || o.name === '体重'));
          expect(mine.length).toBeGreaterThan(0);
          // 差は、入・出の両方に同じ単位の和があるときだけ
          for (const b of d.balance) {
            const i = d.intake.totals.find((x) => x.unit === b.unit);
            const o = d.output.totals.find((x) => x.unit === b.unit);
            expect(i !== undefined && o !== undefined).toBe(true);
            expect(b.total).toBe((i?.total ?? 0) - (o?.total ?? 0));
          }
        }
        for (const o of list.filter((x) => x.at !== null && (items.includes(x.name ?? '') || x.name === '体重'))) expect(s.days.some((d) => d.day === o.at?.slice(0, 10))).toBe(true);
        expect(s.undated).toBe(list.filter((o) => o.at === null && (items.includes(o.name ?? '') || o.name === '体重')).length);
      }),
    );
  });
});
