// 本人の調節（CA-029）：問題の筋の本人の決め・並べ替え・外す・統合を解く・打った名前（選別を通す）、
// なぞって足す、記載・区切り・値の項目名を直す、文を打ち直す（選別を通す）。整理し直しでも本人の行が残る。AI は試験の代役。
import type { OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '次郎'].join('');
const NOTE = '#1 発熱\nA) 原因を検索\nP) 血液培養を提出\n#2 低K血症\nO) K 3.1 Na 128\n便秘あり。酸化マグネシウム 330mg 開始。';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 発熱', when: null },
    { label: 'assessment', start: 'A) 原因', when: null },
    { label: 'plan', start: 'P) 血液', when: null },
    { label: 'problem_heading', start: '#2 低K', when: null },
    { label: 'objective', start: 'O) K', when: null },
  ],
  problems: [
    { name: '#1 発熱', status: 'problem', activity: null },
    { name: '#2 低K血症', status: 'problem', activity: null },
  ],
  measurements: [{ quote: 'K 3.1', when: null, specimen: null }],
};

interface Rec {
  sources: { id: string; text: string; kind: string; at: string | null; authorRole: string; organized: string | null }[];
  segments: { id: string; label: string; start: number; end: number; edited: boolean }[];
  problems: { id: string; name: string; threadId: string | null; status: string }[];
  problemThreads: { id: string; statusOverride: string | null; activityOverride: string | null; ord: number | null; excluded: boolean; typedName: string | null; mergedInto: string | null }[];
  medications: { name: string; action: string | null; edited: boolean }[];
  events: { title: string; kind: string }[];
  observations: { id: string; name: string | null; nameRaw: string; valueText: string; kind: string | null; edited: boolean }[];
  userEdits: { targetType: string; field: string; before: string | null; after: string | null }[];
}

async function setup(overrides: Parameters<typeof world>[0] = {}) {
  const selector = fakeSelector([{ kind: 'person', quote: NAME }]);
  const organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }));
  const w = world({ selector, organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-17T22:10' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-19T09:00', text: NOTE } });
  const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
  await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
  const rec = async () => (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as Rec;
  const call = (method: string, path: string, body: unknown) => w.call(method, path, { cookie, body });
  const pos = (s: string) => NOTE.indexOf(s);
  return { w, cookie, sourceId, rec, call, pos, selector, patientId: created.patient.id };
}

describe('問題の筋の本人の決め', () => {
  test('確からしさ・状態・外す・並べ替え。記録が残る', async () => {
    const s = await setup();
    let r = await s.rec();
    const fever = r.problems.find((p) => p.name === '#1 発熱')?.threadId ?? '';
    const lowK = r.problems.find((p) => p.name === '#2 低K血症')?.threadId ?? '';
    expect((await s.call('PATCH', `/api/threads/${fever}`, { status: 'suspected' })).status).toBe(200);
    expect((await s.call('PATCH', `/api/threads/${lowK}`, { activity: 'resolved' })).status).toBe(200);
    expect((await s.call('PATCH', `/api/threads/${lowK}`, { move: 'up' })).status).toBe(200);
    expect((await s.call('PATCH', `/api/threads/${lowK}`, { move: 'up' })).status).toBe(400); // もう一番上
    expect((await s.call('PATCH', `/api/threads/${fever}`, { excluded: true })).status).toBe(200);
    r = await s.rec();
    const t = new Map(r.problemThreads.map((x) => [x.id, x]));
    expect(t.get(fever)).toMatchObject({ statusOverride: 'suspected', excluded: true, ord: 1 });
    expect(t.get(lowK)).toMatchObject({ activityOverride: 'resolved', ord: 0 });
    expect(r.userEdits.map((e) => e.field).sort()).toEqual(['activity', 'excluded', 'ord', 'status']);
  });

  test('統合を解く：統合先から、統合した筋を戻す', async () => {
    const s = await setup();
    const r = await s.rec();
    const fever = r.problems.find((p) => p.name === '#1 発熱')?.threadId ?? '';
    const lowK = r.problems.find((p) => p.name === '#2 低K血症')?.threadId ?? '';
    await s.call('PATCH', `/api/threads/${lowK}`, { mergeInto: fever });
    expect((await s.call('PATCH', `/api/threads/${lowK}`, { unmerge: lowK })).status).toBe(400); // 統合した側からは解けない
    expect((await s.call('PATCH', `/api/threads/${fever}`, { unmerge: lowK })).status).toBe(200);
    expect((await s.rec()).problemThreads.find((x) => x.id === lowK)?.mergedInto).toBeNull();
  });

  test('打って直す名前は、選別を通した後の字で保存する（氏名は置き換わる）。AI の1回に数える', async () => {
    const s = await setup();
    const fever = (await s.rec()).problems.find((p) => p.name === '#1 発熱')?.threadId ?? '';
    const calls = () => (s.w.db.raw.prepare('SELECT calls FROM usage_daily').get() as { calls: number }).calls;
    const n = calls();
    expect((await s.call('PATCH', `/api/threads/${fever}`, { typedName: `#1 ${NAME}さんの右下葉肺炎` })).status).toBe(200);
    expect(calls()).toBe(n + 1);
    const thread = (await s.rec()).problemThreads.find((x) => x.id === fever);
    expect(thread?.typedName).toBe('#1 〔氏名〕さんの右下葉肺炎');
    expect(JSON.stringify(s.w.db.raw.prepare('SELECT * FROM user_edits').all())).not.toContain(NAME);
    expect((await s.call('PATCH', `/api/threads/${fever}`, { typedName: null })).status).toBe(200);
    expect(calls()).toBe(n + 1); // やめるときは AI を使わない
  });

  test('選別が失敗したら、打った名前は保存しない', async () => {
    // 文を入れるときの選別は通し、打った名前の選別だけを失敗させる
    const s = await setup({ selector: fakeSelector([], (text) => (text === NOTE ? { ok: true, answer: { identifiers: [] } } : { ok: false, reason: 'unavailable' })) });
    const fever = (await s.rec()).problems.find((p) => p.name === '#1 発熱')?.threadId ?? '';
    expect((await s.call('PATCH', `/api/threads/${fever}`, { typedName: '#1 肺炎' })).status).toBe(502);
    expect((await s.rec()).problemThreads.find((x) => x.id === fever)?.typedName).toBeNull();
  });
});

