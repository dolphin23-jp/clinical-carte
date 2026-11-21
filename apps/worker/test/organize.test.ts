// 整理の API（段2）：保存した文を AI に整理させ、確かめた行だけを入れる。AI は、試験の代役。
import type { OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import type { OrganizerResult } from '../src/organizer.ts';
import { ORGANIZE_PROMPT_VERSION } from '../src/prompt.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, registered, type World, world } from './support.ts';

const NAME = ['架空', '太郎'].join('');
const NOTE = `${NAME}さん。#1 市中肺炎\nS) 咳嗽は軽減。\nO) BT 37.2。昨日 BT 38.4。\nP) メロペネム 1g 8時間毎 を継続。11/19 胸部X線を撮影。K 3.5 を目標に補正。`;

const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'subjective', start: 'S)' },
    { label: 'objective', start: 'O)' },
    { label: 'plan', start: 'P)' },
  ],
  medications: [
    { name: 'メロペネム', dose: '1g 8時間毎', action: 'continue', when: null },
    { name: 'バンコマイシン', dose: null, action: 'start', when: null },
  ],
  events: [{ kind: 'test', title: '胸部X線を撮影', when: '11/19' }],
  problems: [{ name: '#1 市中肺炎', status: 'problem' }],
  measurements: [
    { quote: 'BT 37.2', when: null },
    { quote: 'BT 38.4', when: '昨日' },
  ],
};

interface Setup {
  w: World;
  cookie: string;
  patientId: string;
  sourceId: string;
}

async function setup(answer: (text: string) => OrganizerResult = () => ({ ok: true, answer: ANSWER }), overrides: Parameters<typeof world>[0] = {}): Promise<Setup & { organizer: ReturnType<typeof fakeOrganizer> }> {
  const organizer = fakeOrganizer(answer);
  const w = world({ selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-18T22:10' } } })).json()) as { patient: { id: string }; encounter: { id: string } };
  const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-20T09:00', text: NOTE } });
  const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
  return { w, cookie, patientId: created.patient.id, sourceId, organizer };
}

interface Record {
  sources: { id: string; text: string; kind: string; at: string | null; organized: string | null; organizedVersion: string | null; organizeReport: unknown }[];
  segments: { label: string; start: number; end: number }[];
  medications: { name: string; doseText: string | null; action: string | null; at: string | null }[];
  events: { kind: string; title: string; at: string | null }[];
  problems: { name: string; status: string; at: string | null }[];
  observations: { name: string | null; value: number | null; at: string | null }[];
}

const recordOf = async ({ w, cookie, patientId }: Setup): Promise<Record> => (await (await w.call('GET', `/api/patients/${patientId}`, { cookie })).json()) as Record;

describe('整理する', () => {
  test('AI に送るのは、保存した文（識別情報を置き換えた後）だけ', async () => {
    const s = await setup();
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    expect(s.organizer.seen).toHaveLength(1);
    expect(s.organizer.seen[0]).not.toContain(NAME);
    expect(s.organizer.seen[0]).toContain('〔氏名〕さん。#1 市中肺炎');
  });

  test('確かめた行だけが入る。文にない薬（バンコマイシン）は入らず、件数だけが残る。文そのものは変わらない', async () => {
    const s = await setup();
    const r = await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    expect(r.status).toBe(200);
    const record = await recordOf(s);
    const source = record.sources[0];
    expect(source?.organized).toBe('done');
    expect(source?.organizedVersion).toBe(ORGANIZE_PROMPT_VERSION);
    expect(source?.organizeReport).toEqual({ medication: { not_found: 1 } });
    expect(source?.text).toBe(NOTE.replace(NAME, '〔氏名〕'));
    expect(record.segments.map((x) => x.label)).toEqual(['subjective', 'objective', 'plan']);
    expect(record.medications.map((m) => [m.name, m.doseText, m.action, m.at])).toEqual([['メロペネム', '1g 8時間毎', 'continue', '2026-11-20T09:00']]);
    expect(record.events.map((e) => [e.kind, e.title, e.at])).toEqual([['test', '胸部X線を撮影', '2026-11-19']]);
    expect(record.problems.map((p) => [p.name, p.status])).toEqual([['#1 市中肺炎', 'problem']]);
    expect(record.observations.map((o) => [o.name, o.value, o.at])).toEqual([
      ['体温', 37.2, '2026-11-20T09:00'],
      ['体温', 38.4, '2026-11-19'],
    ]);
    expect(s.w.db.raw.prepare('SELECT DISTINCT origin FROM observations').all()).toEqual([{ origin: 'ai' }]);
  });

  test('整理し直すと、その文の行が入れ替わる（重ならない）', async () => {
    let answer: OrganizeAnswer = ANSWER;
    const s = await setup(() => ({ ok: true, answer }));
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    answer = { ...EMPTY_ORGANIZE, problems: [{ name: '市中肺炎', status: 'diagnosis' }] };
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    const record = await recordOf(s);
    expect(record.problems.map((p) => [p.name, p.status])).toEqual([['市中肺炎', 'diagnosis']]);
    expect([record.segments, record.medications, record.events, record.observations]).toEqual([[], [], [], []]);
  });

  test('AI が失敗したら、それまでの行を残し、失敗の印だけを付ける。答えに、文を返さない', async () => {
    let result: OrganizerResult = { ok: true, answer: ANSWER };
    const s = await setup(() => result);
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    result = { ok: false, reason: 'unavailable' };
    const r = await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: 'ai_unavailable' });
    expect(text).not.toContain('咳嗽');
    const record = await recordOf(s);
    expect(record.sources[0]?.organized).toBe('failed');
    expect(record.medications).toHaveLength(1);
    expect(record.segments).toHaveLength(3);
  });

  test('未分類の文に、AI が種類を付ける。日時の分からない文に、文に書かれた日時を付ける', async () => {
    const organizer = fakeOrganizer(() => ({ ok: true, answer: { ...EMPTY_ORGANIZE, kind: 'lab', when: '2026/11/19 6:00' } }));
    const w = world({ selector: fakeSelector(), organizer });
    const { cookie } = await registered(w);
    const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-18' } } })).json()) as { patient: { id: string }; encounter: { id: string } };
    const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'unsorted', authorRole: 'unknown', at: null, text: '2026/11/19 6:00 採血 Na 128 K 3.1' } });
    const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 }); // 未分類の文からは、入れたときに値を読まない
    await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
    const record = (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as Record;
    expect(record.sources[0]).toMatchObject({ kind: 'lab', at: '2026-11-19T06:00' });
    expect(record.observations.map((o) => [o.name, o.value, o.at])).toEqual([
      ['Na', 128, '2026-11-19T06:00'],
      ['K', 3.1, '2026-11-19T06:00'],
    ]);
  });

  test('検査結果の文を整理し直しても、値は重ならない（決定論で読み直す）', async () => {
    const w = world({ selector: fakeSelector(), organizer: fakeOrganizer() });
    const { cookie } = await registered(w);
    const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-18' } } })).json()) as { encounter: { id: string } };
    const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'lab', authorRole: 'self', at: '2026-11-20T06:00', text: 'Na 128 K 3.1' } });
    const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 2 });
    await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
    await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
    expect(w.db.raw.prepare('SELECT name, origin FROM observations ORDER BY ord').all()).toEqual([
      { name: 'Na', origin: 'parser' },
      { name: 'K', origin: 'parser' },
    ]);
  });
});

