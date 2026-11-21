// 単位の「同じ目盛り」（CA-051。全患者に共通）の API：組を決める・外す。字は打たない（項目・単位は表から）。
import { describe, expect, test } from 'vitest';

import { registered, world } from './support.ts';

const newPatient = async (w: ReturnType<typeof world>, cookie: string) =>
  ((await (await w.call('POST', '/api/patients', { cookie, body: { age: 70, ageOn: '2026-11-20', sex: 'female', encounter: { kind: 'inpatient', start: '2026-11-18' } } })).json()) as { patient: { id: string } }).patient.id;

describe('単位の「同じ目盛り」', () => {
  test('決めると、どの患者の記録にも出る。同じ組は1つ。外すと出なくなる（行は消さず、外した日時を残す）', async () => {
    const w = world();
    const { cookie } = await registered(w);
    const a = await newPatient(w, cookie);
    const b = await newPatient(w, cookie);
    const made = await w.call('POST', '/api/scale-links', { cookie, body: { name: 'WBC', unitA: '', unitB: '/μL' } });
    expect(made.status).toBe(200);
    const { id } = (await made.json()) as { id: string };
    // 向きを変えた同じ組は、新しく作らない
    expect(((await (await w.call('POST', '/api/scale-links', { cookie, body: { name: 'WBC', unitA: '/μL', unitB: '' } })).json()) as { id: string }).id).toBe(id);
    for (const p of [a, b]) {
      const rec = (await (await w.call('GET', `/api/patients/${p}`, { cookie })).json()) as { scaleLinks: { id: string; name: string; unitA: string; unitB: string }[] };
      expect(rec.scaleLinks.map((l) => [l.id, l.name, l.unitA, l.unitB])).toEqual([[id, 'WBC', '', '/μL']]);
    }
    expect((await w.call('DELETE', `/api/scale-links/${id}`, { cookie })).status).toBe(200);
    expect((await w.call('DELETE', `/api/scale-links/${id}`, { cookie })).status).toBe(404);
    const rec = (await (await w.call('GET', `/api/patients/${a}`, { cookie })).json()) as { scaleLinks: unknown[] };
    expect(rec.scaleLinks).toEqual([]);
    expect(w.db.raw.prepare('SELECT count(*) AS n FROM scale_links WHERE removed_at IS NOT NULL').get()).toEqual({ n: 1 });
  });

  test('表にない項目・バイタル・表にない単位・同じ単位は断る（打った字を入れない）', async () => {
    const w = world();
    const { cookie } = await registered(w);
    for (const body of [
      { name: '架空の項目', unitA: '', unitB: '/μL' },
      { name: '体温', unitA: '', unitB: '℃' },
      { name: 'WBC', unitA: '', unitB: '〔氏名〕' },
      { name: 'WBC', unitA: '/μL', unitB: '/μL' },
      { name: 'WBC', unitA: '', unitB: '/μL', extra: 1 },
    ]) expect((await w.call('POST', '/api/scale-links', { cookie, body })).status, JSON.stringify(body)).toBe(400);
    expect(w.db.raw.prepare('SELECT count(*) AS n FROM scale_links').get()).toEqual({ n: 0 });
  });

  test('登録していない端末は使えない', async () => {
    const w = world();
    expect((await w.call('POST', '/api/scale-links', { body: { name: 'WBC', unitA: '', unitB: '/μL' } })).status).toBe(401);
  });
});
