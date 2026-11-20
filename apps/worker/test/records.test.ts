// 記録の API（段1）：患者・受診・取り込み。氏名などの見本は、実行時に組み立てる（架空）。
import { IDENTIFIER_TOKENS, SHAPE_TOKENS, TEXT_LIMIT } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import type { SelectorResult } from '../src/selector.ts';
import { fakeSelector, registered, type World, world } from './support.ts';

const NAME = ['架空', '太郎'].join('');
const STAFF = ['見本', '花子'].join('');
const PHONE = ['090', '1234', '5678'].join('-');
const KNOWN = [
  { kind: 'person' as const, quote: NAME },
  { kind: 'staff' as const, quote: STAFF },
];

const PATIENT = { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-18T22:10' } };

async function setup(overrides: Parameters<typeof world>[0] = {}): Promise<{ w: World; cookie: string; patientId: string; encounterId: string }> {
  const w = world({ selector: fakeSelector(KNOWN), ...overrides });
  const { cookie } = await registered(w);
  const r = await w.call('POST', '/api/patients', { cookie, body: PATIENT });
  expect(r.status).toBe(200);
  const body = (await r.json()) as { patient: { id: string }; encounter: { id: string } };
  return { w, cookie, patientId: body.patient.id, encounterId: body.encounter.id };
}

const source = (text: string, extra: Record<string, unknown> = {}) => ({ kind: 'progress_note', authorRole: 'self', at: '2026-11-20T09:00', text, ...extra });
const dump = (w: World): string => JSON.stringify(['patients', 'encounters', 'sources', 'observations', 'usage_daily', 'devices', 'entrance_daily'].map((t) => w.db.raw.prepare(`SELECT * FROM ${t}`).all()));

describe('入口を通っていない要求には、答えない', () => {
  test('記録の API は、登録していない端末には、すべて 401', async () => {
    const { w, patientId, encounterId } = await setup();
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/patients'],
      ['POST', '/api/patients', PATIENT],
      ['GET', `/api/patients/${patientId}`],
      ['PATCH', `/api/patients/${patientId}`, { age: 1, ageOn: '2026-11-20', sex: 'male' }],
      ['DELETE', `/api/patients/${patientId}`],
      ['POST', `/api/patients/${patientId}/encounters`, { kind: 'er', start: '2026-11-20' }],
      ['PATCH', `/api/encounters/${encounterId}`, { end: null }],
      ['POST', `/api/encounters/${encounterId}/sources`, source('解熱。')],
    ];
    for (const [method, path, body] of calls) {
      const r = await w.call(method, path, body === undefined ? {} : { body });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM patients').get()).toEqual({ n: 1 });
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
  });
});

describe('患者と受診', () => {
  test('患者は、最初の受診と一緒に作る。持つのは、年齢・その日・性別だけ', async () => {
    const { w, cookie, patientId } = await setup();
    expect(w.db.raw.prepare('SELECT * FROM patients').all()).toEqual([{ id: patientId, age: 72, age_on: '2026-11-20', sex: 'male', created_on: '2026-11-20' }]);
    const list = (await (await w.call('GET', '/api/patients', { cookie })).json()) as { patients: { patient: { id: string }; latest: { kind: string; start: string }; sources: number }[]; today: string };
    expect(list.today).toBe('2026-11-20');
    expect(list.patients).toHaveLength(1);
    expect(list.patients[0]).toMatchObject({ patient: { id: patientId }, latest: { kind: 'inpatient', start: '2026-11-18T22:10' }, sources: 0 });
  });

  test('名前・ID・生年月日・病室・呼び名の欄は、受け付けない（表にも列がない）', async () => {
    const { w, cookie } = await setup();
    for (const extra of [{ name: NAME }, { patientId: '1' }, { birth: ['1954', '01', '01'].join('-') }, { room: '512' }, { label: 'x' }]) {
      const r = await w.call('POST', '/api/patients', { cookie, body: { ...PATIENT, ...extra } });
      expect(r.status, Object.keys(extra)[0]).toBe(400);
    }
    const columns = (w.db.raw.prepare("SELECT name FROM pragma_table_info('patients')").all() as { name: string }[]).map((c) => c.name);
    expect(columns.sort()).toEqual(['age', 'age_on', 'created_on', 'id', 'sex']);
  });

  test('受診を足す。終わり（退院）を入れる・消す。終わりは、始まりの日より前にできない', async () => {
    const { w, cookie, patientId, encounterId } = await setup();
    const added = await w.call('POST', `/api/patients/${patientId}/encounters`, { cookie, body: { kind: 'outpatient', start: '2026-12-10' } });
    expect(added.status).toBe(200);
    expect((await w.call('PATCH', `/api/encounters/${encounterId}`, { cookie, body: { end: '2026-12-01T10:00' } })).status).toBe(200);
    expect((await w.call('PATCH', `/api/encounters/${encounterId}`, { cookie, body: { end: '2026-11-17' } })).status).toBe(400);
    expect((await w.call('PATCH', `/api/encounters/${encounterId}`, { cookie, body: { end: '2026-11-18' } })).status).toBe(200);
    const record = (await (await w.call('GET', `/api/patients/${patientId}`, { cookie })).json()) as { encounters: { kind: string; end: string | null }[] };
    expect(record.encounters.map((e) => [e.kind, e.end])).toEqual([
      ['inpatient', '2026-11-18'],
      ['outpatient', null],
    ]);
    expect((await w.call('PATCH', `/api/encounters/${encounterId}`, { cookie, body: { end: null } })).status).toBe(200);
  });

  test('一覧は、いちばん新しい受診の開始が新しい順', async () => {
    const { w, cookie } = await setup();
    await w.call('POST', '/api/patients', { cookie, body: { ...PATIENT, age: 30, encounter: { kind: 'er', start: '2026-11-20T03:00' } } });
    await w.call('POST', '/api/patients', { cookie, body: { ...PATIENT, age: 50, encounter: { kind: 'outpatient', start: '2026-11-01' } } });
    const list = (await (await w.call('GET', '/api/patients', { cookie })).json()) as { patients: { patient: { age: number } }[] };
    expect(list.patients.map((p) => p.patient.age)).toEqual([30, 72, 50]);
  });

  test('ない患者・形の違う id', async () => {
    const { w, cookie } = await setup();
    expect((await w.call('GET', '/api/patients/01ARZ3NDEKTSV4RRFFQ69G5FAV', { cookie })).status).toBe(404);
    expect((await w.call('GET', '/api/patients/not-an-id', { cookie })).status).toBe(400);
    expect((await w.call('POST', '/api/encounters/01ARZ3NDEKTSV4RRFFQ69G5FAV/sources', { cookie, body: source('解熱。') })).status).toBe(404);
  });
});

describe('取り込み：選別を通った文だけを、保存する', () => {
  test('AI が指した場所を、決まった語に置き換えて保存する。打った原文は、どこにも残らない', async () => {
    const { w, cookie, encounterId } = await setup();
    const typed = `${NAME}、72歳男性。担当 ${STAFF}。発熱 3 日目、解熱傾向。`;
    const r = await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source(typed) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { source: { text: string; replaced: Record<string, number>; enteredAt: string; at: string }; observations: unknown[] };
    expect(body.source.text).toBe(`${IDENTIFIER_TOKENS.person}、72歳男性。担当 ${IDENTIFIER_TOKENS.staff}。発熱 3 日目、解熱傾向。`);
    expect(body.source.replaced).toEqual({ person: 1, staff: 1 });
    expect(body.source.enteredAt).toBe('2026-11-20T12:00');
    expect(body.observations).toEqual([]);
    const all = dump(w);
    expect(all).not.toContain(NAME);
    expect(all).not.toContain(STAFF);
    expect(all).toContain('解熱傾向');
  });

  test('送る前に、止めない・伏せない（CA-013）：AI には、打った文が、そのまま届く（見えない書式の文字と、前後の空白だけ除く）', async () => {
    const selector = fakeSelector(KNOWN);
    const { w, cookie, encounterId } = await setup({ selector });
    const zw = String.fromCharCode(0x200b);
    await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source(`  ${NAME}${zw} 連絡先 ${PHONE}\r\n解熱。 `) });
    expect(selector.seen).toEqual([`${NAME} 連絡先 ${PHONE}\n解熱。`]);
  });

  test('最後の網：AI が指さなかった電話番号の形も、保存の前に置き換える', async () => {
    const { w, cookie, encounterId } = await setup();
    const r = await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source(`家族の連絡先 ${PHONE}。WBC 12300。`) });
    const body = (await r.json()) as { source: { text: string; replaced: Record<string, number> } };
    expect(body.source.text).toBe(`家族の連絡先 ${SHAPE_TOKENS.phone}。WBC 12300。`);
    expect(body.source.replaced).toEqual({ phone: 1 });
    expect(dump(w)).not.toContain(PHONE);
  });

  test.each<[string, SelectorResult, number, string]>([
    ['AI が、文にない引用を返した', { ok: true, answer: { identifiers: [{ kind: 'person', quote: 'いない人', facility: null }] } }, 422, 'selection_failed'],
    ['AI が、1字の引用を返した', { ok: true, answer: { identifiers: [{ kind: 'person', quote: '熱', facility: null }] } }, 422, 'selection_failed'],
    ['AI が断った', { ok: false, reason: 'refused' }, 422, 'ai_refused'],
    ['AI につながらない', { ok: false, reason: 'unavailable' }, 502, 'ai_unavailable'],
    ['AI の答えが、決めた形でない', { ok: false, reason: 'bad_answer' }, 502, 'ai_bad_answer'],
  ])('%s → 保存しない。答えに、打った文を返さない', async (_name, result, status, error) => {
    const { w, cookie, encounterId } = await setup({ selector: fakeSelector([], () => result) });
    const typed = `${NAME}、発熱あり。`;
    const r = await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source(typed) });
    expect(r.status).toBe(status);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ error });
    expect(text).not.toContain(NAME);
    expect(text).not.toContain('発熱');
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
    expect(dump(w)).not.toContain(NAME);
  });

  test('AI の鍵がないとき：文は入れられない（選別なしで保存する道はない）', async () => {
    const { w, cookie, encounterId } = await setup({ selector: null });
    const r = await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source('解熱。') });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'no_ai' });
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
  });

  test('形の違う要求は 400：空の文・空白だけ・長すぎる文・知らない種類・余計な欄・日時の形', async () => {
    const { w, cookie, encounterId } = await setup();
    const bad: unknown[] = [
      source(''),
      source('   \n '),
      source('あ'.repeat(TEXT_LIMIT + 1)),
      source('解熱。', { kind: 'diary' }),
      source('解熱。', { authorRole: 'someone' }),
      source('解熱。', { patientName: NAME }),
      source('解熱。', { at: '2026-11-20 09:00' }),
      source('解熱。', { at: '2026-02-30' }),
    ];
    for (const body of bad) expect((await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body })).status).toBe(400);
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
  });

  test('日時が分からない文は、日時なしで保存する（推測で埋めない）', async () => {
    const { w, cookie, encounterId } = await setup();
    const r = await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source('前医での経過は不明。', { at: null, kind: 'referral', authorRole: 'unknown' }) });
    expect(((await r.json()) as { source: { at: string | null } }).source.at).toBeNull();
    expect(w.db.raw.prepare('SELECT at FROM sources').get()).toEqual({ at: null });
  });
});

