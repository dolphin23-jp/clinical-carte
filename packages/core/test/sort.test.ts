// AI による振り分け（CA-056）：時刻の手がかり・AI が読んだ値・経過の出来事。文は架空（synthetic）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { applyOrganization, numbersSeen, type OrganizeAnswer, type OrganizeContext, resolveHint, type WhenHint } from '../src/index.ts';

const HPI = [
  '【現病歴】',
  '3日前の夕方から悪寒と発熱あり、熱は38.5℃まで上昇。',
  '昨日、市販の解熱薬を内服したが改善せず。',
  '数日前から咳嗽あり。来院2時間前から呼吸苦が出現。',
  '血圧は90/50と低下、SpO2は室内気で89%。',
].join('\n');
const ctx: OrganizeContext = { text: HPI, kind: 'er_note', at: '2026-11-20T10:30', encounterStart: '2026-11-20T10:00' };
const empty: OrganizeAnswer = { kind: null, when: null, segments: [], medications: [], events: [], problems: [], measurements: [] };
const hint = (h: Partial<NonNullable<WhenHint>>): WhenHint => ({ base: 'note', days: null, hours: null, minutes: null, time: null, part: null, spanDays: null, ...h });

describe('時刻の手がかり（resolveHint）', () => {
  const c = { noteAt: '2026-11-20T10:30', encounterStart: '2026-11-20T10:00' };
  test('日のずれ・時間帯・時刻・来院からのずれ・幅', () => {
    expect(resolveHint(hint({ days: -3 }), c)).toEqual({ at: '2026-11-17', approx: null });
    expect(resolveHint(hint({ days: -3, part: 'evening' }), c)).toEqual({ at: '2026-11-17T17:00', approx: '夕方ごろ' });
    expect(resolveHint(hint({ days: -1, time: '6:15' }), c)).toEqual({ at: '2026-11-19T06:15', approx: null });
    expect(resolveHint(hint({ base: 'arrival', hours: -2 }), c)).toEqual({ at: '2026-11-20T08:00', approx: null });
    expect(resolveHint(hint({ days: -3, spanDays: 2 }), c)).toEqual({ at: '2026-11-17', approx: '11/16〜11/18ごろ' });
    // 基準の時刻が分からない時間のずれは、日だけにして「ごろ」
    expect(resolveHint(hint({ hours: -30 }), { noteAt: '2026-11-20', encounterStart: '2026-11-20' })).toEqual({ at: '2026-11-18', approx: 'ごろ' });
  });
  test('読めないものは null（推測で埋めない）', () => {
    expect(resolveHint(null, c)).toBeNull();
    expect(resolveHint(hint({}), c)).toBeNull();
    expect(resolveHint(hint({ time: '25:00' }), c)).toBeNull();
    expect(resolveHint(hint({ days: Number.NaN }), c)).toBeNull();
    expect(resolveHint(hint({ days: -1 }), { noteAt: null, encounterStart: '2026-11-20' })).toBeNull();
  });
  test('性質：日のずれだけなら、日だけになり、ずれの日数だけ動く', () => {
    fc.assert(
      fc.property(fc.integer({ min: -400, max: 400 }), (d) => {
        const r = resolveHint(hint({ days: d }), { noteAt: '2026-11-20', encounterStart: '2026-11-20' });
        expect(r?.at.length).toBe(10);
        expect(r?.approx).toBeNull();
        const diff = (Date.parse(`${r?.at ?? ''}T00:00Z`) - Date.parse('2026-11-20T00:00Z')) / 86_400_000;
        expect(diff).toBe(d);
      }),
    );
  });
});

