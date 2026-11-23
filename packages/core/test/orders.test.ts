// 段K11：指示簿（CA-074〜CA-079）。流量の計算（単位・体重・濃度・合わない単位は計算しない）・写す答えの確かめ（引用が字にあること）・
// 案の確かめ（※・テンプレの流量・根拠・同じ案）・項目の操作・経過表のボードへの映し・結果待ちの候補。文はすべて架空（synthetic）。
// テンプレの数は試験用の仮の数で、臨床の数ではない。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  checkPending,
  checkPropose,
  checkTranscribe,
  doseParts,
  editOrderItem,
  infusionRate,
  itemsByCategory,
  newOrderItem,
  type OrderItem,
  type OrderNew,
  orderFieldsProblem,
  orderNumbersIn,
  orderPendingCandidates,
  pendingBasis,
  pendingMaterial,
  plannedInfusions,
  plannedTests,
  proposeMaterial,
  type ProposeAnswer,
  SCALE_AMOUNT_UNITS,
  SCALE_DOSE_UNITS,
  type ScaleTemplateBody,
  scaleRates,
  setOrderScale,
  setOrderStatus,
  type SupportMaterial,
  templateProblem,
  type TranscribeAnswer,
  unseenMarks,
  unseenNumbers,
  verbatimFields,
} from '../src/index.ts';

const TEMPLATE: ScaleTemplateBody = {
  name: '試験用スケール',
  drug: '架空の薬B',
  amount: 2,
  amountUnit: 'mg',
  volume: 50,
  doseUnit: 'μg/kg/min',
  steps: [
    { label: '段1', dose: 0.05, note: '' },
    { label: '段2', dose: 0.1, note: '' },
    { label: '医師コール', dose: null, note: '試験用' },
  ],
  note: '',
};

