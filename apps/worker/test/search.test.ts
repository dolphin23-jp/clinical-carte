// 段K8（CA-070）：受け持ちを横断する検索。保存した文（置き換えた後）からだけ引き、問いはどの表にも残らない。識別情報の形の問いは断る。
// AI は呼ばない。文はすべて架空（synthetic）。名前・電話の形は、実行時に組み立てる（phi-guard）。
import { SEARCH_HIT_MAX, SEARCH_QUERY_MAX, type OrganizeAnswer, type SearchHit } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '花子'].join('');
const NOTE1 = `${NAME}さん。\nA) #1 閉塞性腎盂腎炎。ＣＴＲＸ 2g を開始。\nP) 尿培養の結果を待つ。`;
const NOTE2 = '入院時 Cr 1.8。発熱は改善。セフトリアキソン 継続。';
const ANSWERS: Record<string, OrganizeAnswer> = {
  [NOTE1]: {
    ...EMPTY_ORGANIZE,
    medications: [{ name: 'ＣＴＲＸ', dose: '2g', action: 'start', when: null }],
    problems: [{ name: '#1 閉塞性腎盂腎炎', status: 'diagnosis', activity: null }],
    course: [{ quote: '尿培養の結果を待つ', summary: '尿培養を提出し結果待ち', category: 'test', when: null, whenHint: null }],
  },
  [NOTE2]: { ...EMPTY_ORGANIZE, measurements: [{ quote: 'Cr 1.8', when: null, specimen: null }] },
};

interface Reply {
  total: number;
  shown: number;
  patients: { patientId: string; headline: string; total: number; hits: SearchHit[] }[];
}

async function setup() {
  const organizer = fakeOrganizer((text) => {
    const key = Object.keys(ANSWERS).find((k) => text.includes(k.slice(-12)));
    return { ok: true, answer: key === undefined ? EMPTY_ORGANIZE : (ANSWERS[key] ?? EMPTY_ORGANIZE) };
  });
  const w = world({ selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer });
  const { cookie } = await registered(w);
  const patient = async (age: number, start: string) =>
    (await (await w.call('POST', '/api/patients', { cookie, body: { age, ageOn: '2026-11-20', sex: 'female', encounter: { kind: 'inpatient', start } } })).json()) as { patient: { id: string }; encounter: { id: string } };
  const add = async (encounterId: string, text: string, at: string) => {
    const saved = await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at, text } });
    const id = ((await saved.json()) as { source: { id: string } }).source.id;
    await w.call('POST', `/api/sources/${id}/organize`, { cookie, body: {} });
    return id;
  };
  const search = (q: unknown) => w.call('POST', '/api/search', { cookie, body: { q } });
  return { w, cookie, organizer, patient, add, search };
}

