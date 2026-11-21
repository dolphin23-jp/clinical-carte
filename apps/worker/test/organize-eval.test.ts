// 整理の評価（CD-018）：架空の文と決まり（eval/organize-cases.ts）、採点（eval/organize-lib.ts）、サーバーの入口（/api/selfcheck/organize）。
// 本物の AI は呼ばない。答えを知っている代役（文ごとの正しい答え）で、決まりが満たせること・採点が正しいことを確かめる。
import { findShapes, type OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { ORGANIZE_CASES } from '../eval/organize-cases.ts';
import { checkOrganizeCases, scoreOrganize } from '../eval/organize-lib.ts';
import { ORGANIZE_PROMPT_VERSION, ORGANIZE_PROMPT_VERSION_PREVIOUS } from '../src/prompt.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, registered, world } from './support.ts';

const cases = checkOrganizeCases(ORGANIZE_CASES);
const a = (patch: Partial<OrganizeAnswer>): OrganizeAnswer => ({ ...EMPTY_ORGANIZE, ...patch });

/** 文ごとの、正しい答え（新しい指示で期待する形） */
const ORACLE: Readonly<Record<string, OrganizeAnswer>> = {
  'er-01': a({
    problems: [
      { name: '#1 敗血症性ショック（尿路感染症による）', status: 'problem', activity: null },
      { name: '#2 急性腎障害', status: 'problem', activity: null },
      { name: '#3 高K血症', status: 'problem', activity: null },
      { name: '糖尿病', status: 'diagnosis', activity: 'inactive' },
    ],
    measurements: [
      { quote: 'BT 39.4℃、HR 124、BP 78/42（MAP 54）、RR 26、SpO2 94%（室内気）', when: '09:20' },
      { quote: 'WBC 18,200/μL、Plt 9.6万/μL、Cr 2.84 mg/dL、K 5.6 mEq/L、Lac 4.2 mmol/L', when: null },
    ],
    medications: [{ name: 'セフトリアキソン', dose: '2 g', action: 'start', when: '09:40' }],
    events: [{ kind: 'procedure', title: '尿道カテーテル留置', when: '09:45' }],
  }),
  'icu-01': a({
    problems: [
      { name: '#1 敗血症性ショック', status: 'problem', activity: null },
      { name: '#2 急性腎障害', status: 'problem', activity: null },
    ],
    measurements: [
      { quote: 'pH 7.28、Lac 3.4', when: '12:00' },
      { quote: 'BT 38.2℃、HR 112、BP 96/54、SpO2 95%', when: null },
    ],
    medications: [
      { name: 'メロペネム', dose: '1 g', action: 'start', when: '10:00' },
      { name: 'ノルアドレナリン', dose: '0.10 μg/kg/min', action: 'change', when: '11:30' },
      { name: 'メロペネム', dose: '1 g q8h', action: 'continue', when: null },
    ],
    events: [{ kind: 'test', title: '胸部X線を撮影', when: '13:00' }],
  }),
  'prog-01': a({
    problems: [{ name: '市中肺炎', status: 'diagnosis', activity: null }],
    measurements: [{ quote: 'BT 37.1 SpO2 97%', when: null }, { quote: 'WBC 9,800', when: null }],
    medications: [{ name: 'セフトリアキソン', dose: null, action: 'continue', when: null }],
    events: [{ kind: 'test', title: '胸部X線を撮影', when: '昨日' }],
  }),
  'adm-01': a({
    problems: [
      { name: '高血圧', status: 'diagnosis', activity: 'inactive' },
      { name: 'うっ血性心不全の急性増悪', status: 'suspected', activity: null },
    ],
    measurements: [{ quote: 'BNP 820 pg/mL、Cr 1.1', when: null }],
    medications: [{ name: 'フロセミド', dose: '20 mg', action: 'start', when: null }],
  }),
};

/** 前の版で見た誤りの型をまねた答え（er-01）：所見・鑑別・括弧の中身を問題に、言い直し・条件つき・見出しも拾う */
const OVERREACH: OrganizeAnswer = a({
  problems: [
    ...(ORACLE['er-01']?.problems ?? []),
    { name: '尿路感染症', status: 'diagnosis', activity: null },
    { name: '胆管炎', status: 'ruled_out', activity: null },
    { name: '擦過傷', status: 'problem', activity: null },
    { name: '気胸', status: 'ruled_out', activity: null },
    { name: '糖尿病', status: 'diagnosis', activity: null },
  ],
  measurements: [...(ORACLE['er-01']?.measurements ?? []), { quote: '乳酸4.2、MAP 54', when: null }],
  medications: [
    ...(ORACLE['er-01']?.medications ?? []),
    { name: 'セフトリアキソン', dose: '2 g q24h', action: 'start', when: null },
    { name: 'ノルアドレナリン', dose: null, action: 'start', when: null },
    { name: 'バンコマイシン', dose: null, action: null, when: null },
  ],
  events: [{ kind: 'test', title: '【検査】', when: null }, { kind: 'procedure', title: '尿道カテーテル留置', when: '09:45' }],
});

describe('架空の文と決まり', () => {
  test('形が正しく、どれも架空（synthetic）で、識別情報の形がない', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const c of cases) {
      expect(c.synthetic, c.id).toBe(true);
      expect(findShapes(c.text), c.id).toEqual([]);
    }
  });

  test('id の重なり・min と max の逆・検査結果の種類は、形の誤りにする', () => {
    const one = ORGANIZE_CASES[0] as Record<string, unknown>;
    expect(() => checkOrganizeCases([one, one])).toThrow();
    expect(() => checkOrganizeCases([{ ...one, kind: 'lab' }])).toThrow();
    expect(() => checkOrganizeCases([{ ...one, rules: [{ id: 'x1', label: 'x', target: 'event', match: 'x', min: 2, max: 1 }] }])).toThrow();
  });
});

