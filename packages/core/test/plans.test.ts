// 予定と実施の突き合わせ（段K9。CA-071）：予定の行の切り出し・資料の記号・確かめ（記号・候補・予定より前の実施・同じ記載・予定の日）・先生の印の引き継ぎ。
// AI の答えは試験の代役。文はすべて架空（synthetic）。
import { describe, expect, test } from 'vitest';

import {
  applyPlanMark,
  carryPlanMarks,
  checkPlans,
  hasPlanCandidates,
  type PlanAnswer,
  PlanAnswer as PlanAnswerShape,
  type PlanInput,
  planKey,
  planLines,
  planMaterial,
  PlanPatch,
  planStatus,
  splitPlanLines,
} from '../src/index.ts';

const ER = 'enc-er';
const IN = 'enc-in';
const T1 = '【救急】\nA/P: 尿路感染症疑い。\n・血液培養2セット提出済み。入院で加療。';
const T2 = '#1 腎盂腎炎\nA: 発熱は持続。\nP: 明日 胸部CT。\n抗菌薬は 3 日目に培養を見て変更を検討。\n#2 低K血症\nP) 明朝採血。';
const T3 = '【入院2日目】胸部CT 施行、肺炎像なし。\nK 3.6。';
const T4 = '【入院3日目】セフトリアキソンをセファゾリンに変更。';

const at = (text: string, part: string): { start: number; end: number } => {
  const start = text.indexOf(part);
  if (start < 0) throw new Error(part);
  return { start, end: start + part.length };
};
const seg = (sourceId: string, text: string, label: PlanInput['segments'][number]['label'], from: string, to?: string) => {
  const s = text.indexOf(from);
  const e = to === undefined ? text.length : text.indexOf(to);
  return { sourceId, label, start: s, end: e };
};

const INPUT: PlanInput = {
  encounters: [
    { id: ER, kind: 'er', start: '2026-11-19T22:00', end: '2026-11-20T08:00' },
    { id: IN, kind: 'inpatient', start: '2026-11-20T08:00', end: null },
  ],
  sources: [
    { id: 's1', encounterId: ER, kind: 'er_note', at: '2026-11-19T22:30', text: T1 },
    { id: 's2', encounterId: IN, kind: 'progress_note', at: '2026-11-20T10:00', text: T2 },
    { id: 's3', encounterId: IN, kind: 'progress_note', at: '2026-11-21T10:00', text: T3 },
    { id: 's4', encounterId: IN, kind: 'progress_note', at: '2026-11-22T10:00', text: T4 },
  ],
  segments: [
    seg('s1', T1, 'other', '【救急】', 'A/P'),
    seg('s1', T1, 'assessment_plan', 'A/P'),
    seg('s2', T2, 'problem_heading', '#1', 'A:'),
    seg('s2', T2, 'assessment', 'A:', 'P:'),
    seg('s2', T2, 'plan', 'P:', '#2'),
    seg('s2', T2, 'problem_heading', '#2', 'P)'),
    seg('s2', T2, 'plan', 'P)'),
  ],
  events: [
    { sourceId: 's1', encounterId: ER, kind: 'test', title: '血液培養2セット提出', at: '2026-11-19T22:30', ...at(T1, '血液培養2セット提出') },
    { sourceId: 's3', encounterId: IN, kind: 'test', title: '胸部CT 施行', at: '2026-11-21T10:00', ...at(T3, '胸部CT 施行') },
  ],
  medications: [{ sourceId: 's4', encounterId: IN, name: 'セファゾリン', doseText: null, action: 'change', at: '2026-11-22T10:00', ...at(T4, 'セファゾリンに変更') }],
  course: [],
  observations: [{ sourceId: 's3', encounterId: IN, name: 'K', nameRaw: 'K', comparator: null, valueText: '3.6', unit: null, at: '2026-11-21T10:00', ...at(T3, 'K 3.6') }],
};

const material = planMaterial(INPUT);
const ref = (part: string): string => {
  for (const [r, c] of material.candidates) if (c.text.includes(part)) return r;
  throw new Error(part);
};
const doneRef = (label: string): string => {
  for (const [r, d] of material.items) if (d.label.includes(label)) return r;
  throw new Error(label);
};
const none = { base: 'none', days: 0, hours: 0, minutes: 0, time: '', part: 'none', spanDays: 0 } as const;

