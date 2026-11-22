// 段K10（CA-073）：Casebook へ送る印（casebook_links）。受診ごとに種を1回だけ作る・症例コード・取り込んだ項目の印・最初からやり直す・外来は断る・
// 記録の答えに入る・表に文・日付・時刻を入れない・患者を消すと消える。サーバーは Casebook へ何も送らない（AI も呼ばない）。文はすべて架空（synthetic）。
import { describe, expect, test } from 'vitest';

import { fakeSelector, registered, world } from './support.ts';

type LinkReply = { casebook: { encounterId: string; seed: string; code: string | null; sent: Record<string, { h: string; r: number }>; packets: number } };

async function setup(kind: 'inpatient' | 'er' | 'outpatient' = 'inpatient') {
  const selector = fakeSelector();
  const w = world({ selector });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 70, ageOn: '2026-11-20', sex: 'male', encounter: { kind, start: '2026-11-20T10:00' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const path = `/api/encounters/${created.encounter.id}/casebook`;
  const ensure = () => w.call('POST', path, { cookie, body: {} });
  const patch = (body: unknown) => w.call('PATCH', path, { cookie, body });
  return { w, cookie, selector, patientId: created.patient.id, encounterId: created.encounter.id, ensure, patch };
}

const rows = (s: Awaited<ReturnType<typeof setup>>) => s.w.db.raw.prepare('SELECT * FROM casebook_links').all() as Record<string, unknown>[];

describe('Casebook へ送る印（段K10）', () => {
  test('種は1回だけ作る（同じ受診で開き直しても同じ）。記録の答えに入る。AI は呼ばない', async () => {
    const s = await setup();
    const a = (await (await s.ensure()).json()) as LinkReply;
    expect(a.casebook).toMatchObject({ encounterId: s.encounterId, code: null, sent: {}, packets: 0 });
    expect(a.casebook.seed).toMatch(/^[a-z]{10}$/u);
    const b = (await (await s.ensure()).json()) as LinkReply;
    expect(b.casebook.seed).toBe(a.casebook.seed);
    const record = (await (await s.w.call('GET', `/api/patients/${s.patientId}`, { cookie: s.cookie })).json()) as { casebook: LinkReply['casebook'][] };
    expect(record.casebook).toEqual([a.casebook]);
    expect(s.selector.seen).toEqual([]);
  });

  test('症例コード（形を確かめ、大文字に）・取り込んだ項目の印（数を数える）・最初からやり直す（新しい種。コードと印を消す）', async () => {
    const s = await setup('er');
    const first = ((await (await s.ensure()).json()) as LinkReply).casebook;
    expect((await s.patch({ code: 'abc10i' })).status).toBe(400);
    const coded = (await (await s.patch({ code: ' abc234 ' })).json()) as LinkReply;
    expect(coded.casebook.code).toBe('ABC234');
    const taken = (await (await s.patch({ taken: [{ key: 's.01KAZZAAAAMMMMMMMMMMMMMMMM.0.c1', h: 'abcdefgh', r: 0 }] })).json()) as LinkReply;
    expect(taken.casebook.sent).toEqual({ 's.01KAZZAAAAMMMMMMMMMMMMMMMM.0.c1': { h: 'abcdefgh', r: 0 } });
    expect(taken.casebook.packets).toBe(1);
    // 印の形が違う（数字を含む・改訂が上限を超える・鍵に使えない字）
    for (const bad of [{ key: 'x', h: 'abcd1234', r: 0 }, { key: 'x', h: 'abcdefgh', r: 10 }, { key: '患者', h: 'abcdefgh', r: 0 }]) expect((await s.patch({ taken: [bad] })).status).toBe(400);
    expect((await s.patch({ code: null })).status).toBe(200);
    const reset = (await (await s.patch({ reset: true })).json()) as LinkReply;
    expect(reset.casebook).toMatchObject({ code: null, sent: {}, packets: 0 });
    expect(reset.casebook.seed).not.toBe(first.seed);
  });

  test('外来の受診は断る（Casebook では外来の受診日が要るため）。印のない受診は直せない', async () => {
    const out = await setup('outpatient');
    expect((await out.ensure()).status).toBe(400);
    const s = await setup();
    expect((await s.patch({ code: 'ABC234' })).status).toBe(404);
    expect((await s.w.call('POST', '/api/encounters/not-an-id/casebook', { cookie: s.cookie, body: {} })).status).toBe(400);
  });

  test('表に入るのは、受診・患者の id・種・症例コード・印の JSON・数だけ（文・日付・時刻はない）。患者を消すと消える', async () => {
    const s = await setup();
    await s.ensure();
    await s.patch({ code: 'ABC234' });
    await s.patch({ taken: [{ key: 't.01KAZZAAAAMMMMMMMMMMMMMMMM.dx.c1', h: 'ponmlkji', r: 2 }] });
    const [row] = rows(s);
    expect(Object.keys(row ?? {}).sort()).toEqual(['case_code', 'encounter_id', 'packets', 'patient_id', 'seed', 'sent']);
    expect(JSON.stringify(row)).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/u);
    expect((await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie })).status).toBe(200);
    expect(rows(s)).toEqual([]);
  });
});