describe('採点', () => {
  test('正しい答えなら、どの文も余分 0・欠け 0（決まりが満たせる）', async () => {
    for (const c of cases) {
      const answer = ORACLE[c.id];
      expect(answer, c.id).toBeDefined();
      const s = await scoreOrganize(c, fakeOrganizer(() => ({ ok: true, answer: answer ?? EMPTY_ORGANIZE })), 'current');
      expect({ id: s.id, failed: s.failed, extra: s.extra, missing: s.missing, unverified: s.unverified }, c.id).toEqual({ id: c.id, failed: null, extra: [], missing: [], unverified: 0 });
    }
  });

  test('拾いすぎた答えは、どの決まりを超えたかを返す', async () => {
    const c = cases.find((x) => x.id === 'er-01');
    if (c === undefined) throw new Error('er-01 がない');
    const s = await scoreOrganize(c, fakeOrganizer(() => ({ ok: true, answer: OVERREACH })), 'previous');
    expect(s.extra).toEqual(['p4', 'p5', 'p7', 'p8', 'p9', 'm1', 'd1', 'd2', 'd3', 'e2']);
    expect(s.missing).toEqual([]);
  });

  test('何も拾わない答えは、欠けを返す。整理が失敗したら、理由だけ', async () => {
    const c = cases.find((x) => x.id === 'prog-01');
    if (c === undefined) throw new Error('prog-01 がない');
    const none = await scoreOrganize(c, fakeOrganizer(), 'current');
    expect(none.extra).toEqual([]);
    expect(none.missing).toEqual(['p1', 'm1', 'm2', 'd1', 'e1']);
    const failed = await scoreOrganize(c, fakeOrganizer(() => ({ ok: false, reason: 'unavailable' })), 'current');
    expect(failed).toEqual({ id: 'prog-01', failed: 'unavailable', extra: [], missing: [], counts: null, unverified: 0 });
  });
});

describe('サーバーの入口（/api/selfcheck/organize）', () => {
  test('一覧は、文の id・説明・決まりの説明と、いまの版・前の版を返す（文そのものは返さない）', async () => {
    const w = world();
    const { cookie } = await registered(w);
    const r = await w.call('GET', '/api/selfcheck/organize', { cookie });
    const text = await r.clone().text();
    const body = (await r.json()) as { cases: { id: string; rules: { id: string }[] }[]; versions: { current: string; previous: string }; ready: boolean };
    expect(body.cases.map((c) => c.id)).toEqual(cases.map((c) => c.id));
    expect(body.versions).toEqual({ current: ORGANIZE_PROMPT_VERSION, previous: ORGANIZE_PROMPT_VERSION_PREVIOUS });
    expect(body.ready).toBe(true);
    expect(text).not.toContain('尿道カテーテル留置');
  });

  test('選んだ版を、整理の係に渡す。返すのは数と決まりの id だけ。1日の上限に数え、記録には何も保存しない', async () => {
    const organizer = fakeOrganizer((_text, prompt) => ({ ok: true, answer: prompt === 'previous' ? OVERREACH : (ORACLE['er-01'] ?? EMPTY_ORGANIZE) }));
    const w = world({ organizer, dailyAiLimit: 2 });
    const { cookie } = await registered(w);
    const post = (prompt: string) => w.call('POST', '/api/selfcheck/organize', { cookie, body: { id: 'er-01', prompt } });
    const before = (await (await post('previous')).json()) as { result: { extra: string[] } };
    const after = (await (await post('current')).json()) as { result: { extra: string[] } };
    expect(before.result.extra.length).toBeGreaterThan(0);
    expect(after.result.extra).toEqual([]);
    expect(organizer.prompts).toEqual(['previous', 'current']);
    expect((await post('current')).status).toBe(429);
    for (const table of ['patients', 'sources', 'observations', 'problems']) expect(w.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
  });

  test('本番の整理（/api/sources/:id/organize）は、いつもいまの版', async () => {
    const organizer = fakeOrganizer();
    const w = world({ organizer });
    const { cookie } = await registered(w);
    const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-18' } } })).json()) as { encounter: { id: string } };
    const added = (await (await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-20T09:00', text: '解熱した。' } })).json()) as { source: { id: string } };
    expect((await w.call('POST', `/api/sources/${added.source.id}/organize`, { cookie, body: {} })).status).toBe(200);
    expect(organizer.prompts).toEqual(['current']);
  });

  test('形の違う要求は 400、ない id は 404、AI の鍵がなければ 503、登録していない端末は 401', async () => {
    const w = world();
    const { cookie } = await registered(w);
    for (const body of [{ id: 'er-01' }, { id: 'er-01', prompt: 'old' }, { id: 'er-01', prompt: 'current', text: 'x' }]) {
      expect((await w.call('POST', '/api/selfcheck/organize', { cookie, body })).status).toBe(400);
    }
    expect((await w.call('POST', '/api/selfcheck/organize', { cookie, body: { id: 'zz-99', prompt: 'current' } })).status).toBe(404);
    expect((await w.call('POST', '/api/selfcheck/organize', { body: { id: 'er-01', prompt: 'current' } })).status).toBe(401);
    const off = world({ organizer: null });
    const reg = await registered(off);
    expect((await off.call('POST', '/api/selfcheck/organize', { cookie: reg.cookie, body: { id: 'er-01', prompt: 'current' } })).status).toBe(503);
  });
});
