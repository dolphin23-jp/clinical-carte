// 結果待ちを追う（段K6。CA-065）：範囲・資料の記号・確かめ（記号・候補・提出より前の結果・自分自身・重なり）・先生の印の引き継ぎ。
// AI の答えは試験の代役。文はすべて架空（synthetic）。
import { describe, expect, test } from 'vitest';

import {
  applyPendingMark,
  carryPendingMarks,
  checkPending,
  hasPendingCandidates,
  notBefore,
  type PendingAnswer,
  type PendingInput,
  pendingKey,
  pendingMaterial,
  PendingPatch,
  recentEncounters,
} from '../src/index.ts';

const ER = 'enc-er';
const IN = 'enc-in';
const OLD = 'enc-old';
const T1 = '【救急】血液培養2セット提出。尿定性で亜硝酸陽性。';
const T2 = '【入院1日目】胸部CT 撮影、読影待ち。尿培養を提出。';
const T3 = '【入院3日目】血液培養2セットから大腸菌を検出。CRP 8.1。';

const INPUT: PendingInput = {
  encounters: [
    { id: OLD, kind: 'outpatient', start: '2026-10-01T09:00', end: null },
    { id: ER, kind: 'er', start: '2026-11-19T22:00', end: '2026-11-20T08:00' },
    { id: IN, kind: 'inpatient', start: '2026-11-20T08:00', end: null },
  ],
  sources: [
    { id: 's1', encounterId: ER, kind: 'er_note', at: '2026-11-19T22:30', text: T1 },
    { id: 's2', encounterId: IN, kind: 'progress_note', at: '2026-11-20T10:00', text: T2 },
    { id: 's3', encounterId: IN, kind: 'progress_note', at: '2026-11-22T10:00', text: T3 },
    { id: 's0', encounterId: OLD, kind: 'outpatient_first', at: '2026-10-01T09:30', text: '甲状腺機能を外注で提出。' },
  ],
  events: [
    { sourceId: 's1', encounterId: ER, kind: 'test', title: '血液培養2セット提出', at: '2026-11-19T22:30', start: 4, end: 14 },
    { sourceId: 's2', encounterId: IN, kind: 'test', title: '胸部CT 撮影', at: '2026-11-20T10:00', start: 8, end: 16 },
    { sourceId: 's0', encounterId: OLD, kind: 'test', title: '甲状腺機能を外注で提出', at: '2026-10-01T09:30', start: 0, end: 11 },
  ],
  course: [
    { sourceId: 's2', encounterId: IN, category: 'test', summary: '尿培養を提出', at: '2026-11-20T10:00', atApprox: null, start: 23, end: 29 },
    { sourceId: 's3', encounterId: IN, category: 'test', summary: '血液培養から大腸菌を検出', at: '2026-11-22T10:00', atApprox: null, start: 7, end: 23 },
    { sourceId: 's1', encounterId: ER, category: 'finding', summary: '尿定性で亜硝酸陽性', at: '2026-11-19T22:30', atApprox: null, start: 15, end: 23 },
  ],
  observations: [{ sourceId: 's3', encounterId: IN, name: 'CRP', nameRaw: 'CRP', kind: 'lab', comparator: null, valueText: '8.1', unit: 'mg/dL', at: '2026-11-22T10:00', start: 25, end: 32 }],
};

const material = pendingMaterial(INPUT);
const ref = (title: string): string => {
  for (const [r, c] of material.candidates) if (c.name === title) return r;
  throw new Error(title);
};

describe('範囲と資料（pendingMaterial）', () => {
  test('範囲は、いまの受診と直前の救急の受診だけ（前の外来は入れない）', () => {
    expect(recentEncounters(INPUT.encounters).map((e) => e.id)).toEqual([ER, IN]);
    const text = JSON.stringify(material.payload);
    expect(text).not.toContain('甲状腺');
  });

  test('提出の候補は、できごとの「検査の実施」と経過の出来事の「検査」。記号は E・C・V。引用は保存した文の字', () => {
    expect([...material.candidates.values()].map((c) => c.name)).toEqual(['血液培養2セット提出', '胸部CT 撮影', '尿培養を提出', '血液培養から大腸菌を検出']);
    expect([...material.candidates.keys()].every((k) => /^[EC]\d+$/u.test(k))).toBe(true);
    expect([...material.items.keys()].sort()).toEqual(['C1', 'C2', 'C3', 'E1', 'E2', 'V1']);
    const payload = material.payload as { submitted: string[]; events: { quote: string }[]; values: { name: string; values: string }[] };
    expect(payload.submitted).toHaveLength(4);
    expect(payload.events[0]?.quote).toBe(T1.slice(4, 14));
    expect(payload.values[0]).toMatchObject({ name: 'CRP', values: '10:00 8.1 mg/dL' });
    expect(material.dropped).toEqual({ candidates: 0, results: 0 });
  });

  test('候補がなければ、AI を呼ばない（hasPendingCandidates）', () => {
    expect(hasPendingCandidates(INPUT)).toBe(true);
    expect(hasPendingCandidates({ ...INPUT, events: INPUT.events.filter((e) => e.encounterId === OLD), course: [] })).toBe(false);
  });

  test('長いときは、候補でない古いものから落とし、数を返す（候補は残す）', () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ sourceId: 's3', encounterId: IN, name: `項目${String(i)}`, nameRaw: `項目${String(i)}`, kind: 'lab' as const, valueText: String(i), unit: 'mg/dL', at: `2026-11-2${String(i % 3)}T10:00`, start: 0, end: 1 }));
    const big = pendingMaterial({ ...INPUT, observations: many });
    expect(JSON.stringify(big.payload).length).toBeLessThanOrEqual(60_000);
    expect(big.dropped.results).toBeGreaterThan(0);
    expect(big.candidates.size).toBe(4);
  });
});

