import { describe, expect, test } from 'vitest';

import {
  ApNoteNew,
  checkDiscussion,
  checkProposal,
  type MaterialProblem,
  type NoteInput,
  noteDay,
  noteDays,
  type NoteObservation,
  observationTexts,
  proposalMessage,
  recordSources,
  type RefSource,
  type ThreadMention,
  threadViews,
} from '../src/index.ts';

const T1 = '#1 市中肺炎\nS) 咳嗽は軽減\nO) 胸部でラ音は減少 CRP 6.8\nA) 抗菌薬に反応\nP) セフトリアキソン 2g 継続\n#2 低Na血症\nA) 経過観察';
const T0 = '#1 発熱\nA) 原因を検索\nP) 血液培養を提出';
const seg = (sourceId: string, text: string, labels: [string, string][]) =>
  labels.map(([label, start], i) => {
    const next = labels[i + 1];
    return { sourceId, label: label as never, start: text.indexOf(start), end: next === undefined ? text.length : text.indexOf(next[1]) };
  });
const at = (text: string, s: string) => text.indexOf(s);
const m = (id: string, sourceId: string, text: string, name: string, threadId: string, when: string): ThreadMention => ({
  id,
  sourceId,
  threadId,
  name,
  status: 'problem',
  activity: null,
  at: when,
  start: at(text, name),
  end: at(text, name) + name.length,
});

function input(day = '2026-11-19'): NoteInput {
  const mentions = [m('a', 's0', T0, '#1 発熱', 'TA', '2026-11-17T23:00'), m('b', 's1', T1, '#1 市中肺炎', 'TA', '2026-11-19T09:00'), m('c', 's1', T1, '#2 低Na血症', 'TB', '2026-11-19T09:00')];
  return {
    encounter: { id: 'e1', kind: 'inpatient', start: '2026-11-17T22:10' },
    day,
    sources: [
      { id: 's0', encounterId: 'e1', at: '2026-11-17T23:00', text: T0 },
      { id: 's1', encounterId: 'e1', at: '2026-11-19T09:00', text: T1 },
    ],
    segments: [
      ...seg('s0', T0, [
        ['problem_heading', '#1 発熱'],
        ['assessment', 'A) 原因'],
        ['plan', 'P) 血液'],
      ]),
      ...seg('s1', T1, [
        ['problem_heading', '#1 市中'],
        ['subjective', 'S) 咳'],
        ['objective', 'O) 胸部'],
        ['assessment', 'A) 抗菌'],
        ['plan', 'P) セフ'],
        ['problem_heading', '#2 低Na'],
        ['assessment', 'A) 経過'],
      ]),
    ],
    threads: threadViews(
      [
        { id: 'TA', displayName: null, mergedInto: null },
        { id: 'TB', displayName: null, mergedInto: null },
      ],
      mentions,
    ).threads,
    observations: [
      { id: 'o1', sourceId: 's1', encounterId: 'e1', at: '2026-11-19T09:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', valueText: '6.8', unit: null, start: at(T1, 'CRP'), end: at(T1, 'CRP') + 7 },
      { id: 'o2', sourceId: 'sv', encounterId: 'e1', at: '2026-11-19T06:00', name: '体温', nameRaw: 'BT', kind: 'vital', valueText: '36.9', unit: null, start: 0, end: 7 },
    ],
    medications: [{ id: 'd1', sourceId: 's1', name: 'セフトリアキソン', doseText: '2g', action: 'continue', at: '2026-11-19T09:00', start: at(T1, 'セフ'), end: at(T1, 'セフ') + 8 }],
  };
}

describe('記載ノート（noteDay）', () => {
  test('問題ごとに、その日の S・O、記載に書かれた値、いちばん新しい A・P。その日のバイタル', () => {
    const d = noteDay(input());
    expect(d.hospitalDay).toBe(3);
    expect(d.problems.map((p) => p.thread.name)).toEqual(['#1 市中肺炎', '#2 低Na血症']);
    const p1 = d.problems[0];
    expect(p1?.s.map((x) => x.label)).toEqual(['subjective']);
    expect(p1?.o.map((x) => x.label)).toEqual(['objective']);
    expect(p1?.values.map((v) => v.name)).toEqual(['CRP']);
    expect(p1?.lastAp.map((x) => x.label)).toEqual(['assessment', 'plan']);
    expect(d.vitals.map((v) => v.name)).toEqual(['体温']);
  });

  test('前の日は、その日までの記載だけ（後日の A・P は出ない）', () => {
    const d = noteDay(input('2026-11-17'));
    expect(d.problems.map((p) => p.thread.mentions.length)).toEqual([2]);
    const ap = d.problems[0]?.lastAp ?? [];
    expect(ap.every((x) => x.sourceId === 's0')).toBe(true);
  });

  test('記載のある日（新しい順）', () => {
    expect(noteDays('e1', input().sources)).toEqual(['2026-11-19', '2026-11-17']);
  });
});

