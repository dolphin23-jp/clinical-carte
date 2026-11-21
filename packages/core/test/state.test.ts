import { describe, expect, test } from 'vitest';

import { oneLinerOf, patientState, recentGroups, type RecentItem, type StateInput, type ThreadMention } from '../src/index.ts';

const E = 'enc1';
let n = 0;
const mention = (p: Partial<ThreadMention>): ThreadMention => {
  n += 1;
  return { id: `m${String(n).padStart(3, '0')}`, sourceId: 's1', threadId: 'T1', name: '#1 市中肺炎', status: 'problem', activity: null, at: '2026-11-20T09:00', start: 0, end: 7, ...p };
};

const base = (patch: Partial<StateInput> = {}): StateInput => ({
  patient: { age: 72, ageOn: '2026-11-17', sex: 'male' },
  encounter: { id: E, kind: 'inpatient', start: '2026-11-17T22:10', end: null },
  today: '2026-11-21',
  sources: [
    { id: 's0', encounterId: E, at: '2026-11-17T23:00', enteredAt: '2026-11-18T08:00' },
    { id: 's1', encounterId: E, at: '2026-11-20T09:00', enteredAt: '2026-11-20T10:12' },
  ],
  segments: [],
  threads: [{ id: 'T1', displayName: null, mergedInto: null }, { id: 'T2', displayName: null, mergedInto: null }, { id: 'T3', displayName: null, mergedInto: null }],
  mentions: [],
  medications: [],
  events: [],
  observations: [],
  ...patch,
});

describe('patientState：1行の要約と、いつの時点か', () => {
  test('年齢・性別・受診・病日（記録の上での最後の日時で）・いまの問題の名前だけで作る', () => {
    const s = patientState(
      base({
        mentions: [
          mention({ threadId: 'T1', name: '#1 発熱', at: '2026-11-17T23:00', sourceId: 's0' }),
          mention({ threadId: 'T1', name: '#1 市中肺炎', at: '2026-11-20T09:00' }),
          mention({ threadId: 'T2', name: '#2 低K血症', at: '2026-11-20T09:00', activity: 'resolved' }),
          mention({ threadId: 'T3', name: '肺塞栓', status: 'ruled_out', at: '2026-11-18' }),
        ],
      }),
    );
    expect(s.oneLiner).toBe('72歳 男性。入院 2026-11-17〜（記録の上では 4病日まで）。いまの問題：#1 市中肺炎。');
    expect(s.asOf).toBe('2026-11-20T09:00');
    expect(s.lastEntered).toBe('2026-11-20T10:12');
    expect(s.closed.map((t) => t.name)).toEqual(['#2 低K血症']);
    expect(s.ruledOut.map((t) => t.name)).toEqual(['肺塞栓']);
  });

  test('問題がなければ「いまの問題の記載なし」。外来は病日を書かない', () => {
    const s = patientState(base({ encounter: { id: E, kind: 'outpatient', start: '2026-11-20', end: null } }));
    expect(s.oneLiner).toBe('72歳 男性。外来 2026-11-20。いまの問題の記載なし。');
  });

  test('記録がなければ asOf も24時間もない', () => {
    const s = patientState(base({ sources: [] }));
    expect(s.asOf).toBeNull();
    expect(s.recent).toBeNull();
  });
});

describe('いまの問題の、最後の A・P', () => {
  test('いちばん新しい記載の A と P を、まとめて返す', () => {
    const s = patientState(
      base({
        mentions: [mention({ sourceId: 's0', at: '2026-11-17T23:00', start: 0, end: 5 }), mention({ sourceId: 's1', start: 0, end: 7 })],
        segments: [
          { sourceId: 's0', label: 'problem_heading', start: 0, end: 10 },
          { sourceId: 's0', label: 'assessment', start: 10, end: 20 },
          { sourceId: 's1', label: 'problem_heading', start: 0, end: 10 },
          { sourceId: 's1', label: 'assessment', start: 10, end: 20 },
          { sourceId: 's1', label: 'plan', start: 20, end: 30 },
        ],
      }),
    );
    expect(s.current[0]?.notes.map((x) => [x.sourceId, x.label])).toEqual([
      ['s1', 'assessment'],
      ['s1', 'plan'],
    ]);
  });
});