describe('確かめ（checkPending）', () => {
  const blood = ref('血液培養2セット提出');
  const ct = ref('胸部CT 撮影');
  const urine = ref('尿培養を提出');
  const found = ref('血液培養から大腸菌を検出');

  test('結果の記載・結果待ち・提出ではない。名前と場所は記録のもの。「提出ではない」は一覧に出さず数だけ', () => {
    const answer: PendingAnswer = {
      items: [
        { id: blood, status: 'resulted', results: [found, 'V1'] },
        { id: ct, status: 'pending', results: [] },
        { id: urine, status: 'pending', results: [] },
        { id: found, status: 'not_a_submission', results: [] },
      ],
    };
    const checked = checkPending(answer, material);
    // 同じ日時は、書かれた順（同じ記載なら前の字から）
    expect(checked.items.map((i) => [i.name, i.state])).toEqual([
      ['血液培養2セット提出', 'resulted'],
      ['胸部CT 撮影', 'pending'],
      ['尿培養を提出', 'pending'],
    ]);
    expect(checked.notSubmission).toBe(1);
    const first = checked.items[0];
    expect(first?.key).toBe(pendingKey('event', { sourceId: 's1', start: 4, end: 14 }));
    expect(first?.results.map((r) => r.kind)).toEqual(['course', 'value']);
    expect(T3.slice(first?.results[0]?.start, first?.results[0]?.end)).toBe('血液培養2セットから大腸菌を検出');
    expect(checked.rejected).toEqual({});
    expect(checked.items.every((i) => i.mark === 'none')).toBe(true);
  });

  test('資料にない記号・候補でない記号・重なり・提出より前の結果・自分自身は通さず、理由ごとに数える。結果が残らなければ「振り分けられなかった」', () => {
    const answer: PendingAnswer = {
      items: [
        { id: 'E99', status: 'pending', results: [] },
        { id: 'V1', status: 'pending', results: [] },
        { id: blood, status: 'resulted', results: [blood, 'Z9'] },
        { id: blood, status: 'pending', results: [] },
        { id: ct, status: 'resulted', results: ['C1', found] },
      ],
    };
    const checked = checkPending(answer, material);
    expect(checked.rejected).toEqual({ unknown_ref: 1, not_candidate: 1, duplicate: 1, earlier_result: 1, self_result: 1, unknown_result: 1, no_result: 1 });
    expect(checked.items.map((i) => [i.name, i.state])).toEqual([
      ['血液培養2セット提出', 'unsorted'],
      ['胸部CT 撮影', 'resulted'],
      ['尿培養を提出', 'unsorted'],
      ['血液培養から大腸菌を検出', 'unsorted'],
    ]);
    expect(checked.items[1]?.results.map((r) => r.label)).toEqual(['経過「血液培養から大腸菌を検出」']);
  });

  test('結果の順の決まり：時刻があれば時刻、なければ日。日時のないものは比べない', () => {
    expect(notBefore('2026-11-20T09:00', '2026-11-20T10:00')).toBe(false);
    expect(notBefore('2026-11-20T10:00', '2026-11-20T10:00')).toBe(true);
    expect(notBefore('2026-11-20', '2026-11-20T10:00')).toBe(true);
    expect(notBefore('2026-11-19', '2026-11-20T10:00')).toBe(false);
    expect(notBefore(null, '2026-11-20T10:00')).toBe(true);
  });

  test('先生の印は、組み直しても同じ鍵の項目へ引き継ぐ。印はボタンの値だけ', () => {
    const checked = checkPending({ items: [{ id: ct, status: 'pending', results: [] }] }, material);
    const key = checked.items.find((i) => i.name === '胸部CT 撮影')?.key ?? '';
    const marked = applyPendingMark(checked.items, { key, mark: 'checked' });
    expect(marked?.find((i) => i.key === key)?.mark).toBe('checked');
    expect(applyPendingMark(checked.items, { key: 'nope', mark: 'hidden' })).toBeNull();
    const again = carryPendingMarks(checkPending({ items: [] }, material).items, marked ?? []);
    expect(again.find((i) => i.name === '胸部CT 撮影')?.mark).toBe('checked');
    expect(again.find((i) => i.name === '尿培養を提出')?.mark).toBe('none');
    expect(PendingPatch.safeParse({ key: 'k', mark: 'checked', note: '打った字' }).success).toBe(false);
  });
});