describe('値の表示（observationTexts）', () => {
  const o = (patch: Partial<NoteObservation>): NoteObservation => ({ id: 'x', sourceId: 's', encounterId: 'e1', at: '2026-11-21T11:50', name: 'Hb', nameRaw: 'Hb', kind: 'lab', valueText: '11.8', unit: 'g/dL', start: 0, end: 7, ...patch });
  test('血圧は、同じ文・同じ場所の収縮期と拡張期を1つにする。ほかは、書かれた名前と値のまま', () => {
    const sys = o({ id: '1', name: '収縮期血圧', nameRaw: 'BP', kind: 'vital', valueText: '98', unit: null, start: 10, end: 18 });
    const dia = o({ id: '2', name: '拡張期血圧', nameRaw: 'BP', kind: 'vital', valueText: '52', unit: null, start: 10, end: 18 });
    expect(observationTexts([dia, o({}), sys]).map((t) => [t.name, t.text])).toEqual([
      ['血圧', 'BP 98/52'],
      ['Hb', 'Hb 11.8 g/dL'],
    ]);
    // 場所の違う（別の測定の）収縮期・拡張期は、組にしない
    const other = o({ id: '3', name: '拡張期血圧', nameRaw: 'BP', kind: 'vital', valueText: '40', unit: null, start: 30, end: 38 });
    expect(observationTexts([sys, other]).map((t) => t.text)).toEqual(['BP 98', 'BP 40']);
  });
});

describe('AI の資料（recordSources）', () => {
  const problems: MaterialProblem[] = [{ ref: 'T1', threadId: 'TA', name: '#1 市中肺炎' }];
  test('その問題の A・P（新しい記載から）・その日の S・O・値・薬、どの問題にも使えるその日のバイタル。場所の参照つき', () => {
    const q = recordSources(input(), problems);
    expect(q.map((x) => [x.id, x.problem, x.label])).toEqual([
      ['Q1', 'T1', 'A（評価）'],
      ['Q2', 'T1', 'P（方針）'],
      ['Q3', 'T1', 'A（評価）'],
      ['Q4', 'T1', 'P（方針）'],
      ['Q5', 'T1', 'S'],
      ['Q6', 'T1', 'O'],
      ['Q7', 'T1', '値（CRP）'],
      ['Q8', 'T1', '投薬'],
      ['Q9', null, 'バイタル（体温）'],
    ]);
    expect(q[7]?.text).toBe('セフトリアキソン 2g（継続）');
    expect(q[0]?.ref).toEqual({ k: 'record', sourceId: 's0', start: at(T0, 'A) 原因'), end: at(T0, 'P) 血液') });
    const msg = JSON.parse(proposalMessage(problems, q, { day: '2026-11-19' })) as { sources: { id: string; day: string | null }[] };
    expect(msg.sources[0]).toMatchObject({ id: 'Q1', day: '1病日' });
    expect(JSON.stringify(msg)).not.toContain('低Na'); // 選ばなかった問題の記載は送らない
  });
});

describe('値の表示の不等号', () => {
  test('不等号は、書かれた値に添える（落とさない）', () => {
    const o = { id: 'x', sourceId: 's', encounterId: 'e', at: null, name: '尿沈渣WBC', nameRaw: 'WBC', kind: 'lab' as const, comparator: '>', valueText: '100', unit: '/HPF', start: 0, end: 5 };
    expect(observationTexts([o]).map((t) => t.text)).toEqual(['WBC >100 /HPF']);
  });
});

describe('AI の資料の共通の引用（CA-048）', () => {
  const problems: MaterialProblem[] = [{ ref: 'T1', threadId: 'TA', name: '#1 市中肺炎' }];
  test('その日の、どの問題にも入らない S・O と、その日までの検査値（項目ごとのいちばん新しい値）を、どの問題にも使える引用にする', () => {
    const T2 = 'S) 食欲が戻った\nO) 歩行でふらつく';
    const base = input();
    const q = recordSources(
      {
        ...base,
        sources: [...base.sources, { id: 's2', encounterId: 'e1', at: '2026-11-19T15:00', text: T2 }],
        segments: [...base.segments, ...seg('s2', T2, [['subjective', 'S) 食欲'], ['objective', 'O) 歩行']])],
        observations: [
          ...base.observations,
          { id: 'k1', sourceId: 'sl', encounterId: 'e1', at: '2026-11-18T06:00', name: 'K', nameRaw: 'K', kind: 'lab', valueText: '3.4', unit: null, start: 0, end: 5 },
          { id: 'k2', sourceId: 'sl2', encounterId: 'e1', at: '2026-11-19T06:00', name: 'K', nameRaw: 'K', kind: 'lab', valueText: '3.8', unit: null, start: 0, end: 5 },
          // その日より後の値・別の受診の値は入れない
          { id: 'k3', sourceId: 'sl3', encounterId: 'e1', at: '2026-11-20T06:00', name: 'K', nameRaw: 'K', kind: 'lab', valueText: '4.1', unit: null, start: 0, end: 5 },
          { id: 'n1', sourceId: 'sx', encounterId: 'e0', at: '2026-11-19T06:00', name: 'Na', nameRaw: 'Na', kind: 'lab', valueText: '130', unit: null, start: 0, end: 6 },
        ],
      },
      problems,
    );
    const shared = q.filter((x) => x.problem === null).map((x) => [x.label, x.text]);
    expect(shared).toEqual([
      ['S', 'S) 食欲が戻った'],
      ['O', 'O) 歩行でふらつく'],
      ['検査（K）', 'K 3.8'],
      ['バイタル（体温）', 'BT 36.9'],
    ]);
    // 問題の範囲に書かれた値（CRP）は、問題の引用のまま。共通の引用に二重に入れない
    expect(q.filter((x) => x.text.startsWith('CRP')).map((x) => x.problem)).toEqual(['T1']);
  });
});

