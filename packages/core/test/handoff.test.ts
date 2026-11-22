// 段K7：申し送り（CA-067）。架空症例（synthetic）だけ。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  checkDocument,
  DOC_SECTIONS,
  DOC_TYPES_FOR,
  DocumentNew,
  documentMaterial,
  HANDOFF_SEVERITIES,
  HANDOFF_SEVERITY_NAMES,
  handoffContext,
  HandoffNew,
  HandoffPatch,
  latestHandoff,
  type PendingItem,
  patientState,
  sectionsFit,
  threadViews,
} from '../src/index.ts';

const ADM = '#1 市中肺炎\nA) 右下葉の肺炎\nP) 抗菌薬を開始。SpO2 が下がれば当直へ連絡';
const D2 = '#1 市中肺炎\nS) 咳は軽減\nA) 反応あり\nP) 継続。喀痰培養の結果を確認';

const segs = (sourceId: string, text: string, labels: [string, string][]) =>
  labels.map(([label, start], i) => {
    const next = labels[i + 1];
    return { sourceId, label: label as never, start: text.indexOf(start), end: next === undefined ? text.length : text.indexOf(next[1]) };
  });

const sources = [
  { id: 's1', encounterId: 'e1', kind: 'admission_note' as const, authorRole: 'self' as const, at: '2026-11-17T23:00', enteredAt: '2026-11-17T23:10', text: ADM },
  { id: 's2', encounterId: 'e1', kind: 'progress_note' as const, authorRole: 'self' as const, at: '2026-11-18T09:00', enteredAt: '2026-11-18T09:10', text: D2 },
];
const segments = [
  ...segs('s1', ADM, [
    ['problem_heading', '#1'],
    ['assessment', 'A)'],
    ['plan', 'P)'],
  ]),
  ...segs('s2', D2, [
    ['problem_heading', '#1'],
    ['subjective', 'S)'],
    ['assessment', 'A)'],
    ['plan', 'P)'],
  ]),
];
const mentions = [
  { id: 'a', sourceId: 's1', threadId: 'TA', name: '#1 市中肺炎', status: 'problem' as const, activity: null, at: '2026-11-17T23:00', start: 0, end: 7 },
  { id: 'b', sourceId: 's2', threadId: 'TA', name: '#1 市中肺炎', status: 'problem' as const, activity: null, at: '2026-11-18T09:00', start: 0, end: 7 },
];
const encounter = { id: 'e1', kind: 'inpatient' as const, start: '2026-11-17T22:00', end: null };
const patient = { age: 72, ageOn: '2026-11-17', sex: 'male' as const };

const state = patientState({
  patient,
  encounter,
  today: '2026-11-18',
  sources,
  segments,
  threads: [{ id: 'TA', displayName: null, mergedInto: null }],
  mentions,
  medications: [{ id: 'm1', sourceId: 's1', name: 'セフトリアキソン', doseText: '2g', action: 'start', at: '2026-11-17T23:00', start: 0, end: 1 }],
  events: [{ id: 'v1', sourceId: 's1', kind: 'procedure', title: '末梢ライン確保', at: '2026-11-17T23:05', start: 0, end: 1 }],
  observations: [],
});

const pending = (over: Partial<PendingItem>): PendingItem => ({ key: 'event:s2:0', kind: 'event', sourceId: 's2', start: 0, end: 1, name: '喀痰培養', at: '2026-11-18T09:00', atApprox: null, state: 'pending', results: [], mark: 'none', ...over });

describe('申し送りの種類と見出し', () => {
  test('入院と救急で出せる。AI が書く見出しは P・A・S の3つだけ（重症度・受け手の確認は入らない）', () => {
    expect(DOC_TYPES_FOR.inpatient).toContain('handoff');
    expect(DOC_TYPES_FOR.er).toContain('handoff');
    expect(DOC_TYPES_FOR.outpatient).not.toContain('handoff');
    expect(DOC_SECTIONS.handoff.map((x) => x.heading)).toEqual(['患者の要約', 'やること', '起こりうることと対応']);
    expect(DOC_SECTIONS.handoff.some((x) => /重症度|severity/u.test(x.key + x.heading))).toBe(false);
  });
  test('重症度の名前は I-PASS の3つ（安定・要注意・不安定）', () => {
    expect(HANDOFF_SEVERITIES.map((s) => HANDOFF_SEVERITY_NAMES[s])).toEqual(['安定', '要注意', '不安定']);
  });
});

