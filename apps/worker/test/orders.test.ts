// 段K11（CA-074〜CA-079）：指示簿。写す（引用を確かめる・保存しない・そのままの字は選別を通さない）・案（※・テンプレの流量を落とす・根拠のない案は出さない・保存しない）・
// 足す（打った字は選別を通す）・直す（中止・再開・体重と段・欄）・消す・テンプレ（識別情報の形は断る・患者に付かない）・結果待ちへの結びつけ・1日の上限・患者を消すと消える。
// AI は試験の代役。文はすべて架空（synthetic）。
import type { OrderItem, PendingBody, ProposeAnswer, ScaleTemplateBody, TranscribeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '一郎'].join('');
const NOTE = '【架空】経過。\nNPPV IPAP 10 / EPAP 5 で継続。\n不穏時 頓用薬Aを1回投与。\n明朝 採血（血算・生化学）。';
const RESULT = '【架空】採血結果：白血球 9800。';
const T = (items: TranscribeAnswer['items']): TranscribeAnswer => ({ items });
const blank = { condition: '', drug: '', dose: '', rate: '', interval: '', duration: '', action: 'none' as const };

const TEMPLATE: ScaleTemplateBody = {
  name: '試験用スケール',
  drug: '架空の薬B',
  amount: 2,
  amountUnit: 'mg',
  volume: 50,
  doseUnit: 'μg/kg/min',
  steps: [
    { label: '段1', dose: 0.05, note: '' },
    { label: '段2', dose: 0.1, note: '' },
  ],
  note: '試験用（臨床の数ではない）',
};

async function setup(docs: FakeDocAnswers = {}, overrides: Parameters<typeof world>[0] = {}) {
  const organizer = fakeOrganizer(
    (text) => ({
      ok: true,
      answer: text.includes('採血結果')
        ? { ...EMPTY_ORGANIZE, course: [{ quote: '採血結果：白血球 9800', summary: '採血結果', category: 'test', when: null, whenHint: null }] }
        : text.includes('NPPV')
          ? { ...EMPTY_ORGANIZE, course: [{ quote: 'NPPV IPAP 10 / EPAP 5 で継続', summary: 'NPPV を継続', category: 'treatment', when: null, whenHint: null }] }
          : EMPTY_ORGANIZE,
    }),
    undefined,
    docs,
  );
  const selector = fakeSelector([{ kind: 'person', quote: NAME }]);
  const w = world({ selector, organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 75, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const add = async (text: string, at: string): Promise<string> => {
    const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at, text } });
    const id = ((await saved.json()) as { source: { id: string } }).source.id;
    await w.call('POST', `/api/sources/${id}/organize`, { cookie, body: {} });
    return id;
  };
  const enc = created.encounter.id;
  const call = (method: string, path: string, body?: unknown) => w.call(method, path, { cookie, body });
  const sheet = (): OrderItem[] => {
    const row = w.db.raw.prepare('SELECT items FROM order_sheets WHERE encounter_id = ?').get(enc) as { items: string } | undefined;
    return row === undefined ? [] : (JSON.parse(row.items) as OrderItem[]);
  };
  const record = async () =>
    (await (await call('GET', `/api/patients/${created.patient.id}`)).json()) as {
      orders: { encounterId: string; items: OrderItem[] }[];
      orderTemplates: { id: string; body: ScaleTemplateBody }[];
      pending: { basis: string; body: PendingBody } | null;
    };
  return { w, cookie, organizer, selector, enc, patientId: created.patient.id, add, call, sheet, record };
}

const usage = (s: Awaited<ReturnType<typeof setup>>): number => (s.w.db.raw.prepare('SELECT calls FROM usage_daily').get() as { calls: number } | undefined)?.calls ?? 0;

const fields = (over: Partial<Record<string, unknown>> = {}) => ({ category: 'rest', text: 'ベッド上安静', ...blank, start: null, end: null, scale: null, ...over });
/** 案の形から、足す形にする（画面の鍵を外す） */
const withoutKey = (p: unknown): Record<string, unknown> => Object.fromEntries(Object.entries(p as Record<string, unknown>).filter(([k]) => k !== 'key'));
const newItem = (over: Partial<Record<string, unknown>> = {}) => ({ ...fields(over), origin: 'self', from: null, basis: [], unseen: [], ...over });

