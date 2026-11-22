// 段K7：前の記載との違い（CA-068）。架空症例（synthetic）だけ。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { type DiffNote, diffKey, noteDiff, previousNote } from '../src/index.ts';

const note = (text: string, labels: [string, string][] = []): DiffNote => ({
  text,
  segments: labels.map(([label, start], i) => {
    const next = labels[i + 1];
    return { label: label as never, start: text.indexOf(start), end: next === undefined ? text.length : text.indexOf(next[1]) };
  }),
});
const SOAP: [string, string][] = [
  ['subjective', 'S)'],
  ['objective', 'O)'],
  ['problem_heading', '#1'],
  ['assessment', 'A)'],
  ['plan', 'P)'],
];

describe('前の記載との違い（noteDiff）', () => {
  test('見出しごとに、変わった行・足した行だけ。同じ見出しは数だけ。前にあってこの記載にない行は別に', () => {
    const prev = note('S) 咳あり\nO) BT 37.8\n#1 市中肺炎\nA) 反応あり\nP) 抗菌薬を継続', SOAP);
    const curr = note('S) 咳あり\nO) BT 36.9\n#1 市中肺炎\nA) 反応あり\nP) 抗菌薬を継続\n内服への切り替えを検討', SOAP);
    const d = noteDiff(prev, curr);
    expect(d.sections.map((x) => [x.name, x.unchanged, x.added])).toEqual([
      ['S', 1, []],
      ['O', 0, ['O) BT 36.9']],
      ['#1 市中肺炎', 3, ['内服への切り替えを検討']],
    ]);
    expect(d.removed).toEqual([{ section: 'O', line: 'O) BT 37.8' }]);
    expect(d.lines).toBe(6);
    expect(d.unchanged).toBe(4);
    expect(d.added).toBe(2);
    expect(d.nearlySame).toBe(false);
  });
  test('比べるときだけ、全角・半角と空白をそろえる（画面には記載の字のまま）', () => {
    const d = noteDiff(note('BT 36.9  SpO2 98%'), note('ＢＴ　３６．９ SpO2 98％'));
    expect(d.added).toBe(0);
    expect(d.removed).toEqual([]);
    expect(diffKey('ＢＴ　３６．９')).toBe('BT 36.9');
  });
  test('区切りが違っても、ほかの見出しにある同じ行は「前と同じ」に数える', () => {
    const prev = note('S) 著変なし\nP) 継続', [['subjective', 'S)'], ['plan', 'P)']]);
    const curr = note('S) 著変なし\nP) 継続', [['subjective', 'S)'], ['assessment_plan', 'P)']]);
    expect(noteDiff(prev, curr).added).toBe(0);
  });
  test('ほぼ前回と同じ：前と同じ行が 8 割を超える', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `行${String(i)}`);
    expect(noteDiff(note(lines.join('\n')), note([...lines.slice(0, 9), '新しい行'].join('\n'))).nearlySame).toBe(true);
    expect(noteDiff(note(lines.join('\n')), note([...lines.slice(0, 8), '新1', '新2'].join('\n'))).nearlySame).toBe(false);
    expect(noteDiff(note(''), note('')).nearlySame).toBe(false);
  });

  const lineArb = fc.array(fc.constantFrom('S) 咳あり', 'O) BT 36.9', 'A) 改善', 'P) 継続', '内服へ', '', '  ', 'ＢＴ　３６．９'), { maxLength: 12 });
  test('性質：同じ文どうしなら、違いはない', () => {
    fc.assert(
      fc.property(lineArb, (lines) => {
        const d = noteDiff(note(lines.join('\n')), note(lines.join('\n')));
        expect(d.added).toBe(0);
        expect(d.removed).toEqual([]);
        expect(d.sections.every((x) => x.added.length === 0)).toBe(true);
      }),
    );
  });
  test('性質：この記載の行は、どれも「前と同じ」か「足した」のどちらか。前の記載の行は、どれも「同じ」に使われたか「ない行」', () => {
    fc.assert(
      fc.property(lineArb, lineArb, (a, b) => {
        const d = noteDiff(note(a.join('\n')), note(b.join('\n')));
        const nonEmpty = (l: readonly string[]) => l.filter((x) => diffKey(x) !== '').length;
        expect(d.lines).toBe(nonEmpty(b));
        expect(d.unchanged + d.added).toBe(d.lines);
        expect(d.sections.reduce((n, x) => n + x.unchanged + x.added.length, 0)).toBe(d.lines);
        expect(d.previousLines).toBe(nonEmpty(a));
        expect(d.unchanged + d.removed.length).toBe(d.previousLines);
      }),
    );
  });
});

describe('前の記載（previousNote）', () => {
  const row = (id: string, at: string | null, over: Partial<{ kind: 'progress_note' | 'nursing' | 'lab'; authorRole: 'self' | 'senior'; encounterId: string; enteredAt: string }> = {}) => ({
    id,
    at,
    kind: over.kind ?? 'progress_note',
    authorRole: over.authorRole ?? 'self',
    encounterId: over.encounterId ?? 'e1',
    enteredAt: over.enteredAt ?? at ?? '2026-11-20T00:00',
  });
  test('同じ受診・同じ種類・日時が前のうち、いちばん新しいもの。書いた人が同じものを先に', () => {
    const list = [row('a', '2026-11-17T09:00'), row('b', '2026-11-18T09:00', { authorRole: 'senior' }), row('c', '2026-11-18T08:00'), row('d', '2026-11-19T09:00'), row('n', '2026-11-18T10:00', { kind: 'nursing' }), row('x', '2026-11-18T11:00', { encounterId: 'e0' })];
    const cur = list[3];
    if (cur === undefined) throw new Error('fixture');
    expect(previousNote(list, cur)).toEqual({ source: list[2], sameRole: true });
    const senior = row('s', '2026-11-19T10:00', { authorRole: 'senior' });
    expect(previousNote([...list, senior], senior)?.source.id).toBe('b');
    const first = list[0];
    if (first === undefined) throw new Error('fixture');
    expect(previousNote(list, first)).toBeNull();
  });
  test('書いた人が同じものがなければ、ほかの人の記載（sameRole: false）。日時のない記載・検査結果は比べない', () => {
    const list = [row('a', '2026-11-17T09:00', { authorRole: 'senior' }), row('b', '2026-11-18T09:00')];
    expect(previousNote(list, list[1] ?? row('z', null))).toEqual({ source: list[0], sameRole: false });
    expect(previousNote(list, row('z', null))).toBeNull();
    expect(previousNote([row('l1', '2026-11-17T09:00', { kind: 'lab' })], row('l2', '2026-11-18T09:00', { kind: 'lab' }))).toBeNull();
  });
});
