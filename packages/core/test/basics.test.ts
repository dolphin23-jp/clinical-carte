import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { BANNER, BANNER_LINES, isDay, isUlid, japanDay, ulid, ULID_RANDOM_BYTES } from '../src/index.ts';

describe('常時表示の帯', () => {
  test('文は2つ：写しであること、識別情報を入れないこと', () => {
    expect(BANNER_LINES).toEqual([BANNER.copy, BANNER.noIdentifiers]);
    expect(BANNER.copy).toContain('写し');
    expect(BANNER.copy).toContain('最新とは限りません');
    expect(BANNER.copy).toContain('正本は病院のカルテ');
    expect(BANNER.noIdentifiers).toContain('氏名');
    expect(BANNER.noIdentifiers).toContain('ID');
  });
});

describe('ULID', () => {
  test('同じ時刻と乱数から、同じ id。26文字で、形が合う', () => {
    const r = new Uint8Array(ULID_RANDOM_BYTES).fill(3);
    expect(ulid(1_800_000_000_000, r)).toBe(ulid(1_800_000_000_000, r));
    expect(isUlid(ulid(1_800_000_000_000, r))).toBe(true);
  });
  test('時刻の順に並ぶ', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 47 }), fc.integer({ min: 1, max: 1_000_000 }), fc.uint8Array({ minLength: 10, maxLength: 10 }), (t, d, r) => {
        expect(ulid(t, r) < ulid(t + d, r)).toBe(true);
      }),
    );
  });
  test('時刻・乱数の形が違えば、作らない', () => {
    expect(() => ulid(-1, new Uint8Array(10))).toThrow(RangeError);
    expect(() => ulid(0, new Uint8Array(9))).toThrow(RangeError);
  });
});

describe('日', () => {
  test('日本の日：UTC の 15 時が、日の変わり目', () => {
    expect(japanDay(Date.UTC(2026, 10, 20, 14, 59))).toBe('2026-11-20');
    expect(japanDay(Date.UTC(2026, 10, 20, 15, 0))).toBe('2026-11-21');
  });
  test('実在する日だけを、日とみなす', () => {
    expect(isDay('2026-11-20')).toBe(true);
    expect(isDay('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '2026/11/20', '', 2026, '1899-12-31']) {
      expect(isDay(bad)).toBe(false);
    }
  });
  test('japanDay が返すものは、日の形', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: Date.UTC(2190, 0, 1) }), (t) => isDay(japanDay(t))));
  });
});