describe('入口と、ほかの決まり', () => {
  test('登録していない端末には答えない。ない文は 404、形の違う id は 400', async () => {
    const s = await setup();
    expect((await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { body: {} })).status).toBe(401);
    expect((await s.w.call('POST', '/api/sources/01ARZ3NDEKTSV4RRFFQ69G5FAV/organize', { cookie: s.cookie, body: {} })).status).toBe(404);
    expect((await s.w.call('POST', '/api/sources/abc/organize', { cookie: s.cookie, body: {} })).status).toBe(400);
  });

  test('AI の鍵がなければ 503。1日の上限に数える', async () => {
    const none = await setup(undefined, { organizer: null });
    expect((await none.w.call('POST', `/api/sources/${none.sourceId}/organize`, { cookie: none.cookie, body: {} })).status).toBe(503);

    const s = await setup(undefined, { dailyAiLimit: 2 });
    // 選別で 1 回、整理で 1 回
    expect((await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} })).status).toBe(200);
    expect((await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} })).status).toBe(429);
    expect(s.w.db.raw.prepare('SELECT calls FROM usage_daily').get()).toEqual({ calls: 2 });
  });

  test('文を消すと、整理した行も消える。患者を消すと、すべて消える', async () => {
    const s = await setup();
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    expect((await s.w.call('DELETE', `/api/sources/${s.sourceId}`, { cookie: s.cookie })).status).toBe(200);
    for (const table of ['segments', 'medications', 'events', 'problems', 'observations']) expect(s.w.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });

    const t = await setup();
    await t.w.call('POST', `/api/sources/${t.sourceId}/organize`, { cookie: t.cookie, body: {} });
    expect((await t.w.call('DELETE', `/api/patients/${t.patientId}`, { cookie: t.cookie })).status).toBe(200);
    for (const table of ['segments', 'medications', 'events', 'problems', 'observations', 'sources']) expect(t.w.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
  });

  test('保存する整理の結果は、文の範囲と、文の字そのもの・分類・日時・整数だけ（AI の答えそのものは残さない）', async () => {
    const s = await setup(() => ({ ok: true, answer: { ...ANSWER, medications: [...ANSWER.medications, { name: 'メロペネム', dose: 'AI が作った用量 2g', action: 'change', when: null }] } }));
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    const all = JSON.stringify(['sources', 'segments', 'medications', 'events', 'problems', 'observations'].map((t) => s.w.db.raw.prepare(`SELECT * FROM ${t}`).all()));
    expect(all).not.toContain('AI が作った用量');
    expect(all).not.toContain('バンコマイシン');
  });
});
