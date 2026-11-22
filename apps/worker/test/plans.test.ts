// 段K9（CA-071）：予定と実施の突き合わせ。組む・確かめて残す・予定の行がなければ AI を呼ばない・先生の印と、その記録・組み直しで印を引き継ぐ・
// 1日の上限・AI が失敗したら前の一覧を残す・患者を消すと消える。AI は試験の代役。文はすべて架空（synthetic）。
import { type OrganizeAnswer, type PlanBody, planBasis } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '太郎'].join('');
const NOTE1 = `${NAME}さん。\n#1 腎盂腎炎\nA: 発熱は持続。\nP: 明日 胸部CT。\n明朝採血。`;
const NOTE2 = '胸部CT 施行、肺炎像なし。';
const NONE = { base: 'none', days: 0, hours: 0, minutes: 0, time: '', part: 'none', spanDays: 0 } as const;
const FIRST: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 腎盂腎炎', when: null },
    { label: 'assessment', start: 'A: 発熱は持続', when: null },
    { label: 'plan', start: 'P: 明日 胸部CT', when: null },
  ],
};
const SECOND: OrganizeAnswer = { ...EMPTY_ORGANIZE, events: [{ kind: 'test', title: '胸部CT 施行', when: null }] };

async function setup(docs: FakeDocAnswers = {}, overrides: Parameters<typeof world>[0] = {}) {
  const organizer = fakeOrganizer((text) => ({ ok: true, answer: text.includes('明日 胸部CT') ? FIRST : text.includes('胸部CT 施行') ? SECOND : EMPTY_ORGANIZE }), undefined, docs);
  const w = world({ selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 70, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } } })).json()) as {
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
      plans: { madeAt: string; promptVersion: string; basis: string; body: PlanBody } | null;
      sources: { id: string; organized: string | null }[];
    };
  const build = () => w.call('POST', `/api/patients/${created.patient.id}/plans`, { cookie, body: {} });
  const mark = (key: string, value: string) => w.call('PATCH', `/api/patients/${created.patient.id}/plans`, { cookie, body: { key, mark: value } });
  return { w, cookie, organizer, patientId: created.patient.id, add, record, build, mark };
}

const usage = (s: Awaited<ReturnType<typeof setup>>): number => (s.w.db.raw.prepare('SELECT calls FROM usage_daily').get() as { calls: number } | undefined)?.calls ?? 0;

/** 代役：予定の行の記号を、字で引いて答える */
const answering: FakeDocAnswers = {
  plans: (message) => {
    const m = JSON.parse(message) as { plans: { ref: string; text: string }[]; events: { ref: string; title: string }[] };
    const p = (t: string) => m.plans.find((x) => x.text.includes(t))?.ref ?? '';
    return {
      ok: true,
      answer: {
        items: [
          { id: p('明日 胸部CT'), kind: 'test', due: { ...NONE, base: 'note', days: 1 }, done: [m.events.find((e) => e.title === '胸部CT 施行')?.ref ?? ''] },
          { id: p('明朝採血'), kind: 'test', due: { ...NONE, base: 'note', days: 1, part: 'morning' }, done: [] },
        ],
      },
    };
  },
};

