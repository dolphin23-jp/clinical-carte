// 段K1（CA-058）：振り分けられなかった字・薬とデバイスの日数。文は架空（synthetic）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { dayNumber, deviceDays, deviceName, leftovers, medicationDays } from '../src/index.ts';

describe('振り分けられなかった字（A1）', () => {
  const text = ['【現病歴】', '3日前から発熱。', '家人によると食事量が半分程度。', 'S)', '#1 肺炎', 'O) BT 38.2'].join('\n');
  const at = (s: string): { start: number; end: number } => ({ start: text.indexOf(s), end: text.indexOf(s) + s.length });
  test('事実の場所に入らない字を、行ごとに返す。見出し・記号だけの行は返さない', () => {
    const r = leftovers(text, [at('3日前から発熱'), at('#1 肺炎'), at('BT 38.2')]);
    expect(r.map((x) => text.slice(x.start, x.end))).toEqual(['家人によると食事量が半分程度']);
  });
  test('日時だけの字（値の日時として読まれた「昨日」など）は返さない', () => {
    const t = 'O) BT 37.2。昨日 BT 38.4。';
    expect(leftovers(t, [{ start: 3, end: 10 }, { start: 14, end: 21 }])).toEqual([]);
    // 行頭の見出しは、字に数えない
    const u = 'S) 咳嗽は軽減。';
    expect(leftovers(u, []).map((x) => u.slice(x.start, x.end))).toEqual(['咳嗽は軽減']);
  });
  test('すべて覆われていれば空。覆いが文の外にはみ出しても壊れない', () => {
    expect(leftovers(text, [{ start: -5, end: text.length + 10 }])).toEqual([]);
    expect(leftovers('', [])).toEqual([]);
  });
  test('性質：返す場所は、どの覆いとも重ならず、文の中にある', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.array(fc.tuple(fc.nat(90), fc.nat(30)), { maxLength: 6 }), (t, spans) => {
        const covered = spans.map(([s, len]) => ({ start: s, end: s + len }));
        for (const r of leftovers(t, covered)) {
          expect(r.start).toBeGreaterThanOrEqual(0);
          expect(r.end).toBeLessThanOrEqual(t.length);
          expect(r.end).toBeGreaterThan(r.start);
          for (const c of covered.filter((x) => x.end > x.start)) expect(r.end <= c.start || r.start >= c.end).toBe(true);
        }
      }),
    );
  });
});

describe('薬の、開始から何日目（A2）', () => {
  const m = (id: string, action: 'start' | 'stop' | 'continue' | null, at: string | null) => ({ id, sourceId: 's', action, at });
  test('開始の日を1日目に、記録の上で最後の日まで。中止なら中止の日まで', () => {
    expect(medicationDays([m('a', 'start', '2026-11-17T23:00'), m('b', 'continue', '2026-11-19')], '2026-11-21T09:00')).toEqual({ startedAt: '2026-11-17T23:00', stoppedAt: null, day: 5 });
    expect(medicationDays([m('a', 'start', '2026-11-17'), m('b', 'stop', '2026-11-20')], '2026-11-21')).toEqual({ startedAt: '2026-11-17', stoppedAt: '2026-11-20', day: 4 });
  });
  test('開始の記載がなければ数えない。中止のあとの開始は始め直し', () => {
    expect(medicationDays([m('a', 'continue', '2026-11-17')], '2026-11-21').day).toBeNull();
    expect(medicationDays([m('a', 'start', '2026-11-10'), m('b', 'stop', '2026-11-12'), m('c', 'start', '2026-11-20')], '2026-11-21')).toEqual({ startedAt: '2026-11-20', stoppedAt: null, day: 2 });
  });
  test('dayNumber：同じ日は1日目、前の日は null', () => {
    expect(dayNumber('2026-11-21T23:59', '2026-11-21T00:01')).toBe(1);
    expect(dayNumber('2026-11-21', '2026-11-20')).toBeNull();
  });
});

describe('デバイスの、入れてから何日目（A2）', () => {
  const e = (id: string, title: string, at: string, kind: 'procedure' | 'test' = 'procedure') => ({ id, kind, title, at });
  test('挿入・留置から数え、抜去の日まで。入れ替えは、その日から数え直す。同じ日の同じ字は1回', () => {
    const lines = deviceDays(
      [
        e('1', 'CV 挿入', '2026-11-17T23:30'),
        e('2', 'CV挿入', '2026-11-17T23:40'),
        e('3', '尿道カテーテル留置', '2026-11-18T01:00'),
        e('4', '尿道カテーテル抜去', '2026-11-20T10:00'),
        e('5', '気管挿管', '2026-11-18T02:00'),
        e('6', '抜管', '2026-11-19T09:00'),
        e('7', 'CV 入れ替え', '2026-11-20T15:00'),
        e('8', '胸部CT', '2026-11-18T03:00', 'test'),
      ],
      '2026-11-21T08:00',
    );
    expect(lines.map((l) => [l.name, l.placedAt.slice(0, 10), l.removedAt?.slice(0, 10) ?? null, l.day, l.replaced])).toEqual([
      ['CV', '2026-11-20', null, 2, true],
      ['CV', '2026-11-17', '2026-11-20', 4, false],
      ['尿道カテーテル', '2026-11-18', '2026-11-20', 3, false],
      ['気管挿管', '2026-11-18', '2026-11-19', 2, false],
    ]);
  });
  test('名前：入れる・抜く の字を除く。字が残らなければ数えない', () => {
    expect(deviceName('右内頸静脈 CV 挿入')).toBe('右内頸静脈 CV');
    expect(deviceName('挿入')).toBeNull();
    expect(deviceDays([e('1', '抜去', '2026-11-20')], '2026-11-21')).toEqual([]);
  });
});