describe('最後の記録までの24時間', () => {
  test('新しく挙がった問題・解決と書かれた問題・投薬の動き・できごと・検査値（バイタルは除く）。新しい順', () => {
    const s = patientState(
      base({
        mentions: [
          mention({ threadId: 'T1', sourceId: 's0', at: '2026-11-17T23:00' }),
          mention({ threadId: 'T2', name: '#2 せん妄', at: '2026-11-19T20:00' }),
          mention({ threadId: 'T3', name: '#3 低K血症', sourceId: 's0', at: '2026-11-17T23:00' }),
          mention({ threadId: 'T3', name: '#3 低K血症', at: '2026-11-20T09:00', activity: 'resolved' }),
        ],
        medications: [
          { id: 'd1', sourceId: 's1', name: 'セフトリアキソン', doseText: '2g', action: 'start', at: '2026-11-17T23:00', start: 0, end: 1 },
          { id: 'd2', sourceId: 's1', name: 'セフトリアキソン', doseText: null, action: 'stop', at: '2026-11-20', start: 0, end: 1 },
          { id: 'd3', sourceId: 's1', name: 'アモキシシリン', doseText: null, action: null, at: '2026-11-20T08:00', start: 0, end: 1 },
        ],
        events: [{ id: 'e1', sourceId: 's1', kind: 'test', title: '胸部X線を撮影', at: '2026-11-19T10:00', start: 0, end: 1 }],
        observations: [
          { id: 'o1', sourceId: 's1', at: '2026-11-20T06:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', valueText: '2.1', unit: null, start: 0, end: 1 },
          { id: 'o2', sourceId: 's1', at: '2026-11-20T06:00', name: '体温', nameRaw: 'BT', kind: 'vital', valueText: '36.9', unit: null, start: 0, end: 1 },
          { id: 'o3', sourceId: 's1', at: '2026-11-18T06:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', valueText: '12.4', unit: null, start: 0, end: 1 },
        ],
      }),
    );
    expect(s.recent?.from).toBe('2026-11-19T09:00');
    expect(s.recent?.to).toBe('2026-11-20T09:00');
    expect(s.recent?.items.map((i) => i.type)).toEqual(['problem_activity', 'lab', 'medication', 'problem_new', 'event']);
    const med = s.recent?.items.find((i) => i.type === 'medication');
    expect(med).toMatchObject({ name: 'セフトリアキソン', action: 'stop' });
  });
});

describe('投薬と背景', () => {
  test('薬ごとの最後の記載。中止と書かれたものは別。続いているかは補わない', () => {
    const s = patientState(
      base({
        medications: [
          { id: 'd1', sourceId: 's1', name: 'セフトリアキソン', doseText: '2g', action: 'start', at: '2026-11-17T23:00', start: 0, end: 1 },
          { id: 'd2', sourceId: 's1', name: 'セフトリアキソン', doseText: null, action: 'stop', at: '2026-11-20', start: 0, end: 1 },
          { id: 'd3', sourceId: 's1', name: 'アモキシシリン', doseText: '500mg', action: 'start', at: '2026-11-20T08:00', start: 0, end: 1 },
        ],
      }),
    );
    expect(s.medications).toEqual([{ name: 'アモキシシリン', action: 'start', doseText: '500mg', at: '2026-11-20T08:00', entries: 1 }]);
    expect(s.stoppedMedications.map((m) => [m.name, m.entries])).toEqual([['セフトリアキソン', 2]]);
  });

  test('背景は、区切りごとに、いちばん新しい記載のもの（受診をまたぐ）。ほかの記載の数も', () => {
    const s = patientState(
      base({
        sources: [
          { id: 'old', encounterId: 'enc0', at: '2026-10-01', enteredAt: '2026-10-01T10:00' },
          { id: 's1', encounterId: E, at: '2026-11-20T09:00', enteredAt: '2026-11-20T10:12' },
        ],
        segments: [
          { sourceId: 'old', label: 'past_history', start: 0, end: 10 },
          { sourceId: 's1', label: 'past_history', start: 5, end: 25 },
          { sourceId: 'old', label: 'allergy', start: 10, end: 20 },
          { sourceId: 's1', label: 'subjective', start: 25, end: 40 },
        ],
      }),
    );
    expect(s.background.map((b) => [b.name, b.sourceId, b.start, b.others])).toEqual([
      ['既往歴', 's1', 5, 1],
      ['アレルギー', 'old', 10, 0],
    ]);
  });
});

describe('いまの問題に、問題の記載に書かれた値と薬（段3c）', () => {
  test('記載の範囲に書かれた名前の、この受診でいちばん新しい値と、薬の最後の記載', () => {
    const s = patientState(
      base({
        mentions: [mention({ sourceId: 's1', start: 0, end: 7 })],
        segments: [
          { sourceId: 's1', label: 'problem_heading', start: 0, end: 10 },
          { sourceId: 's1', label: 'objective', start: 10, end: 30 },
          { sourceId: 's1', label: 'plan', start: 30, end: 50 },
          { sourceId: 's1', label: 'other', start: 50, end: 70 },
        ],
        observations: [
          { id: 'o1', sourceId: 's1', at: '2026-11-20T09:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', valueText: '6.8', unit: null, start: 12, end: 20 },
          { id: 'o2', sourceId: 's0', at: '2026-11-21T06:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', valueText: '2.1', unit: null, start: 0, end: 5 },
          { id: 'o3', sourceId: 's1', at: '2026-11-20T09:00', name: 'Na', nameRaw: 'Na', kind: 'lab', valueText: '135', unit: null, start: 55, end: 60 },
        ],
        medications: [
          { id: 'd1', sourceId: 's1', name: 'セフトリアキソン', doseText: '2g', action: 'continue', at: '2026-11-20T09:00', start: 32, end: 40 },
          { id: 'd2', sourceId: 's0', name: 'アセトアミノフェン', doseText: null, action: 'start', at: '2026-11-17T23:00', start: 0, end: 5 },
        ],
      }),
    );
    const c = s.current[0];
    expect(c?.values.map((v) => [v.name, v.valueText])).toEqual([['CRP', '2.1']]);
    expect(c?.medications.map((m) => [m.name, m.action])).toEqual([['セフトリアキソン', 'continue']]);
  });
});