describe('なぞって足す', () => {
  test('問題・投薬・できごと・値・区切り。字は文にあるとおり。足した問題は筋につながる', async () => {
    const s = await setup();
    const add = (body: unknown) => s.call('POST', `/api/sources/${s.sourceId}/facts`, body);
    expect((await add({ type: 'problem', start: s.pos('便秘'), end: s.pos('便秘') + 2, status: 'problem' })).status).toBe(200);
    expect((await add({ type: 'medication', start: s.pos('酸化'), end: s.pos('酸化') + 8, action: 'start' })).status).toBe(200);
    expect((await add({ type: 'event', start: s.pos('血液培養'), end: s.pos('血液培養') + 7, kind: 'test' })).status).toBe(200);
    expect((await add({ type: 'observation', start: s.pos('Na 128'), end: s.pos('Na 128') + 6 })).status).toBe(200);
    expect((await add({ type: 'segment', start: s.pos('便秘'), label: 'assessment' })).status).toBe(200);
    const r = await s.rec();
    expect(r.problems.find((p) => p.name === '便秘')?.threadId).not.toBeNull();
    expect(r.medications).toEqual([expect.objectContaining({ name: '酸化マグネシウム', action: 'start', edited: true })]);
    expect(r.events.map((e) => [e.title, e.kind])).toEqual([['血液培養を提出', 'test']]);
    expect(r.observations.map((o) => o.nameRaw).sort()).toEqual(['K', 'Na']);
    const seg = r.segments.find((g) => g.start === s.pos('便秘'));
    expect(seg).toMatchObject({ label: 'assessment', edited: true });
    // 前の区切りの終わりが、足した区切りの始まりに詰まる
    expect(r.segments.find((g) => g.start === s.pos('O) K'))?.end).toBe(s.pos('便秘'));
  });

  test('文の外・値として読めない・行をまたぐは 422（理由の種類だけ）', async () => {
    const s = await setup();
    const add = (body: unknown) => s.call('POST', `/api/sources/${s.sourceId}/facts`, body);
    const r1 = await add({ type: 'observation', start: s.pos('便秘'), end: s.pos('便秘') + 2 });
    expect(r1.status).toBe(422);
    expect(await r1.json()).toEqual({ error: 'bad_span', problem: 'no_value' });
    expect((await add({ type: 'problem', start: 0, end: 9999, status: 'problem' })).status).toBe(422);
    expect((await add({ type: 'problem', start: 0, end: 12, status: 'problem' })).status).toBe(422);
    expect((await add({ type: 'problem', start: 0, end: 3, status: 'problem', name: '打った名前' })).status).toBe(400);
  });

  test('整理し直しても、足した行・直した区切りは残り、AI の同じ行は重ならない', async () => {
    const s = await setup();
    await s.call('POST', `/api/sources/${s.sourceId}/facts`, { type: 'observation', start: s.pos('K 3.1'), end: s.pos('K 3.1') + 5 });
    await s.call('POST', `/api/sources/${s.sourceId}/facts`, { type: 'problem', start: s.pos('便秘'), end: s.pos('便秘') + 2, status: 'problem' });
    const seg = (await s.rec()).segments.find((g) => g.label === 'objective');
    await s.call('PATCH', `/api/segments/${seg?.id ?? ''}`, { label: 'subjective' });
    await s.call('POST', `/api/sources/${s.sourceId}/organize`, { body: {} });
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    const r = await s.rec();
    expect(r.observations.filter((o) => o.nameRaw === 'K')).toHaveLength(1);
    expect(r.problems.filter((p) => p.name === '便秘')).toHaveLength(1);
    expect(r.segments.find((g) => g.id === seg?.id)).toMatchObject({ label: 'subjective', edited: true });
    expect(r.segments.filter((g) => g.start === seg?.start)).toHaveLength(1);
  });
});

