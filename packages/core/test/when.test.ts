import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { isDateTime, parseWhen, type WhenContext } from '../src/index.ts';

const ctx: WhenContext = { refDay: '2026-11-20', encounterStart: '2026-11-18T22:10' };

describe('日時の言い方を、決まった規則で読む', () => {
  test.each([
    ['2026-11-20', '2026-11-20'],
    ['2026/11/19 6:00', '2026-11-19T06:00'],
    ['2026年11月19日 8時30分', '2026-11-19T08:30'],
    ['２０２６／１１／１９　６：００', '2026-11-19T06:00'],
    ['11/19', '2026-11-19'],
    ['11月19日', '2026-11-19'],
    ['11/19 22:10', '2026-11-19T22:10'],
    ['6:00', '2026-11-20T06:00'],
    ['8時', '2026-11-20T08:00'],
    ['本日', '2026-11-20'],
    ['今朝', '2026-11-20'],
    ['昨日', '2026-11-19'],
    ['昨夜 23:00', '2026-11-19T23:00'],
    ['一昨日', '2026-11-18'],
    ['明日', '2026-11-21'],
    ['3日前', '2026-11-17'],
    ['入院3日目', '2026-11-20'],
    ['第1病日', '2026-11-18'],
    ['5病日目', '2026-11-22'],
  ])('%s → %s', (quote, expected) => {
    expect(parseWhen(quote, ctx)).toBe(expected);
  });

  test('年のない月日は、基準の日にいちばん近い年（年をまたぐ）', () => {
    expect(parseWhen('12/30', { refDay: '2027-01-03', encounterStart: null })).toBe('2026-12-30');
    expect(parseWhen('1/2', { refDay: '2026-12-30', encounterStart: null })).toBe('2027-01-02');
  });

  test('読めないものは null（推測で埋めない）', () => {
    for (const quote of ['', '先週', '数日前', '入院後', '2026-02-30', '25:00', '13/40', 'R8.11.20', '午後']) {
      expect(parseWhen(quote, ctx), quote).toBeNull();
    }
  });

  test('基準の日がないとき：年のある日付だけを読む（相対・年のない月日・時刻だけは読まない）', () => {
    const none: WhenContext = { refDay: null, encounterStart: null };
    expect(parseWhen('2026-11-19 6:00', none)).toBe('2026-11-19T06:00');
    for (const quote of ['11/19', '昨日', '6:00', '3日前', '入院3日目']) expect(parseWhen(quote, none), quote).toBeNull();
  });

  test('返すのは、いつも日時の形か null', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('1', '2', '0', '9', '/', ':', '-', '年', '月', '日', '時', '分', '昨', '今', '入院', '第', '病', '目', '前', ' ') }), (s) => {
        const r = parseWhen(s, ctx);
        expect(r === null || isDateTime(r)).toBe(true);
      }),
    );
  });
});
