// 段J（CA-056・CA-057）：AI による振り分け（経過の出来事・AI が読んだ値・おおよその日時）と、AI のプロブレムリスト。AI は試験の代役。架空（synthetic）。
import type { OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '太郎'].join('');
const HPI = `${NAME}さん。\n【現病歴】\n3日前の夕方から悪寒と発熱あり、熱は38.5℃まで上昇。\n昨日、市販の解熱薬を内服したが改善せず。\n#1 発熱\nA) 肺炎を疑う`;
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'present_illness', start: '【現病歴】', when: null },
    { label: 'problem_heading', start: '#1 発熱', when: null },
    { label: 'assessment', start: 'A) 肺炎', when: null },
  ],
  problems: [{ name: '#1 発熱', status: 'problem', activity: null }],
  measurements: [
    {
      quote: '熱は38.5℃まで上昇',
      when: '3日前の夕方',
      whenHint: { base: 'note', days: -3, hours: null, minutes: null, time: null, part: 'evening', spanDays: null },
      specimen: null,
      values: [{ name: '体温', value: '38.5', unit: '℃', comparator: null }],
    },
  ],
  course: [
    { quote: '3日前の夕方から悪寒と発熱あり', summary: '悪寒・発熱が出現', category: 'onset', when: '3日前の夕方', whenHint: { base: 'note', days: -3, hours: null, minutes: null, time: null, part: 'evening', spanDays: null } },
    { quote: '昨日、市販の解熱薬を内服したが改善せず。', summary: '市販の解熱薬を内服（改善なし）', category: 'intake', when: '昨日', whenHint: null },
  ],
};

interface Rec {
  observations: { name: string | null; valueText: string; at: string | null; atApprox: string | null; readBy: string; unseen: boolean }[];
  course: { summary: string; category: string; at: string | null; atApprox: string | null; sourceId: string; start: number }[];
  problemThreads: { id: string }[];
  problemList: { items: { key: string; name: string; certainty: string; activity: string; threadIds: string[]; since: string | null; self: string[]; hidden: boolean }[]; basis: string } | null;
}

async function setup(docs: FakeDocAnswers = {}, overrides: Parameters<typeof world>[0] = {}) {
  const organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, docs);
  const selector = fakeSelector([{ kind: 'person', quote: NAME }]);
  const w = world({ selector, organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'er', start: '2026-11-20T10:00' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'er_note', authorRole: 'self', at: '2026-11-20T10:30', text: HPI } });
  const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
  await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
  const record = async (): Promise<Rec> => (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as Rec;
  return { w, cookie, organizer, selector, patientId: created.patient.id, sourceId, record };
}

describe('AI による振り分け（CA-056）', () => {
  test('経過の出来事と、AI が読んだ値（おおよその日時の印・AI の印）を残す。整理し直すと入れ替わる。文を消すと消える', async () => {
    const s = await setup();
    const r = await s.record();
    expect(r.course.map((c) => [c.category, c.summary, c.at, c.atApprox])).toEqual([
      ['onset', '悪寒・発熱が出現', '2026-11-17T17:00', '夕方ごろ'],
      ['intake', '市販の解熱薬を内服（改善なし）', '2026-11-19', null],
    ]);
    expect(r.observations.map((o) => [o.name, o.valueText, o.at, o.atApprox, o.readBy, o.unseen])).toEqual([['体温', '38.5', '2026-11-17T17:00', '夕方ごろ', 'ai', false]]);
    // 整理し直しても、二重にならない
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    expect((await s.record()).course).toHaveLength(2);
    await s.w.call('DELETE', `/api/sources/${s.sourceId}`, { cookie: s.cookie });
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM course_items').get()).toEqual({ n: 0 });
  });
});

