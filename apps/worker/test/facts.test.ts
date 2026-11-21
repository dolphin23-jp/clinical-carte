// 問題以外の事実を直す（段3e）：外す・戻す、投薬の動き・できごとの種類・日時。直した記録。整理し直しでの引き継ぎ。
import type { OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NOTE = '#1 市中肺炎\nO) CRP 6.8\nP) セフトリアキソン 2g 継続。胸部X線を撮影。';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  medications: [{ name: 'セフトリアキソン', dose: '2g', action: 'continue', when: null }],
  events: [{ kind: 'test', title: '胸部X線を撮影', when: null }],
  measurements: [{ quote: 'CRP 6.8', when: null, specimen: null }],
};

interface Rec {
  medications: { id: string; action: string | null; at: string | null; excluded: boolean; edited: boolean }[];
  events: { id: string; kind: string; excluded: boolean; edited: boolean }[];
  observations: { id: string; nameRaw: string; at: string | null; excluded: boolean; edited: boolean }[];
  factEdits: { fact: string; field: string; before: string | null; after: string | null; target: string }[];
}

async function setup() {
  const w = world({ selector: fakeSelector(), organizer: fakeOrganizer(() => ({ ok: true, answer: ANSWER })) });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-17T22:10' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-20T09:00', text: NOTE } });
  const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
  await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
  const rec = async () => (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as Rec;
  const patch = (fact: string, id: string, body: unknown) => w.call('PATCH', `/api/facts/${fact}/${id}`, { cookie, body });
  return { w, cookie, sourceId, rec, patch, patientId: created.patient.id };
}

describe('事実を直す', () => {
  test('外す・戻す。直した記録が残る（値・印だけで、文は入らない）', async () => {
    const s = await setup();
    const med = (await s.rec()).medications[0];
    expect((await s.patch('medication', med?.id ?? '', { excluded: true })).status).toBe(200);
    let r = await s.rec();
    expect(r.medications[0]).toMatchObject({ excluded: true, edited: true });
    expect((await s.patch('medication', med?.id ?? '', { excluded: false })).status).toBe(200);
    r = await s.rec();
    expect(r.medications[0]?.excluded).toBe(false);
    expect(r.factEdits.map((e) => [e.field, e.before, e.after])).toEqual([
      ['excluded', '1', '0'],
      ['excluded', '0', '1'],
    ]);
    const rows = s.w.db.raw.prepare('SELECT * FROM fact_edits').all() as Record<string, unknown>[];
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['after', 'at', 'before', 'fact', 'field', 'id', 'patient_id', 'target']);
    expect(JSON.stringify(rows)).not.toContain('セフトリアキソン');
  });

  test('投薬の動き・できごとの種類・日時を選び直す。種類に合わない欄は 400', async () => {
    const s = await setup();
    const r = await s.rec();
    const med = r.medications[0]?.id ?? '';
    const ev = r.events[0]?.id ?? '';
    const obs = r.observations[0]?.id ?? '';
    expect((await s.patch('medication', med, { action: 'start' })).status).toBe(200);
    expect((await s.patch('event', ev, { kind: 'procedure' })).status).toBe(200);
    expect((await s.patch('observation', obs, { at: '2026-11-20T06:00' })).status).toBe(200);
    expect((await s.patch('event', ev, { action: 'start' })).status).toBe(400);
    expect((await s.patch('observation', obs, { kind: 'test' })).status).toBe(400);
    expect((await s.patch('medication', med, { at: '2026/11/20' })).status).toBe(400);
    expect((await s.patch('medication', med, { note: '打った文' })).status).toBe(400);
    expect((await s.patch('vital', med, { excluded: true })).status).toBe(400);
    const after = await s.rec();
    expect(after.medications[0]?.action).toBe('start');
    expect(after.events[0]?.kind).toBe('procedure');
    expect(after.observations[0]?.at).toBe('2026-11-20T06:00');
  });

  test('整理し直しても、同じ場所・同じ字の行には、直した値と外した印を引き継ぐ。直していない行は、整理のまま', async () => {
    const s = await setup();
    const r = await s.rec();
    await s.patch('medication', r.medications[0]?.id ?? '', { action: 'start' });
    await s.patch('event', r.events[0]?.id ?? '', { excluded: true });
    await s.patch('observation', r.observations[0]?.id ?? '', { at: '2026-11-20T06:00' });
    await s.w.call('POST', `/api/sources/${s.sourceId}/organize`, { cookie: s.cookie, body: {} });
    const again = await s.rec();
    expect(again.medications[0]).toMatchObject({ action: 'start', edited: true });
    expect(again.events[0]).toMatchObject({ excluded: true, edited: true });
    expect(again.observations[0]).toMatchObject({ at: '2026-11-20T06:00', edited: true });
  });

  test('ない行は 404。患者を消すと、直した記録も消える', async () => {
    const s = await setup();
    expect((await s.patch('medication', '01ARZ3NDEKTSV4RRFFQ69G5FAV', { excluded: true })).status).toBe(404);
    await s.patch('medication', (await s.rec()).medications[0]?.id ?? '', { excluded: true });
    await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie });
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM fact_edits').get()).toEqual({ n: 0 });
  });
});
