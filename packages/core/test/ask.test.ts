// 記録への質問（段K6。CA-066）：資料の記号・確かめ（根拠の記号・引用・根拠のない文・識別情報の形・※の印）。AI の答えは試験の代役。架空（synthetic）。
import { describe, expect, test } from 'vitest';

import { type AskAnswer, type AskInput, askMaterial, askMessage, AskRequest, checkAnswer } from '../src/index.ts';

const IN = 'enc-in';
const T1 = '【入院1日目】K 3.0 と低値。KCl 20mEq を点滴で補正開始。家族に病状を説明した。';
const T2 = '【入院2日目】K 3.6。補正を継続。';
const at = (text: string, part: string): { start: number; end: number } => ({ start: text.indexOf(part), end: text.indexOf(part) + part.length });
const INPUT: AskInput = {
  patient: { age: 81, ageOn: '2026-11-20', sex: 'female' },
  today: '2026-11-22',
  encounters: [{ id: IN, kind: 'inpatient', start: '2026-11-20T09:00', end: null }],
  sources: [
    { id: 's1', encounterId: IN, kind: 'progress_note', authorRole: 'self', at: '2026-11-20T10:00', text: T1 },
    { id: 's2', encounterId: IN, kind: 'progress_note', authorRole: 'self', at: '2026-11-21T10:00', text: T2 },
  ],
  segments: [],
  medications: [{ sourceId: 's1', encounterId: IN, name: 'KCl', doseText: '20mEq', action: 'start', at: '2026-11-20T10:00', ...at(T1, 'KCl 20mEq') }],
  events: [{ sourceId: 's1', encounterId: IN, kind: 'explanation', title: '家族に病状を説明', at: '2026-11-20T10:00', ...at(T1, '家族に病状を説明') }],
  observations: [
    { sourceId: 's1', encounterId: IN, name: 'K', nameRaw: 'K', valueText: '3.0', unit: null, at: '2026-11-20T10:00', ...at(T1, 'K 3.0') },
    { sourceId: 's2', encounterId: IN, name: 'K', nameRaw: 'K', valueText: '3.6', unit: null, at: '2026-11-21T10:00', ...at(T2, 'K 3.6') },
  ],
  course: [],
};
const material = askMaterial(INPUT);

describe('資料（askMaterial）', () => {
  test('記号は R（記載の全文）・M・E・V・C。問いは最後に足すだけ', () => {
    expect([...material.refs.keys()]).toEqual(['R1', 'R2', 'M1', 'E1', 'V1', 'V2']);
    expect(material.refs.get('R1')).toMatchObject({ kind: 'record', sourceId: 's1', start: 0, end: T1.length });
    expect(material.refs.get('M1')?.label).toContain('KCl');
    const message = JSON.parse(askMessage(material, 'K をいつ補正した？')) as { question: string; records: { text: string; day: string }[] };
    expect(message.question).toBe('K をいつ補正した？');
    expect(message.records[0]).toMatchObject({ text: T1, day: '1病日' });
    expect(material.dropped).toEqual({ records: 0, shortened: 0, values: 0, course: 0 });
  });

  test('問いの形：空・長すぎ・ほかの欄は受けない', () => {
    expect(AskRequest.safeParse({ question: '  ' }).success).toBe(false);
    expect(AskRequest.safeParse({ question: 'あ'.repeat(501) }).success).toBe(false);
    expect(AskRequest.safeParse({ question: '補正は？', save: true }).success).toBe(false);
    expect(AskRequest.safeParse({ question: '補正は？' }).success).toBe(true);
  });

  test('長いときは、古い値 → 古い記載の順に落とし、数を返す（いちばん新しい記載は残す）', () => {
    const big = askMaterial({ ...INPUT, sources: [...INPUT.sources.slice(0, 1), { ...INPUT.sources[0], id: 'big', at: '2026-11-19T10:00', text: 'あ'.repeat(85_000) } as AskInput['sources'][number], ...INPUT.sources.slice(1)] });
    expect(big.dropped.values).toBe(2);
    expect(big.dropped.shortened + big.dropped.records).toBeGreaterThan(0);
    expect([...big.refs.values()].some((r) => r.sourceId === 's2')).toBe(true);
  });
});

describe('確かめ（checkAnswer）', () => {
  test('根拠の記号と引用：引用は記録の字の場所に絞る。引用がなければ記載の全体・事実の場所', () => {
    const answer: AskAnswer = {
      answer: [
        { text: '入院1日目に KCl 20mEq の点滴で補正を始めた。', refs: [{ id: 'R1', quote: 'KCl 20mEq を点滴で補正開始' }, { id: 'M1', quote: '' }] },
        { text: '入院2日目の K は 3.6 で、補正を継続した。', refs: [{ id: 'R2', quote: '補正を継続' }] },
      ],
      notFound: '',
    };
    const reply = checkAnswer(answer, material);
    expect(reply.answer).toHaveLength(2);
    const [r1, m1] = reply.answer[0]?.refs ?? [];
    expect(T1.slice(r1?.start, r1?.end)).toBe('KCl 20mEq を点滴で補正開始');
    expect(r1?.quoted).toBe(true);
    expect(T1.slice(m1?.start, m1?.end)).toBe('KCl 20mEq');
    expect(m1?.quoted).toBe(false);
    expect(reply.answer.every((s) => s.marks.length === 0)).toBe(true);
    expect(reply.rejected).toEqual({});
  });

  test('資料にない記号・字にない引用の根拠は通さず、根拠の残らない文は出さない（理由ごとの数）。事実を足さない', () => {
    const answer: AskAnswer = {
      answer: [
        { text: '入院3日目にも補正した。', refs: [{ id: 'R9', quote: '' }] },
        { text: '補正は 40mEq だった。', refs: [{ id: 'R1', quote: 'KCl 40mEq で補正' }] },
        { text: '根拠のない文。', refs: [] },
        { text: '', refs: [{ id: 'R1', quote: '' }] },
      ],
      notFound: '記録に見つかりませんでした（3日目の記載はありません）',
    };
    const reply = checkAnswer(answer, material);
    expect(reply.answer).toEqual([]);
    expect(reply.rejected).toEqual({ unknown_ref: 1, bad_quote: 1, no_ref: 3, empty: 1 });
    expect(reply.notFound).toBe('記録に見つかりませんでした（3日目の記載はありません）');
  });

  test('資料に見つからない数には※の場所。識別情報の形は伏せて数える', () => {
    const phone = ['090', '1234', '5678'].join('-');
    const reply = checkAnswer({ answer: [{ text: `家族への説明は 5 回（連絡先 ${phone}）。`, refs: [{ id: 'E1', quote: '' }] }], notFound: '' }, material);
    const s = reply.answer[0];
    expect(s?.text).not.toContain(phone);
    expect(s?.text).toContain('〔電話番号〕');
    expect(reply.shapes).toBe(1);
    expect(s?.marks.map((m) => s.text.slice(m.start, m.end))).toEqual(['5']);
  });
});
