import { describe, expect, test } from 'vitest';

import { checkDraft, courseMaterial, type DraftAnswer, type MaterialInput, threadViews, type ThreadMention } from '../src/index.ts';

const TEXT1 = '#1 発熱\nA) 感染源を検索中\nP) 血液培養を提出\n#2 低K血症\nA) K 3.1 経口で補充';
const TEXT2 = '#1 市中肺炎\nA) 抗菌薬に反応\nP) セフトリアキソン 2g 継続';
const seg = (sourceId: string, text: string, labels: [string, string][]) =>
  labels.map(([label, start], i) => {
    const from = text.indexOf(start);
    const next = labels[i + 1];
    return { sourceId, label: label as never, start: from, end: next === undefined ? text.length : text.indexOf(next[1]) };
  });

const m = (id: string, sourceId: string, text: string, name: string, threadId: string, at: string): ThreadMention => ({
  id,
  sourceId,
  threadId,
  name,
  status: 'problem',
  activity: null,
  at,
  start: text.indexOf(name),
  end: text.indexOf(name) + name.length,
});

function input(): MaterialInput {
  const mentions = [
    m('p1', 's1', TEXT1, '#1 発熱', 'T-a', '2026-11-17T23:00'),
    m('p2', 's1', TEXT1, '#2 低K血症', 'T-b', '2026-11-17T23:00'),
    m('p3', 's2', TEXT2, '#1 市中肺炎', 'T-a', '2026-11-19T09:00'),
  ];
  const threads = threadViews([{ id: 'T-a', displayName: null, mergedInto: null }, { id: 'T-b', displayName: null, mergedInto: null }], mentions).threads;
  return {
    encounter: { id: 'e1', kind: 'inpatient', start: '2026-11-17T22:10' },
    sources: [
      { id: 's1', encounterId: 'e1', at: '2026-11-17T23:00', text: TEXT1 },
      { id: 's2', encounterId: 'e1', at: '2026-11-19T09:00', text: TEXT2 },
      { id: 'sx', encounterId: 'other', at: '2026-10-01', text: '#1 別の受診' },
    ],
    threads,
    segments: [
      ...seg('s1', TEXT1, [
        ['problem_heading', '#1 発熱'],
        ['assessment', 'A) 感染源'],
        ['plan', 'P) 血液'],
        ['problem_heading', '#2 低K'],
        ['assessment', 'A) K 3.1'],
      ]),
      ...seg('s2', TEXT2, [
        ['problem_heading', '#1 市中肺炎'],
        ['assessment', 'A) 抗菌薬'],
        ['plan', 'P) セフ'],
      ]),
    ],
    medications: [{ sourceId: 's2', start: TEXT2.indexOf('セフ'), end: TEXT2.indexOf('セフ') + 8, name: 'セフトリアキソン', doseText: '2g', action: 'continue', at: '2026-11-19T09:00' }],
    events: [],
  };
}

describe('courseMaterial（草案の資料）', () => {
  test('問題ごとの A・P と、その問題の記載に書かれた投薬を、記号つきの引用にする。ほかの受診の記載は入れない', () => {
    const mat = courseMaterial(input());
    expect(mat.problems.map((p) => [p.ref, p.name])).toEqual([
      ['T1', '#1 市中肺炎'],
      ['T2', '#2 低K血症'],
    ]);
    expect(mat.quotes.map((q) => [q.id, q.problem, q.from, q.text, q.day])).toEqual([
      ['Q1', 'T1', 'A（評価）', 'A) 感染源を検索中', 1],
      ['Q2', 'T1', 'P（方針）', 'P) 血液培養を提出', 1],
      ['Q3', 'T2', 'A（評価）', 'A) K 3.1 経口で補充', 1],
      ['Q4', 'T1', 'A（評価）', 'A) 抗菌薬に反応', 3],
      ['Q5', 'T1', 'P（方針）', 'P) セフトリアキソン 2g 継続', 3],
      ['Q6', 'T1', '投薬', 'セフトリアキソン 2g（継続）', 3],
    ]);
    expect(mat.message).not.toContain('別の受診');
    expect((JSON.parse(mat.message) as { quotes: unknown[] }).quotes[0]).toEqual({ id: 'Q1', problem: 'T1', date: '2026-11-17 23:00', day: '1病日', from: 'A（評価）', text: 'A) 感染源を検索中' });
  });
});