/** すべての表のすべての行 */
function everything(s: Awaited<ReturnType<typeof setup>>): string {
  const tables = (s.w.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  return JSON.stringify(tables.map((t) => s.w.db.raw.prepare(`SELECT * FROM ${t}`).all()));
}

describe('受け持ちを横断する検索（段K8）', () => {
  test('保存した文（置き換えた後）と、整理した事実から引く。患者ごとに、見出しと当たりの場所。AI は呼ばない。問いはどの表にも残らない', async () => {
    const s = await setup();
    const a = await s.patient(78, '2026-11-18T10:00');
    const b = await s.patient(64, '2026-11-19T10:00');
    const s1 = await s.add(a.encounter.id, NOTE1, '2026-11-19T09:00');
    await s.add(b.encounter.id, NOTE2, '2026-11-20T09:00');
    const calls = { seen: s.organizer.seen.length, selected: 0 };
    const before = everything(s);

    const r = await s.search('ctrx');
    expect(r.status).toBe(200);
    const body = (await r.json()) as Reply;
    expect(body.patients.map((p) => p.patientId)).toEqual([a.patient.id]);
    const hit = body.patients[0]?.hits[0];
    expect(hit?.kind).toBe('medication');
    expect(hit?.match).toBe('ＣＴＲＸ');
    expect(hit?.anchor?.sourceId).toBe(s1);
    expect(body.patients[0]?.headline).toContain('78歳');
    // 問いはどの表にも残らない（検索は何も書かない）。AI は呼ばない
    const query = '照合用の問いの字（架空）';
    expect((await s.search(query)).status).toBe(200);
    expect(everything(s)).toBe(before);
    expect(everything(s)).not.toContain('照合用');
    expect(s.organizer.seen.length).toBe(calls.seen);
    expect(s.organizer.asked).toEqual([]);
    expect(s.organizer.researched).toEqual([]);
  });

  test('置き換える前の字（名前）では当たらない（保存した文だけを探す）。返す字は、保存した文の字', async () => {
    const s = await setup();
    const a = await s.patient(78, '2026-11-18T10:00');
    await s.add(a.encounter.id, NOTE1, '2026-11-19T09:00');
    const named = (await (await s.search(NAME)).json()) as Reply;
    expect(named.total).toBe(0);
    const stored = (s.w.db.raw.prepare('SELECT text FROM sources').all() as { text: string }[]).map((x) => x.text);
    expect(stored.join('')).not.toContain(NAME);
    const r = (await (await s.search('腎盂腎炎')).json()) as Reply;
    expect(r.total).toBeGreaterThan(0);
    for (const p of r.patients) for (const h of p.hits) expect(stored.some((t) => t.includes(`${h.before}${h.match}${h.after}`)) || h.kind === 'course' || h.kind === 'list').toBe(true);
    // 経過の出来事の要約（AI の整理）からも引く
    const c = (await (await s.search('提出し')).json()) as Reply;
    expect(c.patients[0]?.hits.map((h) => h.kind)).toEqual(['course']);
  });

  test('NFKC・大文字小文字・空白をそろえて比べる。値の項目は名前の表で引く', async () => {
    const s = await setup();
    const b = await s.patient(64, '2026-11-19T10:00');
    await s.add(b.encounter.id, NOTE2, '2026-11-20T09:00');
    const value = (await (await s.search('ｃｒ')).json()) as Reply;
    expect(value.patients[0]?.hits.map((h) => [h.kind, h.match, h.count])).toEqual([['value', 'Cr 1.8', 1]]);
    const spaced = (await (await s.search('セフト リアキソン')).json()) as Reply;
    expect(spaced.total).toBe(1);
  });

  test('識別情報の形の問いは断る（422）。長すぎる・空・知らない欄・GET は断る', async () => {
    const s = await setup();
    const phone = ['090', '1234', '5678'].join('-');
    expect((await s.search(phone)).status).toBe(422);
    expect(((await (await s.search(phone)).json()) as { error: string }).error).toBe('shape');
    expect((await s.search('x'.repeat(SEARCH_QUERY_MAX + 1))).status).toBe(400);
    expect((await s.search('   ')).status).toBe(400);
    expect((await s.w.call('POST', '/api/search', { cookie: s.cookie, body: { q: 'a', more: 1 } })).status).toBe(400);
    expect((await s.w.call('GET', '/api/search?q=a', { cookie: s.cookie })).status).toBe(404);
    // 登録していない端末には答えない
    expect((await s.w.call('POST', '/api/search', { body: { q: 'a' } })).status).toBe(401);
  });

  test('上限：返す当たりは全体で 50 まで。数は、返さなかった分も数える', async () => {
    const s = await setup();
    for (let i = 0; i < 6; i++) {
      const p = await s.patient(70 + i, `2026-11-1${String(i)}T10:00`);
      await s.add(p.encounter.id, '発熱あり。'.repeat(12), '2026-11-20T09:00');
    }
    const r = (await (await s.search('発熱')).json()) as Reply;
    expect(r.total).toBe(72);
    expect(r.shown).toBe(SEARCH_HIT_MAX);
    expect(r.patients.every((p) => p.total === 12 && p.hits.length <= 10)).toBe(true);
  });
});