describe('申し送りの資料（handoffContext）', () => {
  test('1行の要約・問題ごとの最後の A/P（記録の字）・結果待ち・デバイスと薬の日数を、決定論で行にする', () => {
    const h = handoffContext(state, (id) => sources.find((s) => s.id === id)?.text ?? null, [pending({}), pending({ key: 'x', name: '確かめた検査', mark: 'checked' }), pending({ key: 'y', name: '結果あり', state: 'resulted' })]);
    expect(h.oneLiner).toBe(state.oneLiner);
    expect(h.problems).toHaveLength(1);
    expect(h.problems[0]?.note).toContain('喀痰培養の結果を確認');
    expect(h.problems[0]?.note).not.toContain('右下葉');
    expect(h.pending).toEqual(['2026-11-18 09:00 喀痰培養（結果の記載なし・提出から 1 日目）']);
    expect(h.devices.join()).toContain('末梢');
    expect(h.medications.join()).toContain('セフトリアキソン 2g');
    expect(h.medications.join()).toContain('開始から 2 日目');
  });
  test('資料に入る（申し送りのときだけ）。その日より後の記録があれば、いまの状態は渡さない', () => {
    const h = handoffContext(state, (id) => sources.find((s) => s.id === id)?.text ?? null, []);
    const base = {
      patient,
      encounter,
      encounters: [encounter],
      sources: sources.map((s) => ({ id: s.id, encounterId: s.encounterId, kind: s.kind, authorRole: s.authorRole, at: s.at, text: s.text })),
      segments,
      threads: threadViews([{ id: 'TA', displayName: null, mergedInto: null }], mentions).threads,
      observations: [],
      medications: [],
      events: [],
      apNotes: [],
      handoff: h,
    };
    const m = documentMaterial({ ...base, type: 'handoff', day: '2026-11-18' });
    expect(m.payload['handoff']).toEqual(h);
    expect(m.backing.body).toContain('2');
    expect(documentMaterial({ ...base, type: 'progress', day: '2026-11-18' }).payload['handoff']).toBeUndefined();
    expect(documentMaterial({ ...base, type: 'handoff', day: '2026-11-17' }).payload['handoff']).toBeNull();
  });
});

describe('重症度は AI から来ない', () => {
  const material = documentMaterial({
    type: 'handoff',
    day: '2026-11-18',
    patient,
    encounter,
    encounters: [encounter],
    sources: sources.map((s) => ({ id: s.id, encounterId: s.encounterId, kind: s.kind, authorRole: s.authorRole, at: s.at, text: s.text })),
    segments,
    threads: [],
    observations: [],
    medications: [],
    events: [],
    apNotes: [],
  });
  test('AI が重症度の見出しを返しても出さない。本文の「重症度：…」の行も出さずに数える', () => {
    const checked = checkDocument(
      {
        sections: [
          { key: 'severity', text: '不安定', refs: [] },
          { key: 'summary', text: '重症度：不安定\n#1 市中肺炎 反応あり\n・I（Illness severity）: watcher', refs: [] },
          { key: 'actions', text: '喀痰培養の結果を確認', refs: [] },
        ],
      },
      material,
      [],
    );
    expect(checked.sections.map((x) => x.key)).toEqual(['summary', 'actions', 'contingency']);
    expect(checked.sections[0]?.text).toBe('#1 市中肺炎 反応あり');
    expect(checked.notes.severityLines).toBe(2);
    expect(checked.notes.unknownSections).toBe(1);
  });
  test('性質：どんな答えでも、整えた記載に重症度の見出しはない', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ key: fc.constantFrom('severity', 'summary', 'actions', 'contingency', 'i'), text: fc.constantFrom('重症度：安定', '要注意', '確認', ''), refs: fc.constant([] as string[]) }), { maxLength: 6 }), (secs) => {
        const checked = checkDocument({ sections: secs }, material, []);
        expect(checked.sections.map((x) => x.key)).toEqual(['summary', 'actions', 'contingency']);
        for (const x of checked.sections) expect(x.text).not.toMatch(/^重症度/mu);
      }),
    );
  });
  test('残すときの重症度は、先生が選んだ3つのどれか（既定なし・空なし）。カルテ記載（documents）には残せない', () => {
    const sections = [{ key: 'summary', text: 'a', refs: [] }];
    expect(HandoffNew.safeParse({ day: '2026-11-18', severity: 'watcher', sections, origin: 'ai', edited: false }).success).toBe(true);
    expect(HandoffNew.safeParse({ day: '2026-11-18', sections, origin: 'ai', edited: false }).success).toBe(false);
    expect(HandoffNew.safeParse({ day: '2026-11-18', severity: '', sections, origin: 'ai', edited: false }).success).toBe(false);
    expect(HandoffNew.safeParse({ day: '2026-11-18', severity: null, sections, origin: 'ai', edited: false }).success).toBe(false);
    expect(HandoffPatch.safeParse({ severity: 'critical', sections }).success).toBe(false);
    expect(DocumentNew.safeParse({ type: 'handoff', day: '2026-11-18', sections, origin: 'ai', edited: false }).success).toBe(false);
    expect(sectionsFit('handoff', [{ key: 'severity', text: '安定' }])).toBe(false);
    expect(sectionsFit('handoff', [{ key: 'summary', text: 'a' }])).toBe(true);
  });
  test('いちばん新しい申し送り：日 → 直した日時 → id', () => {
    const h = (id: string, day: string, updatedAt: string) => ({ id, day, updatedAt });
    expect(latestHandoff([h('a', '2026-11-18', '2026-11-18T20:00'), h('b', '2026-11-19', '2026-11-19T08:00'), h('c', '2026-11-19', '2026-11-19T07:00')])?.id).toBe('b');
    expect(latestHandoff([])).toBeNull();
  });
});