describe('指示簿を写す（段K11。CA-074）', () => {
  test('記載の保存した字だけを送り、引用が字にある項目だけを案にする（欄は引用の中の字だけ）。保存しない', async () => {
    const s = await setup({
      orderTranscribe: () => ({
        ok: true,
        answer: T([
          { category: 'respiratory', quote: 'NPPV IPAP 10 / EPAP 5 で継続。', ...blank, interval: '', action: 'continue' },
          { category: 'prn', quote: '不穏時 頓用薬Aを1回投与。', ...blank, condition: '不穏時', drug: '頓用薬A', dose: '2錠' },
          { category: 'test', quote: '明朝 採血（血算・生化学）。', ...blank },
          { category: 'call', quote: '収縮期血圧 80 未満でコール', ...blank },
          { category: 'not_an_order', quote: '【架空】経過。', ...blank },
        ]),
      }),
    });
    const sourceId = await s.add(`${NAME}さん。\n${NOTE}`, '2026-11-20T11:00');
    const before = usage(s);
    const r = await s.call('POST', `/api/encounters/${s.enc}/orders/transcribe`, { sourceId });
    expect(r.status).toBe(200);
    expect(usage(s)).toBe(before + 1);
    // 送ったのは、その記載の保存した字（名前は置き換えた後）だけ
    expect(s.organizer.transcribed).toHaveLength(1);
    expect(s.organizer.transcribed[0]).not.toContain(NAME);
    expect(s.organizer.transcribed[0]).toContain('NPPV IPAP 10');
    const body = (await r.json()) as { proposals: { category: string; text: string; drug: string; dose: string; condition: string; from: { start: number; end: number } }[]; counts: { notOrder: number; cleared: number; rejected: Record<string, number> } };
    expect(body.proposals.map((p) => [p.category, p.text])).toEqual([
      ['respiratory', 'NPPV IPAP 10 / EPAP 5 で継続。'],
      ['prn', '不穏時 頓用薬Aを1回投与。'],
      ['test', '明朝 採血（血算・生化学）。'],
    ]);
    // 引用の外の字（2錠）は空にして数える。記録にない引用は出さない
    expect(body.proposals[1]).toMatchObject({ condition: '不穏時', drug: '頓用薬A', dose: '' });
    expect(body.counts).toMatchObject({ notOrder: 1, cleared: 1, rejected: { quote_not_found: 1 } });
    // 保存しない
    expect(s.sheet()).toEqual([]);

    // 写した字そのままを入れる：選別を通さない（AI の回数も増えない）。元の字の場所が残る
    const seen = s.selector.seen.length;
    const used = usage(s);
    const p = body.proposals[0];
    const add = await s.call('POST', `/api/encounters/${s.enc}/orders`, { items: [{ ...withoutKey(p), start: null, end: null }] });
    expect(add.status).toBe(200);
    expect(s.selector.seen.length).toBe(seen);
    expect(usage(s)).toBe(used);
    expect(s.sheet()).toMatchObject([{ category: 'respiratory', text: 'NPPV IPAP 10 / EPAP 5 で継続。', origin: 'transcribed', edited: false, from: { sourceId, start: p?.from.start, end: p?.from.end }, status: 'active' }]);
    expect(s.w.db.raw.prepare('SELECT action, origin FROM order_edits').all()).toEqual([{ action: 'add', origin: 'transcribed' }]);

    // 写した項目でも、元の字にない字（直した字）は選別を通す
    const id = s.sheet()[0]?.id ?? '';
    const patched = await s.call('PATCH', `/api/encounters/${s.enc}/orders/${id}`, { fields: fields({ category: 'respiratory', text: `NPPV IPAP 10 / EPAP 5 で継続。${NAME}に確認`, action: 'continue' }) });
    expect(patched.status).toBe(200);
    expect(s.selector.seen.length).toBe(seen + 1);
    expect(s.sheet()[0]?.text).not.toContain(NAME);
    expect(s.sheet()[0]?.edited).toBe(true);
  });

  test('写した項目の元の字の場所が、その患者の文の外なら断る', async () => {
    const s = await setup();
    const sourceId = await s.add(NOTE, '2026-11-20T11:00');
    const r = await s.call('POST', `/api/encounters/${s.enc}/orders`, { items: [newItem({ origin: 'transcribed', text: 'x', from: { sourceId, start: 0, end: 99_999 } })] });
    expect(r.status).toBe(400);
    expect(s.sheet()).toEqual([]);
  });
});

