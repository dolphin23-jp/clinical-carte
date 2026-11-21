// 経過の見方の表示の窓と日の帯（段H）。架空の日時だけ。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { axisTicks, chartTime, clampWindow, dayStrip, dayWindow, panWindow, presetWindow, WINDOW_MIN_MS, zoomWindow } from '../src/index.ts';

const D = 86_400_000;
const t = (at: string): number => chartTime(at)?.t ?? Number.NaN;
const full: [number, number] = [t('2026-10-20T00:00'), t('2026-11-21T12:00')];

describe('表示の窓', () => {
  test('既定の範囲（3日）は、最後の記録が右端の近く。全期間は全体。全体より広い範囲は全体', () => {
    const w = presetWindow('3d', full, t('2026-11-21T06:00'));
    expect(w[1] - w[0]).toBe(3 * D);
    expect(w[1]).toBeGreaterThan(t('2026-11-21T06:00'));
    expect(w[1]).toBeLessThanOrEqual(full[1]);
    expect(presetWindow('all', full, 0)).toEqual(full);
    const short: [number, number] = [t('2026-11-20T00:00'), t('2026-11-21T12:00')];
    expect(presetWindow('7d', short, t('2026-11-21T06:00'))).toEqual(short);
  });

  test('動かす・拡大縮小しても、全体の中に収まり、幅は2時間以上', () => {
    fc.assert(
      fc.property(fc.double({ min: -60 * D, max: 60 * D, noNaN: true }), fc.double({ min: 0.01, max: 50, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (delta, factor, at) => {
        const start = presetWindow('3d', full, full[1]);
        for (const w of [panWindow(start, full, delta), zoomWindow(start, full, factor, start[0] + (start[1] - start[0]) * at)]) {
          expect(w[0]).toBeGreaterThanOrEqual(full[0]);
          expect(w[1]).toBeLessThanOrEqual(full[1]);
          expect(w[1] - w[0]).toBeGreaterThanOrEqual(Math.min(WINDOW_MIN_MS, full[1] - full[0]) - 1e-6);
        }
      }),
    );
  });

  test('拡大は、指した時刻の場所を動かさない', () => {
    const w = clampWindow([t('2026-11-18T00:00'), t('2026-11-21T00:00')], full);
    const center = t('2026-11-20T00:00');
    const z = zoomWindow(w, full, 0.5, center);
    expect((center - z[0]) / (z[1] - z[0])).toBeCloseTo((center - w[0]) / (w[1] - w[0]));
  });

  test('1日の窓は、その日の0時から24時', () => {
    expect(dayWindow('2026-11-19')).toEqual([t('2026-11-19T00:00'), t('2026-11-20T00:00')]);
  });
});

describe('時間の目盛り', () => {
  test('2日以内は時刻の目盛り。0時の目盛りは日付と病日', () => {
    const ticks = axisTicks([t('2026-11-19T00:00'), t('2026-11-20T00:00')], 6, '2026-11-16');
    expect(ticks.map((x) => x.label)).toEqual(['11/19', '6時', '12時', '18時', '11/20']);
    expect(ticks[0]).toMatchObject({ kind: 'day', hospitalDay: 4 });
    expect(ticks[1]).toMatchObject({ kind: 'hour', hospitalDay: null });
  });
  test('それより広ければ日の目盛り', () => {
    expect(axisTicks([t('2026-11-16T00:00'), t('2026-11-21T00:00')], 10, null).every((x) => x.kind === 'day')).toBe(true);
  });
});

describe('日の帯', () => {
  test('受診の始まりの日から最後の記録の日まで。各日は「あるか」の数だけ（値は見ない）', () => {
    const days = dayStrip({
      encounter: { kind: 'inpatient', start: '2026-11-16T14:20', end: null },
      sources: [{ at: '2026-11-16T17:30' }, { at: '2026-11-18' }],
      observations: [
        { at: '2026-11-16T16:00', kind: 'vital' },
        { at: '2026-11-18T06:00', kind: 'lab' },
        { at: null, kind: 'lab' },
      ],
      medications: [{ at: '2026-11-19T10:00' }],
      events: [],
    });
    expect(days.map((d) => [d.label, d.hospitalDay, d.sources, d.vitals, d.labs, d.medications])).toEqual([
      ['11/16', 1, 1, 1, 0, 0],
      ['11/17', 2, 0, 0, 0, 0],
      ['11/18', 3, 1, 0, 1, 0],
      ['11/19', 4, 0, 0, 0, 1],
    ]);
    expect(days[0]?.weekday).toBe('月');
  });
  test('外来・救急は病日を持たない。終わりの日が後なら、そこまで', () => {
    const days = dayStrip({ encounter: { kind: 'outpatient', start: '2026-11-16', end: '2026-11-18' }, sources: [], observations: [], medications: [], events: [] });
    expect(days.map((d) => [d.day, d.hospitalDay])).toEqual([
      ['2026-11-16', null],
      ['2026-11-17', null],
      ['2026-11-18', null],
    ]);
  });
});