describe('予定の行（planLines・splitPlanLines）', () => {
  test('P・A/P の区切りを、行と「。」で分ける。行の頭の印（P:・P)・・）は字に含めない。見出しの名前を添える', () => {
    const lines = planLines(INPUT);
    expect(lines.map((l) => [l.sourceId, l.text, l.problem])).toEqual([
      ['s1', '尿路感染症疑い。', ''],
      ['s1', '血液培養2セット提出済み。', ''],
      ['s1', '入院で加療。', ''],
      ['s2', '明日 胸部CT。', '#1 腎盂腎炎'],
      ['s2', '抗菌薬は 3 日目に培養を見て変更を検討。', '#1 腎盂腎炎'],
      ['s2', '明朝採血。', '#2 低K血症'],
    ]);
    // 場所は、保存した文の字そのもの
    for (const l of lines) expect(INPUT.sources.find((s) => s.id === l.sourceId)?.text.slice(l.start, l.end)).toBe(l.text);
    // 評価（A）だけの区切りは、予定の行にしない
    expect(lines.some((l) => l.text.includes('発熱は持続'))).toBe(false);
  });

  test('空の行・記号だけの行は除く', () => {
    const text = 'P:\n・\n- 。\n再検。';
    expect(splitPlanLines(text, 0, text.length).map((r) => text.slice(r.start, r.end))).toEqual(['再検。']);
  });

  test('P・A/P の区切りがなければ、候補なし（AI を呼ばない）', () => {
    expect(hasPlanCandidates({ ...INPUT, segments: INPUT.segments.filter((g) => g.label !== 'plan' && g.label !== 'assessment_plan') })).toBe(false);
    expect(hasPlanCandidates(INPUT)).toBe(true);
  });
});