describe('指示簿を組み立てる（段K11）', () => {
  test('先生が打った字は選別を通す（名前は置き換えた後の字だけを残す）。中止・再開は直した記録に残る（文なし）', async () => {
    const s = await setup();
    const r = await s.call('POST', `/api/encounters/${s.enc}/orders`, { items: [newItem({ text: `${NAME}は ベッド上安静` }), newItem({ category: 'diet', text: '絶食' })] });
    expect(r.status).toBe(200);
    expect(s.selector.seen.at(-1)).toContain(NAME);
    const items = s.sheet();
    expect(items.map((i) => [i.category, i.origin, i.status])).toEqual([
      ['rest', 'self', 'active'],
      ['diet', 'self', 'active'],
    ]);
    expect(items[0]?.text).not.toContain(NAME);
    const id = items[1]?.id ?? '';
    expect((await s.call('PATCH', `/api/encounters/${s.enc}/orders/${id}`, { status: 'stopped' })).status).toBe(200);
    expect(s.sheet()[1]).toMatchObject({ status: 'stopped', stoppedAt: '2026-11-20T12:00' });
    expect((await s.call('PATCH', `/api/encounters/${s.enc}/orders/${id}`, { status: 'active' })).status).toBe(200);
    expect(s.sheet()[1]).toMatchObject({ status: 'active', stoppedAt: null });
    expect(s.sheet()[1]?.history.map((h) => h.action)).toEqual(['add', 'stop', 'restart']);
    const edits = s.w.db.raw.prepare('SELECT * FROM order_edits ORDER BY rowid').all() as Record<string, unknown>[];
    expect(edits.map((e) => e['action'])).toEqual(['add', 'add', 'stop', 'restart']);
    // 直した記録には文が入らない
    expect(Object.keys(edits[0] ?? {}).sort()).toEqual(['action', 'at', 'encounter_id', 'id', 'item_id', 'origin', 'patient_id']);
    expect((await s.call('DELETE', `/api/encounters/${s.enc}/orders/${id}`)).status).toBe(200);
    expect(s.sheet()).toHaveLength(1);
  });

  test('終わりが開始より前・点滴でないのにスケールは断る。字のない項目は選別を呼ばない', async () => {
    const s = await setup();
    const seen = s.selector.seen.length;
    expect((await s.call('POST', `/api/encounters/${s.enc}/orders`, { items: [newItem({ start: '2026-11-21T10:00', end: '2026-11-20T10:00' })] })).status).toBe(400);
    expect((await s.call('POST', `/api/encounters/${s.enc}/orders`, { items: [newItem({ scale: { templateId: 'x', template: TEMPLATE, weightKg: null, step: null } })] })).status).toBe(400);
    expect(s.selector.seen.length).toBe(seen);
  });

  test('スケールの点滴：体重と段は数だけで直す（選別なし）。テンプレを直しても、入れた指示の中身は変わらない', async () => {
    const s = await setup();
    const t = await s.call('POST', '/api/order-templates', TEMPLATE);
    const templateId = ((await t.json()) as { id: string }).id;
    const r = await s.call('POST', `/api/encounters/${s.enc}/orders`, {
      items: [newItem({ category: 'infusion', text: '架空の薬B 持続（スケール）', drug: '架空の薬B', start: '2026-11-20T13:00', scale: { templateId, template: TEMPLATE, weightKg: null, step: null } })],
    });
    expect(r.status).toBe(200);
    const id = s.sheet()[0]?.id ?? '';
    const seen = s.selector.seen.length;
    expect((await s.call('PATCH', `/api/encounters/${s.enc}/orders/${id}`, { weightKg: 60, step: 1 })).status).toBe(200);
    expect(s.selector.seen.length).toBe(seen);
    expect(s.sheet()[0]?.scale).toMatchObject({ weightKg: 60, step: 1 });
    // 段がテンプレの段の数の外なら断る
    expect((await s.call('PATCH', `/api/encounters/${s.enc}/orders/${id}`, { weightKg: 60, step: 5 })).status).toBe(400);
    await s.call('PATCH', `/api/order-templates/${templateId}`, { ...TEMPLATE, amount: 4 });
    expect(s.sheet()[0]?.scale?.template.amount).toBe(2);
  });
});

