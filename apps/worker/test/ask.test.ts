// 段K6（CA-066）：記録への質問。答えは根拠つきで返し、保存しない（問いの字は、どの表にも残らない）。問いに識別情報の形があれば送らない。
// 1日の上限・記載がなければ AI を呼ばない。AI は試験の代役。文はすべて架空（synthetic）。
import type { AskReply, OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '三郎'].join('');
const NOTE = `${NAME}さん。\nK 3.0 と低値。KCl 20mEq を点滴で補正開始。\n家族に病状を説明した。`;
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  medications: [{ name: 'KCl', dose: '20mEq', action: 'start', when: null }],
  measurements: [{ quote: 'K 3.0', when: null, specimen: null }],
};
const QUESTION = 'K をいつ、どれだけ補正した？（架空の問い・照合用）';

async function setup(docs: FakeDocAnswers = {}, overrides: Parameters<typeof world>[0] = {}) {
  const organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, docs);
  const w = world({ selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 81, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-20T09:00' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const add = async (text: string) => {
    const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-20T10:00', text } });
    const id = ((await saved.json()) as { source: { id: string } }).source.id;
    await w.call('POST', `/api/sources/${id}/organize`, { cookie, body: {} });
  };
  const ask = (question: unknown) => w.call('POST', `/api/patients/${created.patient.id}/ask`, { cookie, body: { question } });
  return { w, cookie, organizer, patientId: created.patient.id, add, ask };
}

const usage = (s: Awaited<ReturnType<typeof setup>>): number => (s.w.db.raw.prepare('SELECT calls FROM usage_daily').get() as { calls: number } | undefined)?.calls ?? 0;

/** すべての表のすべての行（問いの字が残っていないかを見る） */
function everything(s: Awaited<ReturnType<typeof setup>>): string {
  const tables = (s.w.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  return JSON.stringify(tables.map((t) => s.w.db.raw.prepare(`SELECT * FROM ${t}`).all()));
}

describe('記録への質問（段K6）', () => {
  test('根拠つきの答えを返す（引用は記録の字の場所）。AI に送るのは資料（名前は置き換えた後）と問い。問いも答えも、どの表にも残らない', async () => {
    const s = await setup({
      ask: (message) => {
        const m = JSON.parse(message) as { records: { ref: string }[]; medications: { ref: string }[] };
        return {
          ok: true,
          answer: {
            answer: [
              { text: '入院1日目に KCl 20mEq の点滴で補正を始めた。', refs: [{ id: m.records[0]?.ref ?? '', quote: 'KCl 20mEq を点滴で補正開始' }, { id: m.medications[0]?.ref ?? '', quote: '' }] },
              { text: '補正の量を 40mEq に増やした。', refs: [{ id: 'R1', quote: 'KCl 40mEq に増量' }] },
            ],
            notFound: '2日目以降の補正の記載は、記録に見つかりませんでした',
          },
        };
      },
    });
    await s.add(NOTE);
    const tablesBefore = everything(s);
    const before = usage(s);
    const r = await s.ask(QUESTION);
    expect(r.status).toBe(200);
    expect(usage(s)).toBe(before + 1);
    const reply = ((await r.json()) as { answer: AskReply }).answer;
    expect(reply.answer).toHaveLength(1);
    const refs = reply.answer[0]?.refs ?? [];
    expect(refs.map((x) => x.kind)).toEqual(['record', 'medication']);
    expect(refs[0]?.quoted).toBe(true);
    expect(reply.rejected).toEqual({ bad_quote: 1, no_ref: 1 });
    expect(reply.notFound).toContain('見つかりませんでした');
    // AI に送ったもの：資料と問い。名前は置き換えた後
    const sent = JSON.parse(s.organizer.asked[0] ?? '{}') as { question: string; records: { text: string }[] };
    expect(sent.question).toBe(QUESTION);
    expect(JSON.stringify(sent)).not.toContain(NAME);
    expect(s.organizer.researched).toEqual([]);
    // 問いの字は、どの表にも残らない（数えたのは、日ごとの回数だけ）
    const after = everything(s);
    expect(after).not.toContain('照合用');
    expect(after).not.toContain('40mEq');
    expect(after.replace(/"calls":\d+/gu, '')).toBe(tablesBefore.replace(/"calls":\d+/gu, ''));
  });

  test('問いに識別情報の形（電話番号など）があれば、AI に送らない（相談の頼みと同じ）。空・長すぎは 400', async () => {
    const s = await setup();
    await s.add(NOTE);
    const phone = ['090', '1234', '5678'].join('-');
    const r = await s.ask(`${phone} に連絡したのは？`);
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'shape' });
    expect((await s.ask('')).status).toBe(400);
    expect((await s.ask('あ'.repeat(501))).status).toBe(400);
    expect(s.organizer.asked).toEqual([]);
  });

  test('記載がなければ AI を呼ばない。1日の上限に数える。鍵がなければ 503', async () => {
    const s = await setup();
    const empty = await s.ask('補正は？');
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({ error: 'ask_empty' });
    await s.add(NOTE);
    expect((await s.ask('補正は？')).status).toBe(200);
    expect(s.organizer.asked).toHaveLength(1);

    const limited = await setup({}, { dailyAiLimit: 50 });
    await limited.add(NOTE);
    limited.w.db.raw.exec('UPDATE usage_daily SET calls = 50');
    expect((await limited.ask('補正は？')).status).toBe(429);
    expect(limited.organizer.asked).toEqual([]);

    const none = world({ organizer: null });
    const { cookie } = await registered(none);
    expect((await none.call('POST', `/api/patients/${s.patientId}/ask`, { cookie, body: { question: '補正は？' } })).status).toBe(503);
  });
});
