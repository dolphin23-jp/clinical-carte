import { describe, expect, it, test } from 'vitest';

import { type ChartObservation, chartTime, dayTicks, foldedObservationIds, labTrends, latestPoint, medicationSpans, niceTicks, timeDomain, untimedSameDay, vitalPanels } from '../src/index.ts';

let n = 0;
const obs = (patch: Partial<ChartObservation>): ChartObservation => ({
  id: String((n += 1)),
  sourceId: 's1',
  at: '2026-11-20T06:00',
  name: null,
  nameRaw: 'x',
  kind: 'lab',
  value: 1,
  comparator: null,
  valueText: '1',
  unit: null,
  ...patch,
});

describe('時間の位置', () => {
  test('日時は、そのまま数に。日だけは、その日の正午に置き、印を付ける', () => {
    expect(chartTime('2026-11-20T06:30')).toEqual({ t: Date.UTC(2026, 10, 20, 6, 30), dateOnly: false });
    expect(chartTime('2026-11-20')).toEqual({ t: Date.UTC(2026, 10, 20, 12), dateOnly: true });
    expect(chartTime(null)).toBeNull();
  });
});

describe('温度板', () => {
  test('段は、体温・心拍数・血圧・呼吸数・SpO2 の順。値のない段も返す', () => {
    expect(vitalPanels([]).map((p) => [p.id, p.points.length])).toEqual([
      ['bt', 0],
      ['hr', 0],
      ['bp', 0],
      ['rr', 0],
      ['spo2', 0],
    ]);
  });

  test('置くのは、数で書かれ、不等号がなく、日時のある値だけ。日時の順', () => {
    const panels = vitalPanels([
      obs({ name: '体温', kind: 'vital', value: 37.2, valueText: '37.2', at: '2026-11-20T09:00' }),
      obs({ name: '体温', kind: 'vital', value: 38.4, valueText: '38.4', at: '2026-11-19' }),
      obs({ name: '体温', kind: 'vital', value: 39, comparator: '>', valueText: '39' }),
      obs({ name: '体温', kind: 'vital', value: 37, at: null }),
    ]);
    expect(panels[0]?.points.map((p) => [p.at, p.value, p.dateOnly])).toEqual([
      ['2026-11-19', 38.4, true],
      ['2026-11-20T09:00', 37.2, false],
    ]);
  });

  test('単位が書かれていて、カタログの単位と違う値は、置かない（換算しない）', () => {
    const panels = vitalPanels([
      obs({ name: '体温', kind: 'vital', value: 98.6, unit: '°F' }),
      obs({ name: '体温', kind: 'vital', value: 37, unit: '℃' }),
      obs({ name: '体温', kind: 'vital', value: 36.8, unit: null }),
    ]);
    expect(panels[0]?.points.map((p) => p.value).sort()).toEqual([36.8, 37]);
  });

  test('MAP・酸素流量・JCS・GCS・尿量の段は、値があるときだけ。尿量は、書かれた単位ごとに分ける（換算しない）', () => {
    const panels = vitalPanels([
      obs({ name: 'MAP', kind: 'vital', value: 67, valueText: '67', unit: null }),
      obs({ name: 'JCS', kind: 'vital', value: 3, valueText: '3', unit: null }),
      obs({ name: '酸素流量', kind: 'vital', value: 2, valueText: '2', unit: 'L/min' }),
      obs({ name: '尿量', kind: 'vital', value: 25, valueText: '25', unit: 'mL' }),
      obs({ name: '尿量', kind: 'vital', value: 0.43, valueText: '0.43', unit: 'mL/kg/hr' }),
    ]);
    expect(panels.map((p) => [p.key, p.points.length])).toEqual([
      ['bt', 0],
      ['hr', 0],
      ['bp', 0],
      ['map', 1],
      ['rr', 0],
      ['spo2', 0],
      ['o2', 1],
      ['jcs', 1],
      ['uo:ml', 1],
      ['uo:ml/kg/hr', 1],
    ]);
    expect(panels.filter((p) => p.id === 'uo').map((p) => p.unit)).toEqual(['mL', 'mL/kg/hr']);
  });

  test('血圧は、同じ文・同じ日時の収縮期と拡張期を組にする', () => {
    const panels = vitalPanels([
      obs({ name: '収縮期血圧', kind: 'vital', value: 120, valueText: '120', sourceId: 'a' }),
      obs({ name: '拡張期血圧', kind: 'vital', value: 80, valueText: '80', sourceId: 'a' }),
      obs({ name: '収縮期血圧', kind: 'vital', value: 98, valueText: '98', sourceId: 'b', at: '2026-11-19T22:00' }),
    ]);
    const bp = panels.find((p) => p.id === 'bp');
    expect(bp?.points.map((p) => [p.value, p.low, p.text])).toEqual([
      [98, undefined, '98'],
      [120, 80, '120/80'],
    ]);
  });
});