describe('測定値：検査結果・バイタルの文から、AI を使わずに読む', () => {
  test('読んだ値は、書かれたとおり。日時は、文の日時。位置は、保存した文の中の位置', async () => {
    const { w, cookie, encounterId, patientId } = await setup();
    const r = await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source('WBC 12.3 CRP <0.1 尿潜血 (-) BP 78/40 昨日より改善', { kind: 'lab', at: '2026-11-20T06:00' }) });
    const body = (await r.json()) as { source: { id: string; text: string }; observations: { name: string; value: number | null; comparator: string | null; valueText: string; at: string; start: number; end: number; sourceId: string }[] };
    expect(body.observations.map((o) => [o.name, o.comparator, o.value, o.valueText])).toEqual([
      ['WBC', null, 12.3, '12.3'],
      ['CRP', '<', 0.1, '0.1'],
      ['尿潜血', null, null, '(-)'],
      ['収縮期血圧', null, 78, '78'],
      ['拡張期血圧', null, 40, '40'],
    ]);
    for (const o of body.observations) {
      expect(o.at).toBe('2026-11-20T06:00');
      expect(o.sourceId).toBe(body.source.id);
      expect(body.source.text.slice(o.start, o.end)).toContain(o.valueText);
    }
    // 読めなかった部分（「昨日より改善」）は、文に残っている
    expect(body.source.text).toContain('昨日より改善');
    const record = (await (await w.call('GET', `/api/patients/${patientId}`, { cookie })).json()) as { observations: unknown[]; sources: unknown[] };
    expect(record.observations).toHaveLength(5);
    expect(record.sources).toHaveLength(1);
    expect(w.db.raw.prepare('SELECT DISTINCT origin FROM observations').all()).toEqual([{ origin: 'parser' }]);
  });

  test('読んだ値は、書かれた順に返る（id の並びに依らない）', async () => {
    // 乱数を逆さに数える（後に作った id ほど、小さくなる）
    let counter = 1000;
    const { w, cookie, encounterId, patientId } = await setup();
    const runtime = { ...w.deps.runtime, randomBytes: (length: number) => (counter--, Uint8Array.from({ length }, (_, i) => (counter * 7 + i) % 256)) };
    const backwards = world({ db: w.db, selector: fakeSelector(KNOWN), runtime });
    const r = await backwards.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source('BP 98/56 HR 112 BT 38.6 WBC 15.1 CRP 14.2', { kind: 'lab' }) });
    expect(r.status).toBe(200);
    const record = (await (await backwards.call('GET', `/api/patients/${patientId}`, { cookie })).json()) as { observations: { name: string }[] };
    expect(record.observations.map((o) => o.name)).toEqual(['収縮期血圧', '拡張期血圧', '心拍数', '体温', 'WBC', 'CRP']);
  });

  test('ほかの種類の文からは、値を読まない（「K 3.5 を目標に」を、測定値にしない）', async () => {
    const { w, cookie, encounterId } = await setup();
    const r = await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source('K 3.5 を目標に補正。Hb 7 未満で輸血。') });
    expect(((await r.json()) as { observations: unknown[] }).observations).toEqual([]);
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });
  });

  test('判定の列がない（基準範囲・色・警告を持たない）', async () => {
    const { w } = await setup();
    const columns = (w.db.raw.prepare("SELECT name FROM pragma_table_info('observations')").all() as { name: string }[]).map((c) => c.name);
    expect(columns.join(' ')).not.toMatch(/range|flag|abnormal|normal|alert|level|judg|low|high/i);
  });
});