describe('AI のプロブレムリスト（CA-057）', () => {
  test('記録から組み、筋と出来事に結びつく項目だけを残す。送るのは記録から作った資料（名前は置き換えた後）', async () => {
    const s = await setup({
      problemList: () => ({
        ok: true,
        answer: {
          items: [
            { name: '市中肺炎疑い', certainty: 'suspected', activity: 'active', threads: ['T1'], course: ['C1'], basis: '3日前からの発熱と、肺炎を疑うとの評価' },
            { name: '根のない問題', certainty: 'problem', activity: 'active', threads: [], course: [], basis: '' },
          ],
        },
      }),
    });
    const res = await s.w.call('POST', `/api/patients/${s.patientId}/problem-list`, { cookie: s.cookie, body: {} });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rejected: unknown }).rejected).toEqual({ ungrounded: 1 });
    const sent = s.organizer.listed[0] ?? '';
    expect(sent).toContain('#1 発熱');
    expect(sent).toContain('悪寒・発熱が出現');
    expect(sent).not.toContain(NAME);
    const list = (await s.record()).problemList;
    expect(list?.items.map((i) => [i.name, i.certainty, i.since])).toEqual([['市中肺炎疑い', 'suspected', '2026-11-17T17:00']]);
    expect(list?.items[0]?.threadIds).toEqual([(await s.record()).problemThreads[0]?.id]);
    // 回診リストの問題は、リストの番号と名前（2026-11-22。記録に書かれた「#1 発熱」ではなく）
    const patients = (await (await s.w.call('GET', '/api/patients', { cookie: s.cookie })).json()) as { patients: { round: { problems: string[]; listed: boolean } }[] };
    expect(patients.patients[0]?.round).toMatchObject({ problems: ['#1 市中肺炎疑い'], listed: true });
  });

  test('先生の直し：名前は選別を通す（置き換わる）。状態・外す・並べ替え。組み直しても引き継ぐ。直した記録が残る', async () => {
    const s = await setup({
      problemList: () => ({ ok: true, answer: { items: [{ name: '市中肺炎疑い', certainty: 'suspected', activity: 'active', threads: ['T1'], course: [], basis: '' }] } }),
    });
    await s.w.call('POST', `/api/patients/${s.patientId}/problem-list`, { cookie: s.cookie, body: {} });
    const key = (await s.record()).problemList?.items[0]?.key ?? '';
    const patch = (body: unknown) => s.w.call('PATCH', `/api/patients/${s.patientId}/problem-list`, { cookie: s.cookie, body });
    expect((await patch({ key, name: `${NAME}さんの肺炎` })).status).toBe(200);
    expect((await patch({ key, activity: 'resolved' })).status).toBe(200);
    expect((await patch({ key: 'none', hidden: true })).status).toBe(404);
    let item = (await s.record()).problemList?.items[0];
    expect(item?.name).toBe('〔氏名〕さんの肺炎');
    expect(item?.self.sort()).toEqual(['activity', 'name']);
    // 組み直しても、先生の直しを引き継ぐ
    await s.w.call('POST', `/api/patients/${s.patientId}/problem-list`, { cookie: s.cookie, body: {} });
    item = (await s.record()).problemList?.items[0];
    expect([item?.key, item?.name, item?.activity]).toEqual([key, '〔氏名〕さんの肺炎', 'resolved']);
    const edits = s.w.db.raw.prepare('SELECT field FROM problem_list_edits').all() as { field: string }[];
    expect(edits.map((e) => e.field).sort()).toEqual(['activity', 'name']);
  });

  test('記録が空なら AI を呼ばない。上限なら呼ばない。患者を消すと、リストも消える', async () => {
    const organizer = fakeOrganizer();
    const w = world({ selector: fakeSelector(), organizer });
    const { cookie } = await registered(w);
    const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 50, ageOn: '2026-11-20', sex: 'female', encounter: { kind: 'er', start: '2026-11-20T10:00' } } })).json()) as { patient: { id: string } };
    const empty = await w.call('POST', `/api/patients/${created.patient.id}/problem-list`, { cookie, body: {} });
    expect(empty.status).toBe(422);
    expect(organizer.listed).toHaveLength(0);
    const limited = await setup({}, { dailyAiLimit: 2 });
    expect((await limited.w.call('POST', `/api/patients/${limited.patientId}/problem-list`, { cookie: limited.cookie, body: {} })).status).toBe(429);
    const s = await setup({ problemList: () => ({ ok: true, answer: { items: [{ name: 'A', certainty: 'problem', activity: 'active', threads: ['T1'], course: [], basis: '' }] } }) });
    await s.w.call('POST', `/api/patients/${s.patientId}/problem-list`, { cookie: s.cookie, body: {} });
    await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie });
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM problem_lists').get()).toEqual({ n: 0 });
  });
});