describe('検査の推移', () => {
  test('同じ項目の推移は、隣どうしに並べる（単位の書かれていない値は、書かれた単位の推移に入れない）', () => {
    const trends = labTrends([
      obs({ name: 'Lac', value: 3.6, valueText: '3.6', unit: 'mmol/L', at: '2026-11-21T10:48' }),
      obs({ name: 'pH', value: 7.31, valueText: '7.31', at: '2026-11-21T10:48' }),
      obs({ name: 'Lac', value: 2.8, valueText: '2.8', at: '2026-11-21T14:00' }),
    ]);
    expect(trends.map((t) => [t.name, t.unit])).toEqual([
      ['Lac', 'mmol/L'],
      ['Lac', null],
      ['pH', null],
    ]);
  });

  test('項目と、書かれた単位ごとに分ける（単位の違う値を、同じ線にしない）。置けない値は数える', () => {
    const trends = labTrends([
      obs({ name: 'WBC', value: 12.3, valueText: '12.3' }),
      obs({ name: 'WBC', value: 12300, valueText: '12300', unit: '/μL', at: '2026-11-21T06:00' }),
      obs({ name: 'WBC', value: 9.8, valueText: '9.8', at: '2026-11-21T06:00' }),
      obs({ name: 'CRP', value: 0.1, comparator: '<', valueText: '0.1' }),
      obs({ name: '体温', kind: 'vital', value: 37 }),
      obs({ name: null, nameRaw: '架空マーカー', value: 5, valueText: '5' }),
    ]);
    expect(trends.map((t) => [t.name, t.unit, t.points.map((p) => p.value), t.hidden])).toEqual([
      ['WBC', null, [12.3, 9.8], 0],
      ['WBC', '/μL', [12300], 0],
      ['CRP', null, [], 1],
      ['架空マーカー', null, [5], 0],
    ]);
  });
});

describe('軸', () => {
  test('時間の範囲は、値と受診の開始・終わりを含む。短すぎれば1日に広げる', () => {
    const t = Date.UTC(2026, 10, 20, 6);
    expect(timeDomain([t], null, null)).toEqual([t - 43_200_000, t + 43_200_000]);
    expect(timeDomain([], '2026-11-18T22:00', null)).toEqual([Date.UTC(2026, 10, 18, 10), Date.UTC(2026, 10, 19, 10)]);
    expect(timeDomain([t], '2026-11-18', '2026-11-25')?.[0]).toBe(Date.UTC(2026, 10, 18));
    expect(timeDomain([], null, null)).toBeNull();
  });

  test('日の目盛り：日の始まり、病日、多すぎれば間引く', () => {
    const ticks = dayTicks([Date.UTC(2026, 10, 18, 10), Date.UTC(2026, 10, 21, 10)], 10, '2026-11-18T22:00');
    expect(ticks.map((d) => [d.label, d.hospitalDay])).toEqual([
      ['11/19', 2],
      ['11/20', 3],
      ['11/21', 4],
    ]);
    expect(dayTicks([Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1)], 6, null).length).toBeLessThanOrEqual(6);
  });

  test('縦の目盛りは、きりのよい値。値が1つでも幅を持つ', () => {
    expect(niceTicks(36.4, 38.9, 4)).toEqual({ min: 36, max: 39, ticks: [36, 37, 38, 39] });
    const one = niceTicks(37, 37);
    expect(one.max).toBeGreaterThan(one.min);
  });
});

