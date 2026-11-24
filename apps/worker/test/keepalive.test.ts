// 画面とのつながりが切れても、書き込む要求の仕事を続ける（CA-086）：書き込む要求（GET でないもの）の仕事を keepAlive（本番は Cloudflare の ctx.waitUntil）に渡す。
// 読むだけの要求は渡さない。渡す仕事は、失敗しても投げない（waitUntil に渡した仕事の誤りで、Worker を落とさない）。少しずつ返す相談の答えも、書き終えるまで渡す。
// AI は試験の代役。文はすべて架空（synthetic）。
import type { OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NOTE = '【現病歴】\n3日前から発熱あり（架空）。\n#1 発熱\nA) 肺炎を疑う';
const ANSWER: OrganizeAnswer = { ...EMPTY_ORGANIZE, problems: [{ name: '#1 発熱', status: 'problem', activity: null }] };

async function setup() {
  const kept: Promise<unknown>[] = [];
  const w = world({ selector: fakeSelector(), organizer: fakeOrganizer(() => ({ ok: true, answer: ANSWER })), keepAlive: (work) => kept.push(work) });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 70, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  return { w, cookie, kept, ...created };
}

describe('つながりが切れても、書き込む要求の仕事を続ける（CA-086）', () => {
  test('書き込む要求の仕事だけを渡す（読むだけの要求は渡さない）。渡した仕事は、答えと同じ仕事で、終われば保存は済んでいる', async () => {
    const s = await setup();
    const before = s.kept.length;
    expect((await s.w.call('GET', `/api/patients/${s.patient.id}`, { cookie: s.cookie })).status).toBe(200);
    expect((await s.w.call('GET', '/api/patients', { cookie: s.cookie })).status).toBe(200);
    expect(s.kept.length).toBe(before);

    const saved = await s.w.call('POST', `/api/encounters/${s.encounter.id}/sources`, { cookie: s.cookie, body: { kind: 'admission_note', authorRole: 'self', at: '2026-11-20T10:30', text: NOTE } });
    expect(saved.status).toBe(200);
    const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
    expect(s.kept.length).toBe(before + 1);

    // 整理：渡した仕事が終わったときには、整理の結果が保存先にある
    const organizing = s.w.call('POST', `/api/sources/${sourceId}/organize`, { cookie: s.cookie, body: {} });
    const work = s.kept.at(-1);
    expect(s.kept.length).toBe(before + 2);
    await work;
    expect(s.w.db.raw.prepare('SELECT organized FROM sources WHERE id = ?').get(sourceId)).toEqual({ organized: 'done' });
    expect((await organizing).status).toBe(200);
  });

  test('渡した仕事は、仕事が失敗しても投げない（Worker を落とさない）。誤りの答えは、これまでどおり', async () => {
    const kept: Promise<unknown>[] = [];
    const w = world({ keepAlive: (work) => kept.push(work), organizer: { ...fakeOrganizer(), organize: () => Promise.reject(new Error('架空の失敗')) } });
    const { cookie } = await registered(w);
    const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 70, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } } })).json()) as {
      encounter: { id: string };
    };
    const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-20T10:30', text: NOTE } });
    const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
    const r = await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'server' });
    await expect(Promise.all(kept)).resolves.toBeDefined();
  });

  test('少しずつ返す相談の答えも、書き終えるまでの仕事を渡す', async () => {
    const s = await setup();
    const saved = await s.w.call('POST', `/api/encounters/${s.encounter.id}/sources`, { cookie: s.cookie, body: { kind: 'admission_note', authorRole: 'self', at: '2026-11-20T10:30', text: NOTE } });
    const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
    await s.w.call('POST', `/api/sources/${sourceId}/organize`, { cookie: s.cookie, body: {} });
    const before = s.kept.length;
    const res = await s.w.call('POST', `/api/patients/${s.patient.id}/consult`, { cookie: s.cookie, body: { question: '方針は？', turns: [], web: false, past: false, stream: true } });
    // 要求の仕事と、答えを書く仕事の2つ
    expect(s.kept.length).toBe(before + 2);
    await Promise.all(s.kept.slice(before));
    expect((await res.text()).trim().split('\n').at(-1)).toContain('"done"');
  });
});