describe('流量の計算（CA-075）', () => {
  test('表の単位は、すべて量・体重あたり・時間に分けられる', () => {
    for (const u of SCALE_DOSE_UNITS) expect(() => doseParts(u)).not.toThrow();
  });

  test('μg/kg/min：量 × 体重 × 60 ÷ 濃度（投与量の単位にそろえる）。式を出す', () => {
    const r = infusionRate({ dose: 0.05, doseUnit: 'μg/kg/min', weightKg: 60, amount: 2, amountUnit: 'mg', volume: 50 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 2 mg / 50 mL = 40 μg/mL。0.05 × 60 × 60 ÷ 40 = 4.5
    expect(r.mlPerHour).toBeCloseTo(4.5, 10);
    expect(r.shown).toBe(4.5);
    expect(r.rounded).toBe(false);
    expect(r.formula).toEqual(['濃度：2 mg ÷ 50 mL = 0.04 mg/mL（= 40 μg/mL）', '流量：0.05 μg/kg/min × 60 kg × 60 min/h ÷ 40 μg/mL = 4.5 mL/h']);
  });

  test('μg/min（体重なし）・単位/h・mL/h', () => {
    const a = infusionRate({ dose: 2, doseUnit: 'μg/min', weightKg: null, amount: 1, amountUnit: 'mg', volume: 100 });
    expect(a.ok && a.mlPerHour).toBeCloseTo(12, 10);
    const b = infusionRate({ dose: 2, doseUnit: '単位/h', weightKg: null, amount: 50, amountUnit: '単位', volume: 50 });
    expect(b.ok && b.mlPerHour).toBeCloseTo(2, 10);
    const c = infusionRate({ dose: 20, doseUnit: 'mL/h', weightKg: null, amount: null, amountUnit: 'mg', volume: null });
    expect(c.ok && c.mlPerHour).toBe(20);
  });

  test('丸めは画面だけ（小数第2位まで）。丸めたと式に書く', () => {
    const r = infusionRate({ dose: 0.05, doseUnit: 'μg/kg/min', weightKg: 60, amount: 7, amountUnit: 'mg', volume: 50 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 0.05 × 60 × 60 ÷ 140 = 1.2857…
    expect(r.shown).toBe(1.29);
    expect(r.rounded).toBe(true);
    expect(r.formula.at(-1)).toContain('四捨五入');
  });

  test('計算しない：単位が合わない（換算を推し量らない）・体重がない・濃度がない・量がない', () => {
    expect(infusionRate({ dose: 2, doseUnit: '単位/h', weightKg: null, amount: 2, amountUnit: 'mg', volume: 50 })).toEqual({ ok: false, problem: 'unit_mismatch' });
    expect(infusionRate({ dose: 2, doseUnit: 'mEq/h', weightKg: null, amount: 2, amountUnit: 'mmol', volume: 50 })).toEqual({ ok: false, problem: 'unit_mismatch' });
    expect(infusionRate({ dose: 0.05, doseUnit: 'μg/kg/min', weightKg: null, amount: 2, amountUnit: 'mg', volume: 50 })).toEqual({ ok: false, problem: 'no_weight' });
    expect(infusionRate({ dose: 0.05, doseUnit: 'μg/kg/min', weightKg: 0, amount: 2, amountUnit: 'mg', volume: 50 })).toEqual({ ok: false, problem: 'no_weight' });
    expect(infusionRate({ dose: 0.05, doseUnit: 'μg/min', weightKg: null, amount: null, amountUnit: 'mg', volume: 50 })).toEqual({ ok: false, problem: 'no_concentration' });
    expect(infusionRate({ dose: null, doseUnit: 'μg/min', weightKg: null, amount: 2, amountUnit: 'mg', volume: 50 })).toEqual({ ok: false, problem: 'no_dose' });
  });

  test('性質：同じ次元の単位なら、量を書き換えても流量は同じ（mg と μg は 1000 倍）。体重・量に比例する', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.001, max: 100, noNaN: true }), fc.double({ min: 1, max: 200, noNaN: true }), fc.double({ min: 0.1, max: 100, noNaN: true }), fc.double({ min: 1, max: 500, noNaN: true }), (dose, kg, amount, volume) => {
        const mg = infusionRate({ dose, doseUnit: 'μg/kg/min', weightKg: kg, amount, amountUnit: 'mg', volume });
        const ug = infusionRate({ dose, doseUnit: 'μg/kg/min', weightKg: kg, amount: amount * 1000, amountUnit: 'μg', volume });
        const twice = infusionRate({ dose: dose * 2, doseUnit: 'μg/kg/min', weightKg: kg, amount, amountUnit: 'mg', volume });
        const heavier = infusionRate({ dose, doseUnit: 'μg/kg/min', weightKg: kg * 2, amount, amountUnit: 'mg', volume });
        if (!mg.ok || !ug.ok || !twice.ok || !heavier.ok) return false;
        const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
        return close(mg.mlPerHour, ug.mlPerHour) && close(twice.mlPerHour, mg.mlPerHour * 2) && close(heavier.mlPerHour, mg.mlPerHour * 2) && mg.mlPerHour > 0;
      }),
    );
  });

  test('性質：違う次元（質量・単位・mEq・mmol）の組は、いつも計算しない', () => {
    const dim = (u: string): string => (u === 'μg' || u === 'mg' || u === 'g' ? 'mass' : u);
    fc.assert(
      fc.property(fc.constantFrom(...SCALE_DOSE_UNITS.filter((u) => u !== 'mL/h')), fc.constantFrom(...SCALE_AMOUNT_UNITS), (doseUnit, amountUnit) => {
        const r = infusionRate({ dose: 1, doseUnit, weightKg: 50, amount: 10, amountUnit, volume: 50 });
        return dim(doseParts(doseUnit).mass) === dim(amountUnit) ? r.ok : !r.ok && r.problem === 'unit_mismatch';
      }),
    );
  });

  test('テンプレの段ごとの流量（量のない段は計算しない）', () => {
    const rates = scaleRates(TEMPLATE, 60);
    expect(rates.map((r) => (r.rate.ok ? r.rate.shown : r.rate.problem))).toEqual([4.5, 9, 'no_dose']);
    expect(scaleRates(TEMPLATE, null).every((r) => !r.rate.ok)).toBe(true);
  });

  test('テンプレの字に識別情報の形があれば断る', () => {
    expect(templateProblem(TEMPLATE)).toBeNull();
    expect(templateProblem({ ...TEMPLATE, note: ['090', '1234', '5678'].join('-') })).toBe('shape');
  });
});

