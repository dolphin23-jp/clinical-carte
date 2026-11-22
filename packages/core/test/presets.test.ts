// 段K4（CA-059・CA-063）：スコア・診断基準。値は架空（synthetic）。閾値・点は、取り込んだ定義（library.gen.ts）から読む（試験に閾値を直書きしない）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  carteFacts,
  CRITERIA_STATE_LABEL,
  evaluateForRecord,
  itemAnswerText,
  latestDay,
  PRESET_AREAS,
  PRESET_DEFINITIONS,
  PRESET_SOURCES,
  type PresetCondition,
  type PresetObservationRow,
  type PresetRecordInput,
  PRESETS,
  presetSources,
  presetsByArea,
  resultView,
  suggestedPresets,
} from '../src/index.ts';
import { ClinicalPresetLibraryShape } from '../src/presets/schema.ts';

let n = 0;
const row = (at: string, name: string, value: number | null, unit: string | null, kind: 'lab' | 'vital' = 'lab', extra: Partial<PresetObservationRow> = {}): PresetObservationRow => {
  n += 1;
  return { id: `o${String(n)}`, at, name, nameRaw: name, kind, value, comparator: null, valueText: value === null ? '' : String(value), unit, ...extra };
};
const base = (observations: readonly PresetObservationRow[], problems: PresetRecordInput['problems'] = []): PresetRecordInput => ({
  patient: { age: 70, ageOn: '2026-01-10', sex: 'male' },
  encounter: { kind: 'inpatient', start: '2026-11-18' },
  observations,
  problems,
});
const preset = (id: string) => {
  const p = PRESETS.get(id);
  if (p === null) throw new Error(id);
  return p;
};
/** 2択の項目の when（観察の閾値の条件） */
const obsWhen = (id: string, key: string): Extract<PresetCondition, { obs: unknown; op: unknown }> => {
  const item = preset(id).items.find((i) => i.key === key);
  if (item === undefined || 'options' in item || item.when === undefined || !('obs' in item.when)) throw new Error(`${id}.${key}`);
  return item.when;
};
/** 閾値の条件を満たす値と、満たさない値 */
const meets = (c: { op: '<' | '<=' | '>' | '>='; value: number }, yes: boolean): number => {
  const table = { '>=': [c.value, c.value - 1], '>': [c.value + 1, c.value], '<=': [c.value, c.value + 1], '<': [c.value - 1, c.value] } as const;
  return table[c.op][yes ? 0 : 1];
};

describe('取り込んだ定義（library.gen.ts）', () => {
  test('形を通り、出典がそろい、先生が確かめるまで未確認', () => {
    const lib = { schema_version: 1 as const, areas: PRESET_AREAS, sources: PRESET_SOURCES, presets: PRESET_DEFINITIONS };
    expect(ClinicalPresetLibraryShape.parse(lib)).toEqual(lib);
    expect(PRESETS.list.length).toBe(PRESET_DEFINITIONS.length);
    for (const p of PRESETS.list) {
      expect(presetSources(p).length, p.id).toBe(p.sources.length);
      expect(p.unconfirmed, p.id).toBe(!p.confirmed);
    }
    expect(presetsByArea().flatMap((g) => g.presets).length).toBe(PRESETS.list.length);
  });
});