describe('消す', () => {
  test('文を消すと、そこから読んだ測定値も消える', async () => {
    const { w, cookie, encounterId } = await setup();
    const r = await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source('Na 128 K 3.1', { kind: 'lab' }) });
    const id = ((await r.json()) as { source: { id: string } }).source.id;
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 2 });
    expect((await w.call('DELETE', `/api/sources/${id}`, { cookie })).status).toBe(200);
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
    expect((await w.call('DELETE', `/api/sources/${id}`, { cookie })).status).toBe(404);
  });

  test('患者を消すと、受診・文・測定値が、すべて消える（CA-020）。ほかの患者は残る', async () => {
    const { w, cookie, encounterId, patientId } = await setup();
    await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source('Na 128', { kind: 'lab' }) });
    const other = (await (await w.call('POST', '/api/patients', { cookie, body: { ...PATIENT, age: 40 } })).json()) as { patient: { id: string }; encounter: { id: string } };
    await w.call('POST', `/api/encounters/${other.encounter.id}/sources`, { cookie, body: source('K 4.0', { kind: 'lab' }) });
    expect((await w.call('DELETE', `/api/patients/${patientId}`, { cookie })).status).toBe(200);
    for (const [table, n] of [['patients', 1], ['encounters', 1], ['sources', 1], ['observations', 1]] as const) {
      expect(w.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n });
    }
    expect((await w.call('GET', `/api/patients/${patientId}`, { cookie })).status).toBe(404);
    expect((await w.call('GET', `/api/patients/${other.patient.id}`, { cookie })).status).toBe(200);
  });
});

describe('AI を呼んだ回数（CA-022）', () => {
  test('日ごとに数える（日付と整数だけ）。上限に達したら、その日は AI を呼ばず、文も保存しない。次の日には入れられる', async () => {
    const selector = fakeSelector(KNOWN);
    const { w, cookie, encounterId } = await setup({ selector, dailyAiLimit: 2 });
    const post = () => w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source('解熱。') });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const third = await post();
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: 'ai_limit' });
    expect(selector.seen).toHaveLength(2);
    expect(w.db.raw.prepare('SELECT * FROM usage_daily').all()).toEqual([{ day: '2026-11-20', calls: 2 }]);
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 2 });
    w.clock.ms += 24 * 60 * 60 * 1000;
    expect((await post()).status).toBe(200);
  });

  test('失敗した選別も、呼んだ回数に数える', async () => {
    const { w, cookie, encounterId } = await setup({ selector: fakeSelector([], () => ({ ok: false, reason: 'unavailable' })) });
    await w.call('POST', `/api/encounters/${encounterId}/sources`, { cookie, body: source('解熱。') });
    expect(w.db.raw.prepare('SELECT calls FROM usage_daily').get()).toEqual({ calls: 1 });
  });
});
