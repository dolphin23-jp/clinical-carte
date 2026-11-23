// 段K6（CA-065）：結果待ちを追う。組む・確かめて残す・提出の候補がなければ AI を呼ばない・先生の印と、その記録・組み直しで印を引き継ぐ・
// 1日の上限・患者を消すと消える。AI は試験の代役。文はすべて架空（synthetic）。
import { type OrganizeAnswer, type PendingBody, pendingBasis } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '花子'].join('');
const NOTE1 = `${NAME}さん。\n血液培養2セット提出。\n胸部CT 撮影、読影待ち。`;
const NOTE2 = '血液培養2セットから大腸菌を検出。';
const ANSWERS: Record<string, OrganizeAnswer> = {
  [NOTE2]: { ...EMPTY_ORGANIZE, course: [{ quote: '血液培養2セットから大腸菌を検出', summary: '血液培養から大腸菌を検出', category: 'test', when: null, whenHint: null }] },
};
const FIRST: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  events: [
    { kind: 'test', title: '血液培養2セット提出', when: null },
    { kind: 'test', title: '胸部CT 撮影', when: null },
  ],
};

async function setup(docs: FakeDocAnswers = {}, overrides: Parameters<typeof world>[0] = {}) {
  const organizer = fakeOrganizer(
    (text) => ({ ok: true, answer: Object.entries(ANSWERS).find(([k]) => text.includes(k))?.[1] ?? (text.includes('血液培養2セット提出') ? FIRST : EMPTY_ORGANIZE) }),
    undefined,
    docs,
  );
  const w = world({ selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 80, ageOn: '2026-11-20', sex: 'female', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const add = async (text: string, at: string) => {
    const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at, text } });
    const id = ((await saved.json()) as { source: { id: string } }).source.id;
    await w.call('POST', `/api/sources/${id}/organize`, { cookie, body: {} });
  };
  const record = async () =>
    (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as {
      pending: { madeAt: string; promptVersion: string; basis: string; body: PendingBody } | null;
      sources: { id: string; organized: string | null }[];
    };
  const build = () => w.call('POST', `/api/patients/${created.patient.id}/pending`, { cookie, body: {} });
  const mark = (key: string, value: string) => w.call('PATCH', `/api/patients/${created.patient.id}/pending`, { cookie, body: { key, mark: value } });
  return { w, cookie, organizer, patientId: created.patient.id, add, record, build, mark };
}

const usage = (s: Awaited<ReturnType<typeof setup>>): number => (s.w.db.raw.prepare('SELECT calls FROM usage_daily').get() as { calls: number } | undefined)?.calls ?? 0;

