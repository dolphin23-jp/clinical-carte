// AI の整理の答えを、確かめて記録の行にする（段2）。文は架空。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { applyOrganization, eventTimeline, medicationTimeline, type OrganizeAnswer, type OrganizeContext, problemKey, problemList, reportTotal } from '../src/index.ts';

const NOTE = [
  '#1 市中肺炎',
  'S) 咳嗽は軽減。',
  'O) BT 37.2 SpO2 96%（室内気）。昨日 BT 38.4。',
  'A) 抗菌薬に反応良好。',
  'P) メロペネム 1g 8時間毎 を継続。11/18 22:00 より開始。11/19 胸部X線を撮影。',
  'K 3.5 を目標に補正。',
].join('\n');

const ctx: OrganizeContext = { text: NOTE, kind: 'progress_note', at: '2026-11-20T09:00', encounterStart: '2026-11-18T22:10' };

const empty: OrganizeAnswer = { kind: null, when: null, segments: [], medications: [], events: [], problems: [], measurements: [] };
const answer = (patch: Partial<OrganizeAnswer>): OrganizeAnswer => ({ ...empty, ...patch });

describe('区切り', () => {
  test('始まりの引用で区切る。区切りは、次の区切りの前まで。文は1字も変えない', () => {
    const r = applyOrganization(
      answer({
        segments: [
          { label: 'subjective', start: 'S) 咳嗽は軽減。' },
          { label: 'objective', start: 'O) BT 37.2' },
          { label: 'assessment', start: 'A) 抗菌薬' },
          { label: 'plan', start: 'P) メロペネム' },
        ],
      }),
      ctx,
    );
    expect(r.segments.map((s) => [s.label, NOTE.slice(s.start, s.end).split('\n')[0]])).toEqual([
      ['subjective', 'S) 咳嗽は軽減。'],
      ['objective', 'O) BT 37.2 SpO2 96%（室内気）。昨日 BT 38.4。'],
      ['assessment', 'A) 抗菌薬に反応良好。'],
      ['plan', 'P) メロペネム 1g 8時間毎 を継続。11/18 22:00 より開始。11/19 胸部X線を撮影。'],
    ]);
    expect(r.segments.at(-1)?.end).toBe(NOTE.length);
    expect(r.report).toEqual({});
  });

  test('見つからない・順が逆の区切りは使わず、数える', () => {
    const r = applyOrganization(
      answer({
        segments: [
          { label: 'objective', start: 'O) BT 37.2' },
          { label: 'subjective', start: 'S) 咳嗽は軽減。' },
          { label: 'plan', start: 'Plan:' },
        ],
      }),
      ctx,
    );
    expect(r.segments.map((s) => s.label)).toEqual(['objective']);
    expect(r.report).toEqual({ segment: { not_found: 2 } });
  });
});

describe('投薬・できごと・問題', () => {
  test('名前・用量は、文の字のまま。日時は、引用を決定論で読む（なければ記載の日時）', () => {
    const r = applyOrganization(
      answer({
        medications: [
          { name: 'メロペネム', dose: '1g 8時間毎', action: 'continue', when: null },
          { name: 'メロペネム', dose: null, action: 'start', when: '11/18 22:00' },
        ],
        events: [{ kind: 'test', title: '胸部X線を撮影', when: '11/19' }],
        problems: [{ name: '#1 市中肺炎', status: 'problem', activity: null }],
      }),
      ctx,
    );
    expect(r.medications.map((m) => [m.name, m.doseText, m.action, m.at])).toEqual([
      ['メロペネム', '1g 8時間毎', 'continue', '2026-11-20T09:00'],
      ['メロペネム', null, 'start', '2026-11-18T22:00'],
    ]);
    expect(r.events.map((e) => [e.kind, e.title, e.at])).toEqual([['test', '胸部X線を撮影', '2026-11-19']]);
    expect(r.problems.map((p) => [p.name, p.status, p.at])).toEqual([['#1 市中肺炎', 'problem', '2026-11-20T09:00']]);
    for (const f of [...r.medications, ...r.events, ...r.problems]) expect(NOTE.slice(f.start, f.end)).toBe('name' in f ? f.name : f.title);
    expect(r.report).toEqual({});
  });

  test('文にない名前・用量・日時の引用は、事実にしない（AI が作った字を、記録に入れない）', () => {
    const r = applyOrganization(
      answer({
        medications: [
          { name: 'バンコマイシン', dose: null, action: 'start', when: null },
          { name: 'メロペネム', dose: '2g 8時間毎', action: 'change', when: null },
        ],
        events: [{ kind: 'surgery', title: '胸腔ドレーン留置', when: null }],
        problems: [{ name: '敗血症', status: 'suspected', activity: null }],
      }),
      ctx,
    );
    expect([r.medications, r.events, r.problems]).toEqual([[], [], []]);
    expect(r.report).toEqual({ medication: { not_found: 2 }, event: { not_found: 1 }, problem: { not_found: 1 } });
    expect(reportTotal(r.report)).toBe(4);
  });

  test('日時の引用が読めないときは、日時なし（記載の日時で埋めない）', () => {
    const r = applyOrganization(answer({ events: [{ kind: 'test', title: '胸部X線を撮影', when: '咳嗽' }] }), ctx);
    expect(r.events.map((e) => e.at)).toEqual([null]);
    expect(r.report).toEqual({ event: { when_unread: 1 } });
  });

  test('形の違う引用（空・前後の空白・改行・長すぎる）は、使わない', () => {
    const r = applyOrganization(
      answer({
        problems: [
          { name: '', status: 'problem', activity: null },
          { name: ' 市中肺炎', status: 'problem', activity: null },
          { name: '市中肺炎\nS)', status: 'problem', activity: null },
          { name: 'あ'.repeat(201), status: 'problem', activity: null },
        ],
      }),
      ctx,
    );
    expect(r.problems).toEqual([]);
    expect(r.report).toEqual({ problem: { bad_quote: 4 } });
  });
});