describe('記録から事実を作る（carte-facts）', () => {
  test('性別・年齢・プロブレム', () => {
    const f = carteFacts({ ...base([], [{ name: '敗血症', source: 'ai' }, { name: ' ', source: 'problem' }]), patient: { age: 70, ageOn: '2025-11-01', sex: 'female' } }, '2026-11-20');
    expect(f.sex).toBe('女性');
    expect(f.age).toBe(71);
    expect(f.problems).toEqual([{ source: 'ai', text: '敗血症' }]);
    expect(carteFacts({ ...base([]), patient: { age: 30, ageOn: '2026-11-01', sex: 'other' } }, '2026-11-20').sex).toBeNull();
  });
  test('外した行・日時のない行・字に見つからない数は読まない。単位の書かれていない値は、書き方が1つの項目だけ', () => {
    const f = carteFacts(
      base([
        row('2026-11-20', 'Cr', 1.2, null),
        row('2026-11-20', 'Cr', 9, 'mg/dL', 'lab', { excluded: true }),
        row('2026-11-20', 'Cr', 8, 'mg/dL', 'lab', { unseen: true }),
        { ...row('2026-11-20', 'Cr', 7, 'mg/dL'), at: null },
        row('2026-11-20', 'WBC', 12, null),
        row('2026-11-20', '尿量', 300, null, 'vital'),
      ]),
      '2026-11-20',
    );
    const cr = f.labs.get('Cr') ?? [];
    expect(cr).toHaveLength(1);
    expect(cr[0]?.unit).toBe('mg/dL');
    expect(cr[0]?.points.map((p) => p.text)).toEqual(['1.2（単位の記載なし）']);
    // WBC は単位の書き方が多い（桁が読めない）ので、単位なしの系列のまま
    expect(f.labs.get('WBC')?.[0]?.unit).toBeNull();
    // 尿量は単位が要る（1回量と1日量を取り違えない）
    expect(f.labs.has('尿量')).toBe(false);
    expect(f.dailyAmounts).toHaveLength(0);
  });
  test('違う単位は別の系列（換算しない）。不等号つきは片側の区間。同じ日の観察はバイタルを先に', () => {
    const f = carteFacts(
      base([
        row('2026-11-20', 'Plt', 152, '×10^3/μL'),
        row('2026-11-20', 'Plt', 15.2, '万'),
        { ...row('2026-11-20', 'CRP', 0.1, 'mg/dL'), comparator: '<' },
        row('2026-11-20T08:00', '収縮期血圧', 140, 'mmHg', 'lab'),
        row('2026-11-20T09:00', '収縮期血圧', 90, 'mmHg', 'vital'),
        row('2026-11-21', '収縮期血圧', 2000, 'mmHg', 'vital'),
      ]),
      '2026-11-21',
    );
    expect((f.labs.get('Plt') ?? []).map((s) => s.unit).sort()).toEqual(['×10^3/μL', '万/μL']);
    expect(f.labs.get('CRP')?.[0]?.points[0]?.span).toEqual({ lo: -Infinity, loIn: false, hi: 0.1, hiIn: false });
    // 140（検査値として入れた）は、同じ日のバイタルがあるので読まない。2000 はありうる範囲の外
    expect(f.observations.map((o) => o.value)).toEqual([90]);
    expect(f.observations[0]?.when).toBe('2026-11-20 09:00・第3病日');
  });
});

