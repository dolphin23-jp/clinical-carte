import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { isDateTime, parseWhen, type WhenContext, whenCandidates } from '../src/index.ts';

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
    ['翌日11:00', '2026-11-21T11:00'],
    ['翌朝', '2026-11-21'],
    ['前日 22:00', '2026-11-19T22:00'],
    // 「6時間後」の「6時」は時刻ではない。後ろに書かれた時刻を読む
    ['6時間後（17:00ごろ）', '2026-11-20T17:00'],
  ])('%s → %s', (quote, expected) => {
    expect(parseWhen(quote, ctx)).toBe(expected);
  });

  test('年のない月日は、基準の日にいちばん近い年（年をまたぐ）', () => {
    expect(parseWhen('12/30', { refDay: '2027-01-03', encounterStart: null })).toBe('2026-12-30');
    expect(parseWhen('1/2', { refDay: '2026-12-30', encounterStart: null })).toBe('2027-01-02');
  });

  test('読めないものは null（推測で埋めない）', () => {
    for (const quote of ['', '先週', '数日前', '入院後', '2026-02-30', '25:00', '13/40', 'R8.11.20', '午後', '6時間後', '2026年6月']) {
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

describe('文の中の日時の候補（入れる欄で選ぶ手がかり）', () => {
  test('書かれた順に、重なりなく、3つまで', () => {
    const text = ['2026-11-21 10:50 救急', '来院 2026-11-21 10:35', '11/18 から発熱。', '【初期評価 10:38】', '10:50 再掲'].join('\n');
    expect(whenCandidates(text, ctx)).toEqual(['2026-11-21T10:50', '2026-11-21T10:35', '2026-11-18']);
    expect(whenCandidates('10:55 導尿。11:00 輸液。', ctx, 5)).toEqual(['2026-11-20T10:55', '2026-11-20T11:00']);
  });

  test('日時でない「数/数」「数:数」を候補にしない（血圧・瞳孔径・比・範囲）', () => {
    expect(whenCandidates('BP 84/40 瞳孔3/3 mm 比 1:2 RBC 10/HPF', ctx)).toEqual([]);
  });

  test('書かれていなければ、空（推測で作らない）', () => {
    expect(whenCandidates('解熱。食事摂取良好。', ctx)).toEqual([]);
    expect(whenCandidates('11/19 解熱', { refDay: null, encounterStart: null })).toEqual([]);
  });
});
