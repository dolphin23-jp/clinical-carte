// 問題の帯（段K。CA-058）。架空の名前と日時だけ。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { chartTime, laneDomain, problemLanes, type LaneInput } from '../src/index.ts';

const t = (at: string): number => chartTime(at)?.t ?? Number.NaN;
const mention = (at: string | null) => ({ id: 'm', sourceId: 's', threadId: 't', name: 'n', status: 'problem' as const, activity: null, at, start: 0, end: 1 });

const threads: LaneInput['threads'] = [
  { id: 'T1', name: '#1 発熱', group: 'current', mentions: [mention('2026-11-17T10:00'), mention('2026-11-18'), mention('2026-11-19T09:00'), mention('2026-11-19T09:00')] },
  { id: 'T2', name: '#2 低K血症', group: 'closed', mentions: [mention('2026-11-17T10:00'), mention(null)] },
  { id: 'T3', name: '肺塞栓', group: 'ruled_out', mentions: [mention('2026-11-18T09:00')] },
];

describe('問題の帯', () => {
  test('リストがなければ、記録に書かれた問題の筋の並びで。同じ日時は1つ、日時のない記載は数だけ', () => {
    const lanes = problemLanes({ threads, list: [], course: [] });
    expect(lanes.map((l) => [l.name, l.no, l.active, l.stateName, l.listed])).toEqual([
      ['#1 発熱', null, true, '', false],
      ['#2 低K血症', null, false, '解決・非活動', false],
      ['肺塞栓', null, false, '否定的', false],
    ]);
    expect(lanes[0]?.marks.map((m) => m.t)).toEqual([t('2026-11-17T10:00'), t('2026-11-18'), t('2026-11-19T09:00')]);
    expect(lanes[0]?.marks[1]?.dateOnly).toBe(true);
    expect(lanes[1]?.undated).toBe(1);
  });

  test('リストがあれば、その番号と並びで（外した項目は出さず、番号は問題のタブと同じ）。結びつけた筋と経過の出来事の日時を合わせる', () => {
    const lanes = problemLanes({
      threads,
      list: [
        { key: 'a', name: '市中肺炎', activity: 'active', threadIds: ['T1'], course: [{ sourceId: 's1', start: 4 }], hidden: false },
        { key: 'b', name: '外した項目', activity: 'active', threadIds: ['T3'], course: [], hidden: true },
        { key: 'c', name: '低K血症', activity: 'resolved', threadIds: ['T2', 'T9'], course: [], hidden: false },
      ],
      course: [
        { sourceId: 's1', start: 4, at: '2026-11-15T17:00' },
        { sourceId: 's1', start: 40, at: '2026-11-16T08:00' },
      ],
    });
    expect(lanes.map((l) => [l.no, l.name, l.active, l.stateName, l.listed])).toEqual([
      [1, '市中肺炎', true, '', true],
      [2, '低K血症', false, '解決', true],
    ]);
    // 来院前の出来事（結びつけたものだけ）が、帯のはじめになる
    expect(lanes[0]?.marks[0]?.t).toBe(t('2026-11-15T17:00'));
    expect(lanes[0]?.marks).toHaveLength(4);
  });

  test('帯は、書かれた日時の外へ伸びない（最後に書かれた日時より先を作らない）', () => {
    const at = fc.tuple(fc.integer({ min: 1, max: 28 }), fc.integer({ min: 0, max: 23 }), fc.boolean()).map(([d, h, dayOnly]) => {
      const day = `2026-11-${String(d).padStart(2, '0')}`;
      return dayOnly ? day : `${day}T${String(h).padStart(2, '0')}:00`;
    });
    fc.assert(
      fc.property(fc.array(fc.array(fc.option(at, { nil: null }), { maxLength: 6 }), { minLength: 1, maxLength: 5 }), (perThread) => {
        const input = perThread.map((ats, i) => ({ id: `T${String(i)}`, name: `問題${String(i)}`, group: 'current' as const, mentions: ats.map(mention) }));
        const lanes = problemLanes({ threads: input, list: [], course: [] });
        for (const [i, lane] of lanes.entries()) {
          const written = (perThread[i] ?? []).filter((x): x is string => x !== null).map(t);
          expect(lane.undated).toBe((perThread[i] ?? []).filter((x) => x === null).length);
          expect(new Set(lane.marks.map((m) => m.t))).toEqual(new Set(written));
          expect([...lane.marks.map((m) => m.t)]).toEqual([...lane.marks.map((m) => m.t)].sort((a, b) => a - b));
        }
        const domain = laneDomain(lanes);
        const all = lanes.flatMap((l) => l.marks.map((m) => m.t));
        if (all.length === 0) expect(domain).toBeNull();
        else {
          expect(domain?.[0]).toBeLessThanOrEqual(Math.min(...all));
          expect(domain?.[1]).toBeGreaterThan(Math.max(...all));
          // 日の境まで（1日より多くは広げない）
          expect((domain?.[1] ?? 0) - Math.max(...all)).toBeLessThanOrEqual(86_400_000);
        }
      }),
    );
  });
});