const SRC = { id: 'src1', kind: 'progress_note' as const, at: '2026-11-20T11:00', text: '【架空】\nNPPV IPAP 10 / EPAP 5 で継続。\n不穏時 頓用薬Aを1回投与。\nNPPV IPAP 10 / EPAP 5 で継続。' };
const blank = { condition: '', drug: '', dose: '', rate: '', interval: '', duration: '', action: 'none' as const };

describe('写す答えの確かめ（CA-074）', () => {
  test('引用は記録の字にあるものだけ。項目の字は記録の字そのもの。欄は引用の中の字だけ。同じ字が2か所なら次の場所', () => {
    const answer: TranscribeAnswer = {
      items: [
        { category: 'respiratory', quote: ' NPPV IPAP 10 / EPAP 5 で継続。 ', ...blank },
        { category: 'prn', quote: '不穏時 頓用薬Aを1回投与。', ...blank, condition: '不穏時', dose: '1回', rate: '5 mL/h' },
        { category: 'respiratory', quote: 'NPPV IPAP 10 / EPAP 5 で継続。', ...blank },
        { category: 'respiratory', quote: 'NPPV IPAP 10 / EPAP 5 で継続。', ...blank },
        { category: 'call', quote: 'ない字', ...blank },
        { category: 'not_an_order', quote: '【架空】', ...blank },
        { category: 'diet', quote: '   ', ...blank },
      ],
    };
    const r = checkTranscribe(answer, SRC);
    expect(r.proposals.map((p) => [p.category, p.from?.start, SRC.text.slice(p.from?.start ?? 0, p.from?.end ?? 0) === p.text])).toEqual([
      ['respiratory', 5, true],
      ['prn', 32, true],
      ['respiratory', 47, true],
    ]);
    expect(r.proposals[1]).toMatchObject({ condition: '不穏時', dose: '1回', rate: '' });
    expect(r.cleared).toBe(1);
    expect(r.notOrder).toBe(1);
    expect(r.rejected).toEqual({ duplicate: 1, quote_not_found: 1, empty: 1 });
    expect(r.proposals.every((p) => p.origin === 'transcribed' && p.basis.length === 0 && p.unseen.length === 0)).toBe(true);
  });

  test('性質：出した項目の字は、いつも記録の字のその場所と同じ', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ start: fc.nat(SRC.text.length), len: fc.integer({ min: 0, max: 40 }) }), { maxLength: 8 }), fc.string({ maxLength: 6 }), (spans, noise) => {
        const answer: TranscribeAnswer = { items: spans.map((s) => ({ category: 'other', quote: SRC.text.slice(s.start, s.start + s.len) + noise, ...blank })) };
        return checkTranscribe(answer, SRC).proposals.every((p) => p.from !== null && SRC.text.slice(p.from.start, p.from.end) === p.text && p.text.trim() === p.text);
      }),
    );
  });
});

const support = (over: Partial<SupportMaterial> = {}): SupportMaterial => ({
  payload: { problems: [{ ref: 'P1', name: '架空の肺炎' }] },
  targets: new Map(),
  listed: new Set(['P1']),
  refs: new Map([['V1', '値 CRP 12']]),
  backing: { body: ['12', '75'], when: [] },
  points: [],
  dropped: { course: 0, values: 0 },
  problemNames: [],
  ...over,
});
const tpl = { id: 'tpl1', body: TEMPLATE, createdAt: '2026-11-20T10:00', updatedAt: '2026-11-20T10:00' };
const item = (over: Partial<OrderItem> = {}): OrderItem => ({
  ...newOrderItem('o1', { category: 'diet', text: '絶食', ...blank, start: null, end: null, scale: null, origin: 'self', from: null, basis: [], unseen: [] }, '2026-11-20T10:00'),
  ...over,
});