describe('草案の共通の資料（CA-048）', () => {
  test('どの問題の範囲にも入らないできごとは、problem: null の引用。問題の範囲の中のできごとは、その問題の引用のまま', () => {
    const base = input();
    const TEXT3 = '泌尿器科 併診\n18:10 尿管ステントを留置';
    const mat = courseMaterial({
      ...base,
      sources: [...base.sources, { id: 's3', encounterId: 'e1', at: '2026-11-17T18:10', text: TEXT3 }],
      events: [
        { sourceId: 's3', start: TEXT3.indexOf('尿管'), end: TEXT3.length, kind: 'procedure', title: '尿管ステントを留置', at: '2026-11-17T18:10' },
        { sourceId: 's1', start: TEXT1.indexOf('血液培養'), end: TEXT1.indexOf('血液培養') + 4, kind: 'test', title: '血液培養', at: '2026-11-17T23:00' },
      ],
    });
    expect(mat.quotes.filter((q) => q.from.startsWith('できごと')).map((q) => [q.problem, q.text])).toEqual([
      [null, '尿管ステントを留置'],
      ['T1', '血液培養'],
    ]);
    const shared = mat.quotes.find((q) => q.problem === null)?.id ?? '';
    const own = mat.quotes.find((q) => q.problem === 'T1')?.id ?? '';
    const other = mat.quotes.find((q) => q.problem === 'T2')?.id ?? '';
    const r = checkDraft(
      {
        sections: [
          {
            problem: 'T1',
            sentences: [
              { text: '1病日、尿管ステントを留置した。', cites: [shared, own] },
              { text: '低K血症の補充を行った。', cites: [other] },
            ],
          },
        ],
      },
      mat,
    );
    expect(r.sections[0]?.sentences.map((x) => x.text)).toEqual(['1病日、尿管ステントを留置した。']);
    expect(r.rejected).toEqual({ other_problem: 1 });
  });
});

describe('checkDraft（決定論の確かめ）', () => {
  const mat = courseMaterial(input());
  const draft = (sentences: DraftAnswer['sections'][number]['sentences'], problem = 'T1'): DraftAnswer => ({ sections: [{ problem, sentences }] });

  test('根拠の引用にある数・日付・病日だけの文は通る。先頭の 0 の違いは同じ数', () => {
    const r = checkDraft(draft([{ text: '1病日（11/17 23時）、感染源を検索し、血液培養を提出した。', cites: ['Q1', 'Q2'] }, { text: '3病日、抗菌薬に反応し、セフトリアキソン 2g を継続した。', cites: ['Q4', 'Q5'] }]), mat);
    expect(r.rejected).toEqual({});
    expect(r.sections[0]?.sentences.map((s) => s.cites.map((q) => q.id))).toEqual([
      ['Q1', 'Q2'],
      ['Q4', 'Q5'],
    ]);
  });

  test('日付・病日の数で、検査値の数を通さない（「CRP は 3」は、3病日の 3 では通らない）', () => {
    const r = checkDraft(draft([{ text: 'CRP は 3 まで下がった。', cites: ['Q4'] }, { text: '3病日（11/19 9時）に抗菌薬に反応した。', cites: ['Q4'] }]), mat);
    expect(r.rejected).toEqual({ number: 1 });
    expect(r.sections[0]?.sentences.map((s) => s.text)).toEqual(['3病日（11/19 9時）に抗菌薬に反応した。']);
  });

  test('根拠にない数・根拠のない文・知らない記号・別の問題の引用・識別情報の形・形の違う文は出さず、数える', () => {
    const phone = ['090', '1234', '5678'].join('-');
    const r = checkDraft(
      {
        sections: [
          {
            problem: 'T1',
            sentences: [
              { text: 'CRP は 12 から改善した。', cites: ['Q4'] },
              { text: '抗菌薬に反応した。', cites: [] },
              { text: '抗菌薬に反応した。', cites: ['Q99'] },
              { text: 'K を補充した。', cites: ['Q3'] },
              { text: `家族の連絡先 ${phone}`, cites: ['Q4'] },
              { text: '', cites: ['Q4'] },
              { text: '抗菌薬に反応した。', cites: ['Q4'] },
            ],
          },
          { problem: 'T9', sentences: [{ text: 'x', cites: ['Q1'] }] },
        ],
      },
      mat,
    );
    expect(r.rejected).toEqual({ number: 2, no_cite: 1, unknown_cite: 1, other_problem: 1, shape_of_text: 1, unknown_problem: 1 });
    expect(r.sections[0]?.sentences.map((s) => s.text)).toEqual(['抗菌薬に反応した。']);
  });

  test('長さの上限を超える資料は、古い引用から落とし、落とした数を返す', () => {
    const big = input();
    const long = `A) ${'経過'.repeat(190)}`;
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `s${String(i + 10)}`, encounterId: 'e1', at: `2026-11-${String(10 + (i % 18)).padStart(2, '0')}`, text: `#1 市中肺炎\n${long}` }));
    const mentions = many.map((s, i) => ({ id: `x${String(i)}`, sourceId: s.id, threadId: 'T-a', name: '#1 市中肺炎', status: 'problem' as const, activity: null, at: s.at, start: 0, end: 7 }));
    const threads = threadViews([{ id: 'T-a', displayName: null, mergedInto: null }], mentions).threads;
    const segs = many.flatMap((s) => [
      { sourceId: s.id, label: 'problem_heading' as const, start: 0, end: 8 },
      { sourceId: s.id, label: 'assessment' as const, start: 8, end: s.text.length },
    ]);
    const mat2 = courseMaterial({ ...big, sources: many, threads, segments: segs, medications: [] });
    expect(mat2.dropped).toBeGreaterThan(0);
    expect(mat2.message.length).toBeLessThan(30_000);
  });
});