describe('記載全体の P（問題に分けて書かれていない P）', () => {
  test('最後の問題の A・P にせず、いまに別に出す（いちばん新しい記載のもの）', () => {
    const s = patientState(
      base({
        mentions: [mention({ threadId: 'T1', name: '#1 ショック', start: 6, end: 12 }), mention({ threadId: 'T2', name: '#2 急性腎障害', start: 31, end: 38 })],
        segments: [
          { sourceId: 's1', label: 'assessment', start: 0, end: 5 },
          { sourceId: 's1', label: 'problem_heading', start: 5, end: 30 },
          { sourceId: 's1', label: 'problem_heading', start: 30, end: 50 },
          { sourceId: 's1', label: 'plan', start: 50, end: 80 },
        ],
      }),
    );
    expect(s.sharedPlan?.sourceId).toBe('s1');
    expect(s.sharedPlan?.parts.map((p) => [p.label, p.start])).toEqual([['plan', 50]]);
    expect(s.current.find((c) => c.thread.name === '#2 急性腎障害')?.notes.map((x) => x.label)).toEqual(['problem_heading']);
  });

  test('問題ごとに P が書かれていれば、記載全体の P はない', () => {
    const s = patientState(
      base({
        mentions: [mention({ start: 0, end: 5 })],
        segments: [
          { sourceId: 's1', label: 'problem_heading', start: 0, end: 10 },
          { sourceId: 's1', label: 'plan', start: 10, end: 20 },
        ],
      }),
    );
    expect(s.sharedPlan).toBeNull();
  });
});

describe('1日の濃い記録でも読めるように', () => {
  test('1行の要約の問題は5つまで。残りは「ほか N」', () => {
    const line = oneLinerOf({ patient: { age: 62, ageOn: '2026-11-21', sex: 'male' }, encounter: { kind: 'er', start: '2026-11-21T10:35', end: null }, today: '2026-11-21', asOf: null, problems: ['#1', '#2', '#3', '#4', '#5', '#6', '#7'] });
    expect(line).toBe('62歳 男性。救急 2026-11-21。いまの問題：#1、#2、#3、#4、#5 ほか 2。');
  });

  test('24時間の一覧を種類ごとに分け、検査値は項目ごとの最新と件数にする（中身は変えない）', () => {
    const items: RecentItem[] = [
      { type: 'lab', at: '2026-11-21T17:00', name: 'Cr', valueText: '7.68', unit: null },
      { type: 'event', at: '2026-11-21T13:05', kind: 'procedure', title: 'CV 挿入' },
      { type: 'medication', at: '2026-11-21T11:10', name: 'NE', action: 'start', doseText: null },
      { type: 'lab', at: '2026-11-21T10:50', name: 'Cr', valueText: '7.12', unit: null },
      { type: 'lab', at: '2026-11-21T10:48', name: 'pH', valueText: '7.31', unit: null },
      { type: 'problem_new', at: '2026-11-21T10:50', name: '#1 ショック', threadId: 'T1' },
    ];
    const g = recentGroups(items);
    expect(g.problems.map((i) => i.type)).toEqual(['problem_new']);
    expect(g.medications).toHaveLength(1);
    expect(g.events).toHaveLength(1);
    expect(g.labs.map((l) => [l.name, l.latest.valueText, l.count])).toEqual([
      ['Cr', '7.68', 2],
      ['pH', '7.31', 1],
    ]);
    expect(g.repeatedLabs.map((l) => l.name)).toEqual(['Cr']);
    expect(g.singleLabs.map((l) => l.name)).toEqual(['pH']);
  });

  test('はじめての記載に既往（非活動）と書かれた病名は、24時間の一覧に「はじめて書かれた」を出さず、状態の1行だけ', () => {
    const s = patientState(base({ mentions: [mention({ threadId: 'T1', name: '高血圧', activity: 'inactive', at: '2026-11-20T09:00' })] }));
    expect(s.recent?.items.filter((i) => i.type === 'problem_new' || i.type === 'problem_activity').map((i) => i.type)).toEqual(['problem_activity']);
  });
});