describe('予定と実施（段K9）', () => {
  test('予定の行ごとに、AI の記号を確かめて残す。字・場所は記録のもの。予定の日は決定論で計算。AI に送るのは、記録から作った資料（名前は置き換えた後）', async () => {
    const s = await setup(answering);
    await s.add(NOTE1, '2026-11-20T10:30');
    await s.add(NOTE2, '2026-11-21T14:00');
    const before = usage(s);
    expect((await s.build()).status).toBe(200);
    expect(usage(s)).toBe(before + 1);
    expect(s.organizer.planned).toHaveLength(1);
    expect(s.organizer.planned[0]).not.toContain(NAME);
    expect(s.organizer.researched).toEqual([]);
    const rec = await s.record();
    expect(rec.plans?.promptVersion).toBe('plan-1');
    expect(rec.plans?.basis).toBe(planBasis(rec.sources as never));
    expect(rec.plans?.body.items.map((i) => [i.text, i.problem, i.kind, i.state, i.due])).toEqual([
      ['明日 胸部CT。', '#1 腎盂腎炎', 'test', 'done', '2026-11-21'],
      ['明朝採血。', '#1 腎盂腎炎', 'test', 'open', '2026-11-21T08:00'],
    ]);
    expect(rec.plans?.body.items[0]?.done.map((d) => d.label)).toEqual(['検査の実施「胸部CT 施行」']);
    // 保存した中身に、AI の答えそのもの・資料の文は入れない（予定の行の字と場所と短い名前だけ）
    const row = s.w.db.raw.prepare('SELECT body FROM plan_checks').get() as { body: string };
    expect(row.body).not.toContain(NAME);
    expect(row.body).not.toContain('発熱は持続');
    expect(row.body).not.toContain('肺炎像なし');
  });

  test('先生の印（実施を確かめた・中止・不要・外す・戻す）は、記録に残り（印の前後だけ）、組み直しても引き継ぐ。知らない鍵は 404・打つ欄は受けない', async () => {
    const s = await setup(answering);
    await s.add(NOTE1, '2026-11-20T10:30');
    await s.build();
    const key = (await s.record()).plans?.body.items.find((i) => i.text === '明朝採血。')?.key ?? '';
    expect((await s.mark(key, 'cancelled')).status).toBe(200);
    expect((await s.mark('plan:none:0', 'confirmed')).status).toBe(404);
    expect((await s.mark(key, 'done')).status).toBe(400);
    expect((await s.w.call('PATCH', `/api/patients/${s.patientId}/plans`, { cookie: s.cookie, body: { key, mark: 'confirmed', note: '打った字' } })).status).toBe(400);
    expect(s.w.db.raw.prepare('SELECT item_key, before, after FROM plan_check_edits').all()).toEqual([{ item_key: key, before: 'none', after: 'cancelled' }]);
    await s.add(NOTE2, '2026-11-21T14:00');
    await s.build();
    const items = (await s.record()).plans?.body.items ?? [];
    expect(items.find((i) => i.key === key)?.mark).toBe('cancelled');
    expect(items.find((i) => i.text === '明日 胸部CT。')?.mark).toBe('none');
  });

  test('予定の行がなければ、AI を呼ばずに空の一覧を残す（回数に数えない）', async () => {
    const s = await setup(answering);
    await s.add(NOTE2, '2026-11-21T14:00');
    const before = usage(s);
    expect((await s.build()).status).toBe(200);
    expect(s.organizer.planned).toEqual([]);
    expect(usage(s)).toBe(before);
    expect((await s.record()).plans?.body.items).toEqual([]);
  });

  test('1日の上限に数える（上限なら呼ばない）。AI が失敗したら、前の一覧を残す。鍵がなければ 503', async () => {
    let fail = false;
    const s = await setup({ plans: (m) => (fail ? { ok: false, reason: 'unavailable' } : (answering.plans?.(m) ?? { ok: false, reason: 'bad_answer' })) });
    await s.add(NOTE1, '2026-11-20T10:30');
    await s.build();
    const kept = (await s.record()).plans;
    fail = true;
    expect((await s.build()).status).toBe(502);
    expect((await s.record()).plans).toEqual(kept);
    const limited = await setup(answering, { dailyAiLimit: 50 });
    await limited.add(NOTE1, '2026-11-20T10:30');
    limited.w.db.raw.exec('UPDATE usage_daily SET calls = 50');
    expect((await limited.build()).status).toBe(429);
    expect(limited.organizer.planned).toEqual([]);
    const none = world({ organizer: null });
    const { cookie } = await registered(none);
    expect((await none.call('POST', `/api/patients/${s.patientId}/plans`, { cookie, body: {} })).status).toBe(503);
  });

  test('患者を消すと、一覧も印の記録も消える', async () => {
    const s = await setup(answering);
    await s.add(NOTE1, '2026-11-20T10:30');
    await s.build();
    const key = (await s.record()).plans?.body.items[0]?.key ?? '';
    await s.mark(key, 'hidden');
    expect((await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie })).status).toBe(200);
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM plan_checks').get()).toEqual({ n: 0 });
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM plan_check_edits').get()).toEqual({ n: 0 });
  });
});