describe('AI の案（段K11。CA-076）', () => {
  test('用量を含む案。資料にない数は※（unseen）、テンプレを指した案の流量は落とす、根拠のない案は出さない。保存しない。採用した案の字は選別を通す', async () => {
    const answer: ProposeAnswer = {
      items: [
        { category: 'oral', text: '架空の薬C 1回 7 mg 継続', ...blank, drug: '架空の薬C', dose: '1回 7 mg', action: 'continue', template: '', basis: ['P1'] },
        { category: 'infusion', text: '架空の薬B をスケールで', ...blank, drug: '架空の薬B', rate: '3 mL/h', template: 'X1', basis: ['X1'] },
        { category: 'diet', text: '絶食', ...blank, template: '', basis: ['Q9'] },
      ],
    };
    const s = await setup({
      problemList: () => ({ ok: true, answer: { items: [{ name: '架空の肺炎', certainty: 'diagnosis', activity: 'active', basis: '発熱', threads: [], course: ['C1'] }] } }),
      orderPropose: () => ({ ok: true, answer }),
    });
    await s.add(`${NAME}さん。\n${NOTE}`, '2026-11-20T11:00');
    await s.call('POST', '/api/order-templates', TEMPLATE);
    await s.call('POST', `/api/patients/${s.patientId}/problem-list`, {});
    const before = usage(s);
    const r = await s.call('POST', `/api/encounters/${s.enc}/orders/propose`, { categories: [] });
    expect(r.status).toBe(200);
    expect(usage(s)).toBe(before + 1);
    expect(s.organizer.proposed[0]).not.toContain(NAME);
    expect(s.organizer.proposed[0]).toContain('試験用スケール');
    const body = (await r.json()) as { proposals: { category: string; rate: string; unseen: string[]; scale: { templateId: string; weightKg: null } | null; basis: { id: string; label: string }[]; origin: string }[]; counts: { rejected: Record<string, number> } };
    expect(body.proposals.map((p) => p.category)).toEqual(['oral', 'infusion']);
    expect(body.proposals[0]?.unseen).toEqual(['7']);
    expect(body.proposals[0]?.origin).toBe('ai');
    expect(body.proposals[1]).toMatchObject({ rate: '', scale: { weightKg: null } });
    expect(body.counts.rejected).toMatchObject({ rate_dropped: 1, unknown_ref: 1, ungrounded: 1 });
    expect(s.sheet()).toEqual([]);

    // 採用：AI の字（根拠の名前も）は選別を通してから残す。※の数も残す
    const seen = s.selector.seen.length;
    const add = await s.call('POST', `/api/encounters/${s.enc}/orders`, { items: [{ ...withoutKey(body.proposals[0]), start: null, end: null }] });
    expect(add.status).toBe(200);
    expect(s.selector.seen.length).toBe(seen + 1);
    expect(s.sheet()[0]).toMatchObject({ origin: 'ai', unseen: ['7'], dose: '1回 7 mg' });
    expect(s.sheet()[0]?.basis[0]?.label).toContain('架空の肺炎');
  });

  test('頼んでいない欄の案は出さない。1日の上限なら AI を呼ばない。記録がなければ呼ばない', async () => {
    const s = await setup({ orderPropose: () => ({ ok: true, answer: { items: [{ category: 'diet', text: '絶食', ...blank, template: '', basis: ['P1'] }] } }) });
    expect((await s.call('POST', `/api/encounters/${s.enc}/orders/propose`, { categories: [] })).status).toBe(422);
    expect(s.organizer.proposed).toEqual([]);
    await s.add(NOTE, '2026-11-20T11:00');
    const r = await s.call('POST', `/api/encounters/${s.enc}/orders/propose`, { categories: ['test'] });
    const body = (await r.json()) as { proposals: unknown[]; counts: { rejected: Record<string, number> } };
    expect(body.proposals).toEqual([]);
    expect(body.counts.rejected).toMatchObject({ category: 1 });

    const limited = await setup({}, { dailyAiLimit: 1 });
    await limited.add(NOTE, '2026-11-20T11:00');
    expect((await limited.call('POST', `/api/encounters/${limited.enc}/orders/propose`, { categories: [] })).status).toBe(429);
    expect(limited.organizer.proposed).toEqual([]);
  });
});