describe('測定値：数は、AI に写させない', () => {
  test('経過の文：AI が指した場所だけを、決定論で読む。「K 3.5 を目標に」は、指されなければ測定値にならない', () => {
    const r = applyOrganization(
      answer({
        measurements: [
          { quote: 'BT 37.2 SpO2 96%', when: null },
          { quote: 'BT 38.4', when: '昨日' },
        ],
      }),
      ctx,
    );
    expect(r.observations.map((o) => [o.row.name, o.row.value, o.at, o.origin])).toEqual([
      ['体温', 37.2, '2026-11-20T09:00', 'ai'],
      ['SpO2', 96, '2026-11-20T09:00', 'ai'],
      ['体温', 38.4, '2026-11-19', 'ai'],
    ]);
    for (const o of r.observations) expect(NOTE.slice(o.row.start, o.row.end)).toContain(o.row.valueText);
  });

  test('同じ引用が2回あれば、2つめの場所を使う', () => {
    const text = 'BT 37.5 にて経過観察。夜間 BT 37.5 で変わらず。';
    const r = applyOrganization(
      answer({
        measurements: [
          { quote: 'BT 37.5', when: null },
          { quote: 'BT 37.5', when: '昨夜' },
        ],
      }),
      { ...ctx, text },
    );
    expect(r.observations.map((o) => o.row.start)).toEqual([0, text.lastIndexOf('BT 37.5')]);
  });

  test('AI が、値でない所（測定でない数）を指しても、読めなければ事実にならない', () => {
    const r = applyOrganization(answer({ measurements: [{ quote: 'を目標に補正', when: null }] }), ctx);
    expect(r.observations).toEqual([]);
    expect(r.report).toEqual({ measurement: { unread: 1 } });
  });

  test('検査結果・バイタルの文：文全体を決定論で読む（AI の指した場所は使わない）', () => {
    const text = 'WBC 12.3 CRP 8.5';
    const r = applyOrganization(answer({ measurements: [{ quote: 'WBC 12.3', when: null }] }), { ...ctx, text, kind: 'lab' });
    expect(r.observations.map((o) => [o.row.name, o.origin])).toEqual([
      ['WBC', 'parser'],
      ['CRP', 'parser'],
    ]);
  });
});

describe('記載の種類と日時', () => {
  test('種類は、未分類の文だけ、AI の答えを使う', () => {
    expect(applyOrganization(answer({ kind: 'progress_note' }), { ...ctx, kind: 'unsorted' }).kind).toBe('progress_note');
    expect(applyOrganization(answer({ kind: 'nursing' }), ctx).kind).toBe('progress_note');
    expect(applyOrganization(answer({ kind: 'unsorted' }), { ...ctx, kind: 'unsorted' }).kind).toBe('unsorted');
  });

  test('未分類の文が「検査結果」になれば、文全体を決定論で読む', () => {
    const r = applyOrganization(answer({ kind: 'lab' }), { ...ctx, text: 'Na 128 K 3.1', kind: 'unsorted' });
    expect(r.observations.map((o) => [o.row.name, o.origin])).toEqual([
      ['Na', 'parser'],
      ['K', 'parser'],
    ]);
  });

  test('日時は、入れたときに分からなかったときだけ、文から読む（年のある日付だけ）', () => {
    const text = '2026/11/19 記載。解熱。';
    expect(applyOrganization(answer({ when: '2026/11/19' }), { ...ctx, text, at: null }).at).toBe('2026-11-19');
    expect(applyOrganization(answer({ when: '2026/11/19' }), { ...ctx, text }).at).toBe(ctx.at);
    const noYear = applyOrganization(answer({ when: '11/19' }), { ...ctx, text: '11/19 記載。', at: null });
    expect(noYear.at).toBeNull();
    expect(noYear.report).toEqual({ when: { when_unread: 1 } });
  });
});