describe('記載・値の項目名を直す', () => {
  test('種類・日時・書いた人。値の項目名は検査名の表からだけ', async () => {
    const s = await setup();
    expect((await s.call('PATCH', `/api/sources/${s.sourceId}`, { kind: 'admission_note' })).status).toBe(200);
    expect((await s.call('PATCH', `/api/sources/${s.sourceId}`, { at: '2026-11-19T10:00' })).status).toBe(200);
    expect((await s.call('PATCH', `/api/sources/${s.sourceId}`, { authorRole: 'senior' })).status).toBe(200);
    expect((await s.call('PATCH', `/api/sources/${s.sourceId}`, { text: '打った文' })).status).toBe(400);
    let r = await s.rec();
    expect(r.sources[0]).toMatchObject({ kind: 'admission_note', at: '2026-11-19T10:00', authorRole: 'senior' });
    const k = r.observations[0]?.id ?? '';
    expect((await s.call('PATCH', `/api/facts/observation/${k}`, { name: '表にない名前' })).status).toBe(400);
    const listed = (await import('@clinical-carte/core')).LAB_NAMES[0]?.name ?? '';
    expect((await s.call('PATCH', `/api/facts/observation/${k}`, { name: listed })).status).toBe(200);
    r = await s.rec();
    expect(r.observations[0]).toMatchObject({ name: listed, edited: true });
    expect(r.userEdits.map((e) => [e.targetType, e.field])).toContainEqual(['observation', 'name']);
  });
});

describe('文を打ち直す（C-1）', () => {
  test('選別を通した後の文で保存する。本人の行は、字を探して場所を移す。見つからなければ消して数を返す。記録に前後の文は残さない', async () => {
    const s = await setup();
    await s.call('POST', `/api/sources/${s.sourceId}/facts`, { type: 'problem', start: s.pos('便秘'), end: s.pos('便秘') + 2, status: 'problem' });
    await s.call('POST', `/api/sources/${s.sourceId}/facts`, { type: 'medication', start: s.pos('酸化'), end: s.pos('酸化') + 8, action: 'start' });
    const retyped = `${NAME}さん。\n${NOTE.replace('酸化マグネシウム 330mg 開始。', '')}`;
    const r = await s.call('PUT', `/api/sources/${s.sourceId}/text`, { text: retyped });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ lost: 1 });
    const rec = await s.rec();
    expect(rec.sources[0]?.text.startsWith('〔氏名〕さん。')).toBe(true);
    expect(rec.sources[0]?.organized).toBeNull(); // 整理し直しを待つ
    const constipation = rec.problems.find((p) => p.name === '便秘');
    expect(constipation).toBeDefined();
    expect(rec.medications).toHaveLength(0);
    const edit = rec.userEdits.find((e) => e.field === 'text');
    expect(edit).toMatchObject({ before: null, after: null });
    expect(JSON.stringify(s.w.db.raw.prepare('SELECT * FROM user_edits').all())).not.toContain('便秘あり');
  });
});