describe('テンプレ（段K11。CA-075）', () => {
  test('識別情報の形は断る。患者に付かない（表に患者の列がない）。外すと一覧から消える', async () => {
    const s = await setup();
    const phone = ['090', '1234', '5678'].join('-');
    expect((await s.call('POST', '/api/order-templates', { ...TEMPLATE, note: phone })).status).toBe(422);
    expect((await s.call('POST', '/api/order-templates', { ...TEMPLATE, doseUnit: 'mg/週' })).status).toBe(400);
    const r = await s.call('POST', '/api/order-templates', TEMPLATE);
    const id = ((await r.json()) as { id: string }).id;
    const columns = (s.w.db.raw.prepare('PRAGMA table_info(order_templates)').all() as { name: string }[]).map((c) => c.name);
    expect(columns.sort()).toEqual(['body', 'created_at', 'id', 'removed_at', 'updated_at']);
    expect((await s.record()).orderTemplates.map((t) => t.body.name)).toEqual(['試験用スケール']);
    expect((await s.call('DELETE', `/api/order-templates/${id}`)).status).toBe(200);
    expect((await s.record()).orderTemplates).toEqual([]);
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM order_templates').get()).toEqual({ n: 1 });
  });
});

describe('結果待ちへの結びつけ（段K11。CA-078）', () => {
  test('指示簿の検査の予定（O…）を同じ1回で渡し、後の記録の結果を結びつける（一覧ではなく orders に）。予定より前の結果は入れない', async () => {
    const s = await setup({
      pending: (message) => {
        const m = JSON.parse(message) as { orders?: { ref: string; name: string }[]; course: { ref: string; summary: string }[] };
        const o = m.orders?.[0]?.ref ?? '';
        const c = m.course.find((x) => x.summary === '採血結果')?.ref ?? '';
        return { ok: true, answer: { items: [{ id: o, status: 'resulted', results: [c] }] } };
      },
    });
    await s.add(NOTE, '2026-11-20T11:00');
    await s.call('POST', `/api/encounters/${s.enc}/orders`, { items: [newItem({ category: 'test', text: '明朝 採血（血算・生化学）', start: '2026-11-21T06:00' })] });
    await s.add(RESULT, '2026-11-21T09:00');
    const r = await s.call('POST', `/api/patients/${s.patientId}/pending`, {});
    expect(r.status).toBe(200);
    const sent = JSON.parse(s.organizer.pended[0] ?? '{}') as { orders: { ref: string; name: string; at: string }[] };
    expect(sent.orders).toEqual([{ ref: 'O1', name: '明朝 採血（血算・生化学）', interval: '', at: '2026-11-21 06:00' }]);
    const rec = await s.record();
    const id = s.sheet()[0]?.id ?? '';
    // 結果待ちの一覧（提出の記載）には、指示簿の予定を出さない
    expect(rec.pending?.body.items.map((i) => i.name)).not.toContain('明朝 採血（血算・生化学）');
    expect(rec.pending?.body.orders).toMatchObject([{ orderId: id, state: 'resulted', results: [{ kind: 'course', label: '経過「採血結果」', at: '2026-11-21T09:00' }] }]);
    expect(rec.pending?.basis).toContain(`|o:${id}@`);

    // 予定の日時より前の結果は結びつけない
    await s.call('PATCH', `/api/encounters/${s.enc}/orders/${id}`, { fields: fields({ category: 'test', text: '明朝 採血（血算・生化学）', start: '2026-11-22T06:00' }) });
    await s.call('POST', `/api/patients/${s.patientId}/pending`, {});
    expect((await s.record()).pending?.body.orders).toMatchObject([{ orderId: id, state: 'unsorted', results: [] }]);
  });
});

describe('患者を消す', () => {
  test('指示簿と直した記録は消え、テンプレ（患者に付かない）は残る', async () => {
    const s = await setup();
    await s.call('POST', '/api/order-templates', TEMPLATE);
    await s.call('POST', `/api/encounters/${s.enc}/orders`, { items: [newItem()] });
    expect((await s.call('DELETE', `/api/patients/${s.patientId}`)).status).toBe(200);
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM order_sheets').get()).toEqual({ n: 0 });
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM order_edits').get()).toEqual({ n: 0 });
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM order_templates').get()).toEqual({ n: 1 });
  });
});