describe('案の確かめ（CA-076）', () => {
  test('用量を含めてよい。資料・テンプレにない数は※（unseen）。テンプレを指した案の流量は空にする。根拠のない案・同じ案・頼んでいない欄は出さない。識別情報の形は伏せる', () => {
    const material = proposeMaterial({ support: support(), findings: null, templates: [tpl], orders: [item()], categories: ['oral', 'infusion', 'diet', 'call'] });
    const answer: ProposeAnswer = {
      items: [
        { category: 'oral', text: '架空の薬C 1回 7 mg（CRP 12 を見て）', ...blank, dose: '1回 7 mg', template: '', basis: ['P1', 'V1', 'Z9'] },
        { category: 'infusion', text: '架空の薬B 段1から（0.05 μg/kg/min）', ...blank, rate: '4.5 mL/h', template: 'X1', basis: ['X1'] },
        { category: 'diet', text: '絶食', ...blank, template: '', basis: ['P1'] },
        { category: 'call', text: `連絡先 ${['090', '1234', '5678'].join('-')}`, ...blank, template: '', basis: ['P1'] },
        { category: 'rest', text: 'ベッド上安静', ...blank, template: '', basis: ['P1'] },
        { category: 'oral', text: '根拠なし', ...blank, template: '', basis: [] },
        { category: 'oral', text: 'テンプレの欄違い', ...blank, template: 'X1', basis: ['P1'] },
      ],
    };
    const r = checkPropose(answer, material);
    expect(r.proposals.map((p) => p.text)).toEqual(['架空の薬C 1回 7 mg（CRP 12 を見て）', '架空の薬B 段1から（0.05 μg/kg/min）', '連絡先 〔電話番号〕', 'テンプレの欄違い']);
    // 「1」はテンプレの段の名前（段1）にある。7 だけが資料にない
    expect(r.proposals[0]?.unseen).toEqual(['7']);
    expect(r.proposals[0]?.basis.map((b) => b.id)).toEqual(['P1', 'V1']);
    expect(r.proposals[0]?.basis[0]?.label).toContain('架空の肺炎');
    // テンプレの数（0.05）は資料にある
    expect(r.proposals[1]).toMatchObject({ rate: '', unseen: [], scale: { templateId: 'tpl1', weightKg: null, step: null } });
    expect(r.proposals[3]?.scale).toBeNull();
    expect(r.shapes).toBe(1);
    expect(r.rejected).toEqual({ unknown_ref: 1, rate_dropped: 1, duplicate: 1, category: 1, ungrounded: 1, template_category: 1 });
    expect(r.proposals.every((p) => p.origin === 'ai')).toBe(true);
  });

  test('※の場所：保存した unseen と同じ数の場所だけ（全角の数も）', () => {
    expect(unseenNumbers('1回 7 mg、CRP 12', { body: ['12'], when: [] })).toEqual(['1', '7']);
    expect(unseenMarks('1回 ７ mg', ['7'])).toEqual([{ start: 3, end: 4 }]);
    expect(unseenMarks('7 mg', [])).toEqual([]);
  });
});