describe('性質', () => {
  const letters = fc.constantFrom('a', 'あ', '熱', ' ', '\n', '1', '2', '.', '/', ':', 'K', 'B', 'T', '3', '8');
  const quote = fc.string({ unit: letters, maxLength: 12 });

  test('どんな答えでも、事実の文字は、保存した文の、その場所の字そのもの', () => {
    fc.assert(
      fc.property(fc.string({ unit: letters, minLength: 1, maxLength: 80 }), fc.array(quote, { maxLength: 6 }), (text, quotes) => {
        const r = applyOrganization(
          {
            ...empty,
            medications: quotes.map((q) => ({ name: q, dose: q, action: null, when: q })),
            events: quotes.map((q) => ({ kind: 'other' as const, title: q, when: null })),
            problems: quotes.map((q) => ({ name: q, status: 'problem' as const, activity: null })),
            measurements: quotes.map((q) => ({ quote: q, when: null })),
            segments: quotes.map((q) => ({ label: 'other' as const, start: q })),
          },
          { ...ctx, text },
        );
        const folded = (s: string) => s.normalize('NFKC');
        for (const m of r.medications) expect(folded(text.slice(m.start, m.end))).toBe(folded(m.name));
        for (const e of r.events) expect(folded(text.slice(e.start, e.end))).toBe(folded(e.title));
        for (const p of r.problems) expect(folded(text.slice(p.start, p.end))).toBe(folded(p.name));
        for (const o of r.observations) expect(text.slice(o.row.start, o.row.end)).toContain(o.row.valueText);
        let last = -1;
        for (const s of r.segments) {
          expect(s.start).toBeGreaterThan(last);
          expect(s.end).toBeLessThanOrEqual(text.length);
          last = s.start;
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('見方（保存しない）', () => {
  test('投薬の時間軸：同じ名前（全角半角・大小）をまとめ、日時の順', () => {
    const lines = medicationTimeline([
      { id: '3', sourceId: 's2', name: 'ＭＥＰＭ', doseText: null, action: 'stop', at: '2026-11-25' },
      { id: '1', sourceId: 's1', name: 'MEPM', doseText: '1g×3', action: 'start', at: '2026-11-18' },
      { id: '2', sourceId: 's1', name: 'アセトアミノフェン', doseText: null, action: null, at: null },
    ]);
    expect(lines.map((l) => [l.name, l.entries.map((e) => e.action)])).toEqual([
      ['MEPM', ['start', 'stop']],
      ['アセトアミノフェン', [null]],
    ]);
  });

  test('問題の一覧：番号を除いてまとめ、最初と最後の日時、いちばん新しい書かれ方', () => {
    expect(problemKey('#1 市中肺炎')).toBe(problemKey('＃２．市中肺炎'));
    const lines = problemList([
      { id: '1', sourceId: 's1', name: '#1 市中肺炎疑い', status: 'suspected', at: '2026-11-18' },
      { id: '2', sourceId: 's2', name: '#1 市中肺炎疑い', status: 'diagnosis', at: '2026-11-20' },
      { id: '3', sourceId: 's2', name: '#2 低Na血症', status: 'problem', at: '2026-11-20' },
    ]);
    expect(lines).toEqual([
      { name: '#1 市中肺炎疑い', mentions: 2, first: '2026-11-18', last: '2026-11-20', latestStatus: 'diagnosis' },
      { name: '#2 低Na血症', mentions: 1, first: '2026-11-20', last: '2026-11-20', latestStatus: 'problem' },
    ]);
  });

  test('できごと：日時の順。日時のないものは最後', () => {
    const list = eventTimeline([
      { id: '1', sourceId: 's', kind: 'test', title: 'b', at: null },
      { id: '2', sourceId: 's', kind: 'test', title: 'c', at: '2026-11-20' },
      { id: '3', sourceId: 's', kind: 'test', title: 'a', at: '2026-11-19T08:00' },
    ]);
    expect(list.map((e) => e.title)).toEqual(['a', 'c', 'b']);
  });
});