describe('AI の案の確かめ（checkProposal）', () => {
  const problems: MaterialProblem[] = [
    { ref: 'T1', threadId: 'TA', name: '#1 市中肺炎' },
    { ref: 'T2', threadId: 'TB', name: '#2 低Na血症' },
  ];
  const q = recordSources(input(), problems);
  const sources: RefSource[] = [
    ...q,
    { id: 'W1', kind: 'web', problem: null, text: '成人の市中肺炎ではセフトリアキソン 1〜2g を 24 時間ごと', at: null, day: null, label: 'ガイドライン', ref: { k: 'web', title: 'ガイドライン', url: 'https://example.org/g' } },
  ];
  test('根拠の出典にある数だけ通る。出典を根拠にした文は source、記録だけは record・推論はそのまま', () => {
    const r = checkProposal(
      {
        problems: [
          {
            problem: 'T1',
            assessment: [
              { text: '3病日、抗菌薬に反応している。', cites: ['Q3'], basis: 'record' },
              { text: '経過から、治療は奏効していると考える。', cites: ['Q3', 'Q6'], basis: 'inference' },
            ],
            plan: [
              { text: 'セフトリアキソン 2g を 24 時間ごとで継続を検討。', cites: ['Q8', 'W1'], basis: 'source', kind: 'tx' },
              { text: 'セフトリアキソン 4g に増量。', cites: ['Q8', 'W1'], basis: 'source', kind: 'tx' },
              { text: '血液培養を再検。', cites: ['W1'], basis: 'record', kind: 'dx' },
            ],
          },
        ],
      },
      problems,
      sources,
    );
    expect(r.rejected).toEqual({ number: 1 });
    const p = r.problems[0];
    expect(p?.assessment.map((x) => x.basis)).toEqual(['record', 'inference']);
    expect(p?.plan.map((x) => [x.kind, x.basis])).toEqual([
      ['tx', 'source'],
      ['dx', 'inference'],
    ]);
  });

  test('根拠なし・知らない記号・別の問題の記録・識別情報の形・知らない問題は出さない', () => {
    const t2q = q.find((x) => x.problem === 'T1')?.id ?? '';
    const phone = ['090', '1234', '5678'].join('-');
    const r = checkProposal(
      {
        problems: [
          { problem: 'T2', assessment: [{ text: 'a', cites: [], basis: 'record' }, { text: 'b', cites: ['Q99'], basis: 'record' }, { text: 'c', cites: [t2q], basis: 'record' }], plan: [] },
          { problem: 'T1', assessment: [{ text: `連絡 ${phone}`, cites: ['W1'], basis: 'source' }], plan: [] },
          { problem: 'T9', assessment: [{ text: 'x', cites: ['Q1'], basis: 'record' }], plan: [] },
        ],
      },
      problems,
      sources,
    );
    expect(r.rejected).toEqual({ no_cite: 1, unknown_cite: 1, other_problem: 1, number: 1, unknown_problem: 1 });
    expect(r.problems).toEqual([]);
  });

  test('議論の答えも同じ確かめ', () => {
    const r = checkDiscussion({ paragraphs: [{ text: 'ガイドラインでは 24 時間ごと。', cites: ['W1'], basis: 'source' }, { text: '48 時間ごとでもよい。', cites: ['W1'], basis: 'source' }] }, 'T1', sources);
    expect(r.paragraphs.map((x) => x.text)).toEqual(['ガイドラインでは 24 時間ごと。']);
    expect(r.rejected).toEqual({ number: 1 });
  });
});

describe('A/P を足す形', () => {
  test('参照は場所・題・頁・URL だけ。本文の欄はない', () => {
    const base = { encounterId: '01JD0000000000000000000000', threadId: '01JD0000000000000000000001', day: '2026-11-19', part: 'plan', planKind: 'tx', text: '抗菌薬を継続', origin: 'ai' };
    expect(ApNoteNew.safeParse({ ...base, refs: [{ k: 'web', title: 'G', url: 'https://example.org/' }, { k: 'book', title: '本', page: 'p.12', path: null }] }).success).toBe(true);
    expect(ApNoteNew.safeParse({ ...base, refs: [{ k: 'book', title: '本', page: 'p.12', path: null, text: '本文' }] }).success).toBe(false);
    expect(ApNoteNew.safeParse({ ...base, origin: 'ai_edited', refs: [] }).success).toBe(false);
  });
});