describe('資料（planMaterial）', () => {
  test('予定 P…・できごと E…・薬 M…・経過の出来事 C…・記載ごとの値 V…。いちばん早い予定より前の記録は入れない', () => {
    const p = material.payload as { plans: { ref: string; text: string; problem: string }[]; events: { title: string }[]; medications: { name: string; action: string }[]; values: { values: string }[] };
    expect(p.plans.map((x) => x.ref)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    expect(p.plans[3]).toMatchObject({ text: '明日 胸部CT。', problem: '#1 腎盂腎炎' });
    expect(p.events.map((e) => e.title)).toEqual(['血液培養2セット提出', '胸部CT 施行']);
    expect(p.medications).toEqual([expect.objectContaining({ name: 'セファゾリン', action: '変更' })]);
    expect(p.values).toEqual([expect.objectContaining({ values: 'K 3.6' })]);
    expect(material.items.get(doneRef('胸部CT'))?.kind).toBe('event');
    expect(material.dropped).toEqual({ candidates: 0, done: 0 });
  });
});

describe('確かめ（checkPlans）', () => {
  const answer: PlanAnswer = {
    items: [
      { id: ref('明日 胸部CT'), kind: 'test', due: { ...none, base: 'note', days: 1 }, done: [doneRef('胸部CT')] },
      { id: ref('抗菌薬は'), kind: 'medication', due: { ...none, base: 'arrival', days: 2 }, done: [doneRef('セファゾリン'), doneRef('血液培養')] },
      { id: ref('明朝採血'), kind: 'test', due: { ...none, base: 'note', days: 1, part: 'morning' }, done: [] },
      // 予定ではない（評価・起きたこと）
      { id: ref('尿路感染症疑い'), kind: 'not_a_plan', due: none, done: [] },
      { id: ref('血液培養2セット提出済み'), kind: 'not_a_plan', due: none, done: [] },
      // 同じ記載の事実・予定より前の記録・資料にない記号・同じ予定の重なり・予定の記号でないもの
      { id: ref('入院で加療'), kind: 'other', due: { ...none, base: 'note', days: -3 }, done: [doneRef('血液培養'), 'E99'] },
      { id: ref('明日 胸部CT'), kind: 'test', due: none, done: [] },
      { id: doneRef('胸部CT'), kind: 'test', due: none, done: [] },
      { id: 'P99', kind: 'test', due: none, done: [] },
    ],
  };
  const checked = checkPlans(PlanAnswerShape.parse(answer), material);

  test('実施の記載・その後の記載に見つからない・振り分けられなかった。予定の日は、手がかりから決定論で計算する', () => {
    expect(checked.items.map((i) => [i.text, i.state, i.kind, i.due, i.dueApprox])).toEqual([
      ['入院で加療。', 'unsorted', 'other', null, null],
      ['明日 胸部CT。', 'done', 'test', '2026-11-21', null],
      ['抗菌薬は 3 日目に培養を見て変更を検討。', 'done', 'medication', '2026-11-22', null],
      ['明朝採血。', 'open', 'test', '2026-11-21T08:00', '朝ごろ'],
    ]);
    expect(checked.items[1]?.done.map((d) => d.label)).toEqual(['検査の実施「胸部CT 施行」']);
    expect(checked.items[2]?.done.map((d) => d.label)).toEqual(['薬「セファゾリン」変更']);
    expect(checked.notPlan).toBe(2);
    expect(checked.items.every((i) => i.mark === 'none')).toBe(true);
  });

  test('通らないものは理由ごとに数える', () => {
    expect(checked.rejected).toEqual({ earlier_done: 1, same_note: 1, unknown_done: 1, no_done: 1, bad_due: 1, duplicate: 1, not_candidate: 1, unknown_ref: 1 });
  });

  test('同じ記載の事実は、実施にしない。AI が振り分けなかった予定は、字を残す', () => {
    const own = checkPlans({ items: [{ id: ref('明日 胸部CT'), kind: 'test', due: none, done: [] }] }, planMaterial({ ...INPUT, events: [...INPUT.events, { sourceId: 's2', encounterId: IN, kind: 'test', title: '胸部CT', at: '2026-11-20T10:00', ...at(T2, '胸部CT') }] }));
    expect(own.items.find((i) => i.text === '明日 胸部CT。')?.state).toBe('open');
    const m2 = planMaterial({ ...INPUT, events: [...INPUT.events, { sourceId: 's2', encounterId: IN, kind: 'test', title: '胸部CT', at: '2026-11-20T10:00', ...at(T2, '胸部CT') }] });
    const selfRef = [...m2.items].find(([, d]) => d.sourceId === 's2')?.[0] ?? '';
    const r = checkPlans({ items: [{ id: ref('明日 胸部CT'), kind: 'test', due: none, done: [selfRef] }] }, m2);
    expect(r.rejected).toEqual({ same_note: 1, no_done: 1 });
    expect(r.items.filter((i) => i.state === 'unsorted')).toHaveLength(6);
  });

  test('画面の状態：予定の日を過ぎて実施の記載がないときだけ past_due（日の単位）', () => {
    const open = checked.items.find((i) => i.text === '明朝採血。');
    expect(planStatus(open ?? { state: 'open', due: null }, '2026-11-21T09:00')).toBe('open');
    expect(planStatus(open ?? { state: 'open', due: null }, '2026-11-22T10:00')).toBe('past_due');
    expect(planStatus({ state: 'open', due: null }, '2026-11-30')).toBe('open');
    expect(planStatus({ state: 'done', due: '2026-11-21' }, '2026-11-30')).toBe('done');
  });
});

describe('先生の印', () => {
  const checked = checkPlans({ items: [] }, material);
  test('鍵（文の id と字の始まり）で引き継ぐ。知らない鍵は null。打つ欄は受けない', () => {
    const key = planKey(checked.items[3] ?? { sourceId: '', start: 0, end: 0 });
    const marked = applyPlanMark(checked.items, { key, mark: 'cancelled' });
    expect(marked?.find((i) => i.key === key)?.mark).toBe('cancelled');
    expect(applyPlanMark(checked.items, { key: 'plan:none:0', mark: 'confirmed' })).toBeNull();
    expect(carryPlanMarks(checked.items, marked ?? []).find((i) => i.key === key)?.mark).toBe('cancelled');
    expect(PlanPatch.safeParse({ key, mark: 'confirmed', note: '打った字' }).success).toBe(false);
  });
});
