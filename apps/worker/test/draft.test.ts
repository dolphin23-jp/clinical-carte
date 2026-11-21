// 草案（段4。CA-023）：入院後経過（問題ごと）。保存しない。AI は試験の代役。
import type { DraftAnswer, OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import type { DrafterResult } from '../src/organizer.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '花子'].join('');
const NOTE = `${NAME}さん。\n#1 市中肺炎\nA) 抗菌薬に反応\nP) セフトリアキソン 2g 継続`;
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 市中肺炎', when: null },
    { label: 'assessment', start: 'A) 抗菌薬', when: null },
    { label: 'plan', start: 'P) セフ', when: null },
  ],
  problems: [{ name: '#1 市中肺炎', status: 'diagnosis', activity: null }],
};

async function setup(draft: (message: string) => DrafterResult, overrides: Parameters<typeof world>[0] = {}, note = NOTE) {
  const organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, draft);
  const w = world({ selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-17T22:10' } } })).json()) as {
    encounter: { id: string };
  };
  const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-19T09:00', text: note } });
  const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
  await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
  const run = () => w.call('POST', `/api/encounters/${created.encounter.id}/draft`, { cookie, body: {} });
  return { w, organizer, run };
}

const good: DraftAnswer = {
  sections: [
    {
      problem: 'T1',
      sentences: [
        { text: '3病日、抗菌薬に反応し、セフトリアキソン 2g を継続した。', cites: ['Q1', 'Q2'] },
        { text: 'CRP は 3 まで下がった。', cites: ['Q1'] },
      ],
    },
  ],
};

describe('草案', () => {
  test('AI に送るのは、保存した文から切り出した引用だけ（置き換えた後。ほかの部分は送らない）。確かめた文だけが返る', async () => {
    const s = await setup(() => ({ ok: true, answer: good }));
    const r = await s.run();
    expect(r.status).toBe(200);
    const body = (await r.json()) as { draft: { sections: { problem: { name: string }; sentences: { text: string; cites: { id: string; text: string }[] }[] }[]; rejected: Record<string, number> } };
    expect(body.draft.sections[0]?.problem.name).toBe('#1 市中肺炎');
    expect(body.draft.sections[0]?.sentences.map((x) => x.text)).toEqual(['3病日、抗菌薬に反応し、セフトリアキソン 2g を継続した。']);
    expect(body.draft.rejected).toEqual({ number: 1 });
    const sent = s.organizer.drafted[0] ?? '';
    expect(sent).toContain('A) 抗菌薬に反応');
    expect(sent).not.toContain(NAME);
    expect(sent).not.toContain('〔氏名〕さん'); // A・P の区切りの外の文は送らない
  });

  test('草案は保存しない（表の中身が変わらない）。AI を呼んだ回数には数える', async () => {
    const s = await setup(() => ({ ok: true, answer: good }));
    const dump = () =>
      JSON.stringify(
        (s.w.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('usage_daily')").all() as { name: string }[]).map((t) => s.w.db.raw.prepare(`SELECT * FROM ${t.name}`).all()),
      );
    const before = dump();
    const calls = () => (s.w.db.raw.prepare('SELECT calls FROM usage_daily').get() as { calls: number }).calls;
    const n = calls();
    await s.run();
    expect(dump()).toBe(before);
    expect(calls()).toBe(n + 1);
  });

  test('引用がない（問題の A・P がない）ときは、AI を呼ばない', async () => {
    const s = await setup(() => ({ ok: true, answer: good }), {}, '経過は落ち着いている。');
    const r = await s.run();
    expect(r.status).toBe(422);
    expect(s.organizer.drafted).toHaveLength(0);
  });

  test('AI が失敗したら 502。1日の上限なら 429', async () => {
    const s = await setup(() => ({ ok: false, reason: 'unavailable' }));
    expect((await s.run()).status).toBe(502);
    const t = await setup(() => ({ ok: true, answer: good }), { dailyAiLimit: 2 });
    expect((await t.run()).status).toBe(429);
  });
});