describe('AI が読んだ値（CA-056）', () => {
  test('規則で読めない文の値は、AI の値を使う（項目の名前は同じ表で正規化）。引用の字に同じ数がなければ印', () => {
    const r = applyOrganization(
      {
        ...empty,
        measurements: [
          { quote: '熱は38.5℃まで上昇', when: null, whenHint: hint({ days: -3, part: 'evening' }), specimen: null, values: [{ name: '体温', value: '38.5', unit: '℃', comparator: null }] },
          { quote: '血圧は90/50と低下', when: null, specimen: null, values: [{ name: 'BP', value: '90/50', unit: null, comparator: null }] },
          { quote: 'SpO2は室内気で89%', when: null, specimen: null, values: [{ name: 'SpO2', value: '88', unit: '%', comparator: null }] },
        ],
      },
      ctx,
    );
    const rows = r.observations.map((o) => [o.row.name, o.row.valueText, o.readBy, o.unseen, o.at, o.atApprox]);
    expect(rows).toEqual([
      ['体温', '38.5', 'ai', false, '2026-11-17T17:00', '夕方ごろ'],
      ['収縮期血圧', '90', 'ai', false, '2026-11-20T10:30', null],
      ['拡張期血圧', '50', 'ai', false, '2026-11-20T10:30', null],
      ['SpO2', '88', 'ai', true, '2026-11-20T10:30', null], // 字は 89：印を付けて出す（消さない）
    ]);
    // 場所は引用の場所
    const first = r.observations[0];
    expect(HPI.slice(first?.row.start, first?.row.end)).toBe('熱は38.5℃まで上昇');
  });
  test('規則で読める引用は、規則で読む（AI の値は使わない）', () => {
    const text = 'O) BT 37.2';
    const r = applyOrganization({ ...empty, measurements: [{ quote: 'BT 37.2', when: null, specimen: null, values: [{ name: 'BT', value: '99', unit: null, comparator: null }] }] }, { ...ctx, text, kind: 'progress_note' });
    expect(r.observations.map((o) => [o.row.valueText, o.readBy, o.unseen])).toEqual([['37.2', 'rule', false]]);
  });
  test('推移（12.4→6.8）は、同じ引用を、日時ごとの値として使い直せる', () => {
    const text = 'CRP 12.4→6.8';
    const r = applyOrganization(
      {
        ...empty,
        measurements: [
          { quote: 'CRP 12.4→6.8', when: null, whenHint: hint({ days: -2 }), specimen: null, values: [{ name: 'CRP', value: '12.4', unit: null, comparator: null }] },
          { quote: 'CRP 12.4→6.8', when: null, specimen: null, values: [{ name: 'CRP', value: '6.8', unit: null, comparator: null }] },
        ],
      },
      { ...ctx, text, kind: 'progress_note' },
    );
    expect(r.observations.map((o) => [o.row.valueText, o.at])).toEqual([
      ['12.4', '2026-11-18'],
      ['6.8', '2026-11-20T10:30'],
    ]);
  });
});

describe('経過の出来事（CA-056）', () => {
  test('引用の場所・AI の要約・日時（手がかりから）。要約の数が引用になければ、引用の字を出す。識別情報の形は伏せる', () => {
    const r = applyOrganization(
      {
        ...empty,
        course: [
          { quote: '3日前の夕方から悪寒と発熱あり', summary: '悪寒・発熱が出現', category: 'onset', when: null, whenHint: hint({ days: -3, part: 'evening' }) },
          { quote: '昨日、市販の解熱薬を内服したが改善せず。', summary: '市販の解熱薬を内服（改善なし）', category: 'intake', when: '昨日', whenHint: null },
          { quote: '数日前から咳嗽あり。', summary: '咳嗽', category: 'onset', when: null, whenHint: hint({ days: -3, spanDays: 2 }) },
          { quote: '来院2時間前から呼吸苦が出現。', summary: '呼吸苦が出現（3時間前）', category: 'onset', when: null, whenHint: hint({ base: 'arrival', hours: -2 }) },
          { quote: '文にない字', summary: 'x', category: 'other', when: null, whenHint: null },
        ],
      },
      ctx,
    );
    expect(r.course.map((c) => [c.category, c.summary, c.at, c.atApprox])).toEqual([
      ['onset', '悪寒・発熱が出現', '2026-11-17T17:00', '夕方ごろ'],
      ['intake', '市販の解熱薬を内服（改善なし）', '2026-11-19', null],
      ['onset', '咳嗽', '2026-11-17', '11/16〜11/18ごろ'],
      ['onset', '来院2時間前から呼吸苦が出現。', '2026-11-20T08:00', null], // 要約の「3」が引用にない：引用の字にする
    ]);
    expect(r.report.course).toEqual({ not_found: 1, summary_number: 1 });
  });
  test('numbersSeen：全角・末尾の 0 をそろえて比べる', () => {
    expect(numbersSeen('CRP 6.80', 'CRP ６.８')).toBe(true);
    expect(numbersSeen('7日間', '3日前')).toBe(false);
  });
});