describe('medicationSpans', () => {
  const t = (at: string) => chartTime(at)?.t ?? NaN;
  it('つなぐのは記録のあいだだけで、中止のあとと最後の記録より先は描かない', () => {
    const spans = medicationSpans([
      { action: 'start', at: '2026-11-01T09:00' },
      { action: 'continue', at: '2026-11-03' },
      { action: 'stop', at: '2026-11-05T10:00' },
      { action: 'start', at: '2026-11-08T09:00' },
    ]);
    expect(spans).toEqual([{ from: t('2026-11-01T09:00'), to: t('2026-11-05T10:00') }]);
  });
  it('日時の分からない記録は飛ばす。1つだけなら帯はない', () => {
    expect(medicationSpans([{ action: 'start', at: null }, { action: 'start', at: '2026-11-01' }])).toEqual([]);
  });
});

describe('最新の値（どの画面も同じ決まり）', () => {
  test('同じ日なら、時刻のない値は時刻のある値より前。同じ日に時刻のない値があれば、そう分かる', () => {
    const hr = vitalPanels([
      obs({ name: '心拍数', kind: 'vital', value: 108, valueText: '108', at: '2026-11-21' }),
      obs({ name: '心拍数', kind: 'vital', value: 128, valueText: '128', at: '2026-11-21T11:45' }),
      obs({ name: '心拍数', kind: 'vital', value: 118, valueText: '118', at: '2026-11-21T09:10' }),
    ]).find((p) => p.id === 'hr');
    const latest = latestPoint(hr?.points ?? []);
    expect(latest?.text).toBe('128');
    expect(untimedSameDay(hr?.points ?? [], latest)).toBe(true);
    const later = latestPoint([...(hr?.points ?? []), { ...(chartTime('2026-11-22') ?? { t: 0, dateOnly: true }), at: '2026-11-22', value: 100, text: '100' }]);
    expect(later?.text).toBe('100');
    expect(untimedSameDay(hr?.points ?? [], latestPoint([]))).toBe(false);
  });
});

describe('同じ値の二重（CA-049）', () => {
  const o = (id: string, sourceId: string, at: string | null, name: string, value: number | null, valueText = String(value)) => ({ id, sourceId, at, name, nameRaw: name, value, comparator: null, valueText });
  const sheet = (sourceId: string) => sourceId.startsWith('lab');
  test('記載の中で挙げ直した値は、同じ日の検査結果に同じ値があれば、たたむ', () => {
    const list = [
      o('a', 'lab1', '2026-11-17T06:00', 'Cr', 1.48),
      o('b', 'note1', '2026-11-17T09:30', 'Cr', 1.48),
      o('c', 'note1', '2026-11-17T09:30', 'Na', 132),
      o('d', 'note2', '2026-11-18', 'Cr', 1.48),
      o('e', 'note1', '2026-11-17T09:30', 'K', 4.2),
      o('f', 'lab1', '2026-11-17T06:00', 'K', 4.3),
    ];
    // Na は検査結果にない。翌日の Cr は別の日。K は値が違う
    expect([...foldedObservationIds(list, sheet)]).toEqual(['b']);
  });
  test('検査結果どうし・日時のない値は、たたまない', () => {
    const list = [o('a', 'lab1', '2026-11-17T06:00', 'K', 4.0), o('b', 'lab2', '2026-11-17T18:00', 'K', 4.0), o('c', 'note1', null, 'K', 4.0)];
    expect(foldedObservationIds(list, sheet).size).toBe(0);
  });
  test('定性の値は、書かれた字で比べる', () => {
    const list = [o('a', 'lab1', '2026-11-16T14:35', '尿蛋白', null, '(1+)'), o('b', 'note1', '2026-11-16', '尿蛋白', null, '(1+)')];
    expect([...foldedObservationIds(list, sheet)]).toEqual(['b']);
  });
});