describe('定義を記録で計算する', () => {
  const rr = obsWhen('qsofa', 'rr');
  const sbp = obsWhen('qsofa', 'sbp');
  const day = '2026-11-20';
  test('qSOFA：呼吸数・収縮期血圧はバイタルから、意識は手で選ぶまで未入力（3値）', () => {
    const input = base([row(`${day}T09:00`, '呼吸数', meets(rr, true), null, 'vital'), row(`${day}T09:00`, '収縮期血圧', meets(sbp, false), 'mmHg', 'vital')]);
    const r = evaluateForRecord(preset('qsofa'), input, day);
    const byKey = new Map(r.evaluation.items.map((x) => [x.key, x]));
    expect(byKey.get('rr')).toMatchObject({ state: 'yes', source: 'auto' });
    expect(byKey.get('sbp')).toMatchObject({ state: 'no', source: 'auto' });
    const mentation = byKey.get('mentation');
    expect(mentation).toMatchObject({ state: 'unknown', source: 'none', auto: null });
    if (mentation === undefined) throw new Error('mentation');
    expect(itemAnswerText(preset('qsofa').items.find((i) => i.key === 'mentation'), mentation)).toBe('未入力');
    const points = (key: string) => {
      const item = preset('qsofa').items.find((i) => i.key === key);
      return item !== undefined && !('options' in item) ? item.points : 0;
    };
    expect(r.evaluation.total).toEqual({ min: points('rr'), max: points('rr') + points('mentation') });
    // 手で選ぶと決まる（画面のメモリの答え）
    const yes = evaluateForRecord(preset('qsofa'), input, day, { mentation: 'yes' });
    expect(yes.evaluation.total).toEqual({ min: points('rr') + points('mentation'), max: points('rr') + points('mentation') });
    expect(yes.evaluation.unknownCount).toBe(0);
    expect(resultView(yes.preset, yes.evaluation).lines.some((l) => l.includes('未確認'))).toBe(true);
  });
  test('値がない項目は未入力で、あてはまらないにしない', () => {
    const r = evaluateForRecord(preset('qsofa'), base([]), day);
    for (const x of r.evaluation.items) expect(x.state).toBe('unknown');
    expect(r.evaluation.band).toBeNull();
  });
  test('Child-Pugh：検査は記録の値から、腹水・肝性脳症は手で選ぶ（合計は幅で出す）', () => {
    const p = preset('child-pugh');
    const input = base([row(day, 'T-Bil', 1.0, 'mg/dL'), row(day, 'Alb', 4.2, 'g/dL'), row(day, 'PT-INR', 1.0, null)]);
    const r = evaluateForRecord(p, input, day);
    const points = (key: string) => {
      const item = p.items.find((i) => i.key === key);
      if (item === undefined || !('options' in item)) throw new Error(key);
      return item.options.map((o) => o.points);
    };
    const auto = ['bilirubin', 'albumin', 'coagulation'].map((k) => r.evaluation.items.find((x) => x.key === k));
    for (const x of auto) expect(x?.source).toBe('auto');
    const autoSum = auto.reduce((s, x) => s + (x?.points ?? 0), 0);
    const manual = ['ascites', 'encephalopathy'];
    expect(r.evaluation.total).toEqual({
      min: autoSum + manual.reduce((s, k) => s + Math.min(...points(k)), 0),
      max: autoSum + manual.reduce((s, k) => s + Math.max(...points(k)), 0),
    });
  });
  test('KDIGO の AKI 病期：前の日の Cr と比べる（窓の中の値）', () => {
    const input = base([row('2026-11-18', 'Cr', 1.0, 'mg/dL'), row(day, 'Cr', 3.5, 'mg/dL')]);
    const r = evaluateForRecord(preset('kdigo-aki'), input, day);
    const cr = r.evaluation.items.find((x) => x.key === 'creatinine');
    expect(cr?.source).toBe('auto');
    expect(cr?.points ?? 0).toBeGreaterThan(0);
    // 前の日の値がなければ、上昇は決まらない（未入力）
    const alone = evaluateForRecord(preset('kdigo-aki'), base([row(day, 'Cr', 3.5, 'mg/dL')]), day);
    expect(alone.evaluation.items.find((x) => x.key === 'creatinine')?.state).toBe('unknown');
  });
  test('診断基準（Light の基準）：値がなければ「満たすかもしれない」で、満たさないにしない', () => {
    const p = preset('light-criteria');
    expect(evaluateForRecord(p, base([]), day).evaluation.criteria).toBe('possible');
    const met = evaluateForRecord(p, base([row(day, '胸水TP', 4.5, 'g/dL'), row(day, 'TP', 6.0, 'g/dL')]), day);
    expect(met.evaluation.criteria).toBe('met');
    expect(resultView(met.preset, met.evaluation).headline.startsWith(CRITERIA_STATE_LABEL.met)).toBe(true);
  });
  test('勧める定義：プロブレムの名前（AI のプロブレムリストを含む）から。名前も値もなければ出さない', () => {
    const input = base([row(`${day}T09:00`, '呼吸数', meets(rr, true), null, 'vital')], [{ name: '敗血症', source: 'ai' }]);
    const s = suggestedPresets(input, latestDay(input));
    expect(s.map((x) => x.preset.id)).toContain('qsofa');
    expect(s.find((x) => x.preset.id === 'qsofa')?.why).toEqual(['AI のプロブレムリスト「敗血症」']);
    expect(suggestedPresets(base([]), day)).toEqual([]);
  });
  test('評価の日：いちばん新しい測定値の日。first の定義は受診の始まりの日', () => {
    const input = base([row('2026-11-19T10:00', 'Cr', 1, 'mg/dL'), row('2026-11-21', 'Cr', 1, 'mg/dL', 'lab', { excluded: true })]);
    expect(latestDay(input)).toBe('2026-11-19');
    expect(latestDay(base([]), '2026-11-22T10:00')).toBe('2026-11-22');
    expect(latestDay(base([]))).toBe('2026-11-18');
    const first = PRESETS.list.find((p) => p.default_day === 'first');
    if (first === undefined) throw new Error('first');
    expect(evaluateForRecord(first, input, '2026-11-19').day).toBe('2026-11-18');
  });
  test('性質：どんな値の有無でも、値のない観察の項目は「あてはまらない」にならない。合計は最小 ≤ 最大', () => {
    fc.assert(
      fc.property(fc.option(fc.integer({ min: 4, max: 60 }), { nil: null }), fc.option(fc.integer({ min: 40, max: 220 }), { nil: null }), (rrValue, sbpValue) => {
        const rows = [
          ...(rrValue === null ? [] : [row(`${day}T09:00`, '呼吸数', rrValue, null, 'vital')]),
          ...(sbpValue === null ? [] : [row(`${day}T09:00`, '収縮期血圧', sbpValue, 'mmHg', 'vital')]),
        ];
        const e = evaluateForRecord(preset('qsofa'), base(rows), day).evaluation;
        const at = (key: string) => e.items.find((x) => x.key === key)?.state;
        if (rrValue === null) expect(at('rr')).toBe('unknown');
        if (sbpValue === null) expect(at('sbp')).toBe('unknown');
        expect(at('mentation')).toBe('unknown');
        expect(e.total !== null && e.total.min <= e.total.max).toBe(true);
      }),
    );
  });
});