describe('項目の操作', () => {
  test('写した字そのままの欄（選別を通さない欄）', () => {
    const v = verbatimFields({ text: '不穏時 頓用薬A', condition: '不穏時', drug: '頓用薬B', dose: '', rate: '', interval: '', duration: '' }, '不穏時 頓用薬Aを1回投与。');
    expect([...v].sort()).toEqual(['condition', 'dose', 'duration', 'interval', 'rate', 'text']);
    expect(verbatimFields({ text: 'x', condition: '', drug: '', dose: '', rate: '', interval: '', duration: '' }, null).size).toBe(0);
  });

  test('中止・再開・直す（AI の※は、直した後の字に残る数だけ）・スケールの段は段の数の中', () => {
    const a = item({ origin: 'ai', text: '1回 7 mg', unseen: ['7', '1'] });
    const stopped = setOrderStatus(a, 'stopped', '2026-11-21T09:00');
    expect(stopped).toMatchObject({ status: 'stopped', stoppedAt: '2026-11-21T09:00' });
    expect(setOrderStatus(stopped, 'active', '2026-11-21T10:00')).toMatchObject({ status: 'active', stoppedAt: null });
    expect(setOrderStatus(a, 'active', 'x')).toBe(a);
    const edited = editOrderItem(a, { category: 'diet', text: '1回 5 mg', ...blank, start: null, end: null, scale: null }, '2026-11-21T09:00', orderNumbersIn);
    expect(edited).toMatchObject({ edited: true, unseen: ['1'] });
    expect(edited.history.map((h) => h.action)).toEqual(['add', 'edit']);
    expect(setOrderScale(a, 60, 0, 'x')).toBeNull();
    const s = item({ category: 'infusion', scale: { templateId: 't', template: TEMPLATE, weightKg: null, step: null } });
    expect(setOrderScale(s, 60, 2, 'x')?.scale).toMatchObject({ weightKg: 60, step: 2 });
    expect(setOrderScale(s, 60, 3, 'x')).toBeNull();
    expect(orderFieldsProblem({ category: 'diet', text: 'x', ...blank, start: '2026-11-21', end: '2026-11-20T10:00', scale: null })).toBe('end_before_start');
  });

  test('欄ごとの並び（中止したものは後ろ）', () => {
    const groups = itemsByCategory([item({ id: 'a', category: 'oral', status: 'stopped' }), item({ id: 'b', category: 'oral' }), item({ id: 'c', category: 'rest' })]);
    expect(groups.map((g) => [g.category, g.items.map((i) => i.id)])).toEqual([
      ['rest', ['c']],
      ['oral', ['b', 'a']],
    ]);
  });
});