describe('結果待ち（段K6）', () => {
  test('提出の候補ごとに、AI の記号を確かめて残す。名前・場所は記録のもの。AI に送るのは、記録から作った資料（名前は置き換えた後）', async () => {
    const s = await setup({
      pending: (message) => {
        const m = JSON.parse(message) as { events: { ref: string; title: string }[]; course: { ref: string; summary: string }[] };
        const ref = (title: string) => m.events.find((e) => e.title === title)?.ref ?? '';
        const result = m.course.find((c) => c.summary.includes('大腸菌'))?.ref ?? '';
        return { ok: true, answer: { items: [{ id: ref('血液培養2セット提出'), status: 'resulted', results: [result] }, { id: ref('胸部CT 撮影'), status: 'pending', results: [] }, { id: result, status: 'not_a_submission', results: [] }] } };
      },
    });
    await s.add(NOTE1, '2026-11-20T10:30');
    await s.add(NOTE2, '2026-11-22T09:00');
    const before = usage(s);
    const r = await s.build();
    expect(r.status).toBe(200);
    expect(usage(s)).toBe(before + 1);
    // AI に送ったもの：記録から作った資料だけ（名前は置き換えた後。外の検索はしない）
    expect(s.organizer.pended).toHaveLength(1);
    expect(s.organizer.pended[0]).not.toContain(NAME);
    expect(s.organizer.researched).toEqual([]);

    const rec = await s.record();
    const body = rec.pending?.body;
    expect(rec.pending?.promptVersion).toBe('pending-2');
    expect(rec.pending?.basis).toBe(pendingBasis(rec.sources as never));
    expect(body?.items.map((i) => [i.name, i.state])).toEqual([
      ['血液培養2セット提出', 'resulted'],
      ['胸部CT 撮影', 'pending'],
    ]);
    expect(body?.notSubmission).toBe(1);
    expect(body?.items[0]?.results[0]?.label).toBe('経過「血液培養から大腸菌を検出」');
    // 保存した中身に、AI の答えそのもの・資料の文は入れない（名前と場所と短い名前だけ）
    const row = s.w.db.raw.prepare('SELECT body FROM pending_results').get() as { body: string };
    expect(row.body).not.toContain('読影待ち');
    expect(row.body).not.toContain(NAME);
  });

  test('先生の印（結果を確かめた・外す・戻す）は、記録に残り（印の前後だけ）、組み直しても引き継ぐ。知らない鍵は 404・打つ欄は受けない', async () => {
    const s = await setup({
      pending: (message) => {
        const m = JSON.parse(message) as { submitted: string[] };
        return { ok: true, answer: { items: m.submitted.map((id) => ({ id, status: 'pending' as const, results: [] })) } };
      },
    });
    await s.add(NOTE1, '2026-11-20T10:30');
    await s.build();
    const key = (await s.record()).pending?.body.items.find((i) => i.name === '胸部CT 撮影')?.key ?? '';
    expect((await s.mark(key, 'checked')).status).toBe(200);
    expect((await s.mark('event:none:0', 'checked')).status).toBe(404);
    expect((await s.w.call('PATCH', `/api/patients/${s.patientId}/pending`, { cookie: s.cookie, body: { key, mark: 'checked', note: '打った字' } })).status).toBe(400);
    const edits = s.w.db.raw.prepare('SELECT item_key, before, after FROM pending_result_edits').all();
    expect(edits).toEqual([{ item_key: key, before: 'none', after: 'checked' }]);
    // 記録が増えて組み直しても、同じ記載の同じ場所の項目は、印を引き継ぐ
    await s.add('胸部CT の読影はまだ。', '2026-11-21T09:00');
    await s.build();
    const items = (await s.record()).pending?.body.items ?? [];
    expect(items.find((i) => i.key === key)?.mark).toBe('checked');
    expect(items.find((i) => i.name === '血液培養2セット提出')?.mark).toBe('none');
  });

  test('提出の候補がなければ、AI を呼ばずに空の一覧を残す（回数に数えない）', async () => {
    const s = await setup();
    await s.add('発熱あり。経過観察。', '2026-11-20T10:30');
    const before = usage(s);
    expect((await s.build()).status).toBe(200);
    expect(s.organizer.pended).toEqual([]);
    expect(usage(s)).toBe(before);
    expect((await s.record()).pending?.body.items).toEqual([]);
  });

  test('1日の上限に数える（上限なら呼ばない）。AI が失敗したら、前の一覧を残す。鍵がなければ 503', async () => {
    const s = await setup({ pending: () => ({ ok: false, reason: 'unavailable' }) });
    await s.add(NOTE1, '2026-11-20T10:30');
    expect((await s.build()).status).toBe(502);
    expect((await s.record()).pending).toBeNull();
    const limited = await setup({}, { dailyAiLimit: 50 });
    await limited.add(NOTE1, '2026-11-20T10:30');
    limited.w.db.raw.exec('UPDATE usage_daily SET calls = 50');
    expect((await limited.build()).status).toBe(429);
    expect(limited.organizer.pended).toEqual([]);
    const none = world({ organizer: null });
    const { cookie } = await registered(none);
    expect((await none.call('POST', `/api/patients/${s.patientId}/pending`, { cookie, body: {} })).status).toBe(503);
  });

  test('患者を消すと、一覧も印の記録も消える', async () => {
    const s = await setup();
    await s.add(NOTE1, '2026-11-20T10:30');
    await s.build();
    const key = (await s.record()).pending?.body.items[0]?.key ?? '';
    await s.mark(key, 'hidden');
    expect((await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie })).status).toBe(200);
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM pending_results').get()).toEqual({ n: 0 });
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM pending_result_edits').get()).toEqual({ n: 0 });
  });
});