describe('ボードと結果待ち（CA-078）', () => {
  const infusion = (over: Partial<OrderItem>) => item({ category: 'infusion', drug: '架空の輸液', text: '架空の輸液 持続', dose: '500 mL', rate: '40 mL/h', ...over });
  test('点滴の予定の帯：開始があるものだけ。終わりは予定の終わりか中止の早いほう。どちらもなければ null（破線）', () => {
    const bars = plannedInfusions([
      infusion({ id: 'i1', start: '2026-11-20T10:00', end: '2026-11-22T10:00' }),
      infusion({ id: 'i2', start: '2026-11-20T12:00', end: '2026-11-25T10:00', status: 'stopped', stoppedAt: '2026-11-21T08:00' }),
      infusion({ id: 'i3', start: '2026-11-21T09:00' }),
      infusion({ id: 'i4' }),
      item({ id: 'd1', start: '2026-11-20T10:00' }),
    ]);
    expect(bars.map((b) => [b.id, b.from, b.to, b.stopped])).toEqual([
      ['i1', '2026-11-20T10:00', '2026-11-22T10:00', false],
      ['i2', '2026-11-20T12:00', '2026-11-21T08:00', true],
      ['i3', '2026-11-21T09:00', null, false],
    ]);
    expect(bars[0]?.detail).toBe('500 mL 40 mL/h');
    const scaled = plannedInfusions([infusion({ id: 's', start: '2026-11-20T10:00', rate: '', dose: '', scale: { templateId: 't', template: TEMPLATE, weightKg: 60, step: 0 } })]);
    expect(scaled[0]?.detail).toBe('スケール「試験用スケール」 段1（4.5 mL/h・carte の計算）');
  });

  test('検査の予定の印と、結果待ちの候補（予定の日時、なければ写した記載の日時）', () => {
    const tests = [item({ id: 't1', category: 'test', text: '明朝 採血', start: '2026-11-21T06:00', interval: '毎朝' }), item({ id: 't2', category: 'test', text: '血液ガス', from: { sourceId: 's9', start: 0, end: 3 } }), item({ id: 'x', category: 'diet' })];
    expect(plannedTests(tests).map((t) => [t.id, t.at, t.interval])).toEqual([['t1', '2026-11-21T06:00', '毎朝']]);
    const c = orderPendingCandidates([{ encounterId: 'e1', items: tests }], (id) => (id === 's9' ? '2026-11-20T11:00' : null));
    expect(c.map((o) => [o.id, o.at])).toEqual([
      ['t1', '2026-11-21T06:00'],
      ['t2', '2026-11-20T11:00'],
    ]);
    // 候補がなければ、結果待ちの印は前の版と同じ
    expect(pendingBasis([])).toBe('0:0:');
    expect(pendingBasis([], c)).toContain('|o:t1@');
  });

  test('結果待ちの1回で、指示簿の候補 O… に結果を結びつける（予定より前の結果・資料にない記号は入れない。答えのない候補は振り分けられなかった）', () => {
    const encounters = [{ id: 'e1', kind: 'inpatient' as const, start: '2026-11-20T10:00', end: null }];
    const material = pendingMaterial({
      encounters,
      sources: [{ id: 's1', encounterId: 'e1', kind: 'lab', at: '2026-11-21T09:00', text: 'WBC 9800' }],
      events: [],
      course: [],
      observations: [
        { sourceId: 's1', encounterId: 'e1', name: 'WBC', nameRaw: 'WBC', kind: 'lab', valueText: '9800', unit: null, at: '2026-11-21T09:00', start: 0, end: 8 },
        { sourceId: 's1', encounterId: 'e1', name: 'Hb', nameRaw: 'Hb', kind: 'lab', valueText: '12', unit: null, at: '2026-11-19T09:00', start: 0, end: 8 },
      ],
      orders: [
        { id: 't1', encounterId: 'e1', name: '明朝 採血', interval: '', at: '2026-11-21T06:00', stamp: 'x' },
        { id: 't2', encounterId: 'e1', name: '血液ガス', interval: '', at: null, stamp: 'x' },
        { id: 'other', encounterId: 'e9', name: '別の受診', interval: '', at: null, stamp: 'x' },
      ],
    });
    expect(material.payload['orders']).toEqual([
      { ref: 'O1', name: '明朝 採血', interval: '', at: '2026-11-21 06:00' },
      { ref: 'O2', name: '血液ガス', interval: '', at: '日時不明' },
    ]);
    const v = (name: string) => [...material.items].find(([, x]) => x.label.includes(name))?.[0] ?? '';
    const checked = checkPending({ items: [{ id: 'O1', status: 'resulted', results: [v('WBC'), v('Hb'), 'V99'] }] }, material);
    expect(checked.items).toEqual([]);
    expect(checked.orders.map((o) => [o.orderId, o.state, o.results.map((r) => r.label)])).toEqual([
      ['t1', 'resulted', ['値 WBC（2026-11-21）09:00 9800']],
      ['t2', 'unsorted', []],
    ]);
    expect(checked.rejected).toEqual({ earlier_result: 1, unknown_result: 1 });
  });
});

describe('足す項目の形', () => {
  test('写した項目には元の字の場所が要る', async () => {
    const { orderNewProblem } = await import('../src/index.ts');
    const base: OrderNew = { category: 'diet', text: '絶食', ...blank, start: null, end: null, scale: null, origin: 'transcribed', from: null, basis: [], unseen: [] };
    expect(orderNewProblem(base)).toBe('transcribed_without_source');
    expect(orderNewProblem({ ...base, from: { sourceId: 's', start: 0, end: 2 } })).toBeNull();
    expect(orderNewProblem({ ...base, origin: 'self' })).toBeNull();
  });
});
