// 段5（CA-030〜035）：A/P の記録（これまでに残したもの）・参照元（書籍）。AI と RAG は試験の代役。カルテ記載（段I）は documents.test.ts
import type { OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { ragSearcherOf } from '../src/index.ts';
import { type BookHit, type BookSearcher, createRagSearcher } from '../src/references.ts';
import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '花子'].join('');
const NOTE = `${NAME}さん。\n#1 市中肺炎\nS) 咳は減った\nO) 体温 37.1\nA) 抗菌薬に反応\nP) セフトリアキソン 2g 継続`;
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 市中肺炎', when: null },
    { label: 'subjective', start: 'S) 咳', when: null },
    { label: 'objective', start: 'O) 体温', when: null },
    { label: 'assessment', start: 'A) 抗菌薬', when: null },
    { label: 'plan', start: 'P) セフ', when: null },
  ],
  problems: [{ name: '#1 市中肺炎', status: 'diagnosis', activity: null }],
};

interface Rec {
  problemThreads: { id: string }[];
  apNotes: { id: string; text: string; origin: string; part: string; planKind: string | null; refs: unknown[]; day: string }[];
}

class FakeBooks implements BookSearcher {
  readonly asked: (readonly string[])[] = [];
  constructor(private readonly hits: readonly BookHit[]) {}
  search(queries: readonly string[]): Promise<readonly BookHit[]> {
    this.asked.push(queries);
    return Promise.resolve(this.hits);
  }
  check(): Promise<'ok'> {
    return Promise.resolve('ok');
  }
}


async function setup(docs: FakeDocAnswers = {}, overrides: Parameters<typeof world>[0] = {}) {
  const organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, docs);
  const selector = fakeSelector([{ kind: 'person', quote: NAME }]);
  const w = world({ selector, organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-17T22:10' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-19T09:00', text: NOTE } });
  const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
  await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
  const record = async (): Promise<Rec> => (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as Rec;
  const threadId = (await record()).problemThreads[0]?.id ?? '';
  return { w, cookie, organizer, selector, encounterId: created.encounter.id, patientId: created.patient.id, threadId, record };
}

describe('A/P を残す', () => {
  test('本人が書いた A/P は、選別を通して残る（名前は置き換わる）。直すと選別をまた通り、消すと履歴に残る（文は残さない）', async () => {
    const s = await setup();
    const add = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-notes`, {
      cookie: s.cookie,
      body: {
        notes: [
          { encounterId: s.encounterId, threadId: s.threadId, day: '2026-11-19', part: 'assessment', planKind: null, text: `${NAME}さんは改善傾向`, origin: 'self', refs: [] },
          { encounterId: s.encounterId, threadId: s.threadId, day: '2026-11-19', part: 'plan', planKind: 'tx', text: '抗菌薬を継続', origin: 'self', refs: [] },
        ],
      },
    });
    expect(add.status).toBe(200);
    // 2つの文を、1回の選別で通す
    expect(s.selector.seen.filter((t) => t.includes('改善傾向'))).toHaveLength(1);
    let r = await s.record();
    expect(r.apNotes.map((n) => n.text).sort()).toEqual(['〔氏名〕さんは改善傾向', '抗菌薬を継続'].sort());
    expect(r.apNotes.every((n) => n.origin === 'self')).toBe(true);
    const plan = r.apNotes.find((n) => n.part === 'plan');
    expect((await s.w.call('PATCH', `/api/ap-notes/${plan?.id ?? ''}`, { cookie: s.cookie, body: { text: `抗菌薬を継続（${NAME}）` } })).status).toBe(200);
    expect((await s.w.call('PATCH', `/api/ap-notes/${plan?.id ?? ''}`, { cookie: s.cookie, body: { planKind: 'dx' } })).status).toBe(200);
    r = await s.record();
    expect(r.apNotes.find((n) => n.id === plan?.id)).toMatchObject({ text: '抗菌薬を継続（〔氏名〕）', origin: 'self', planKind: 'dx' });
    expect((await s.w.call('DELETE', `/api/ap-notes/${plan?.id ?? ''}`, { cookie: s.cookie })).status).toBe(200);
    expect((await s.record()).apNotes).toHaveLength(1);
    const history = s.w.db.raw.prepare('SELECT * FROM ap_history ORDER BY at, id').all() as Record<string, unknown>[];
    expect(history.map((h) => h['action']).sort()).toEqual(['add', 'add', 'delete', 'edit', 'kind']); // 試験の時計は止まっているので、並びではなく中身で見る
    expect(Object.keys(history[0] ?? {}).sort()).toEqual(['action', 'at', 'id', 'note_id', 'origin', 'patient_id']);
  });

  test('AI の案から採用した A/P は印と参照（場所・題・頁・URL。本文なし）を持つ。直すと「AI 案を直した」になる', async () => {
    const s = await setup();
    const refs = [
      { k: 'record', sourceId: '01KAAAAAAAAAAAAAAAAAAAAAAA', start: 0, end: 4 },
      { k: 'book', title: '架空の内科学', page: '120', path: '呼吸器 > 肺炎' },
      { k: 'web', title: '架空のガイドライン', url: 'https://example.org/guideline' },
    ];
    // 開けない形の URL（javascript: など）は、参照にできない
    const script = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-notes`, {
      cookie: s.cookie,
      body: { notes: [{ encounterId: s.encounterId, threadId: s.threadId, day: '2026-11-19', part: 'plan', planKind: 'tx', text: '案', origin: 'ai', refs: [{ k: 'web', title: 'x', url: 'javascript:alert(1)' }] }] },
    });
    expect(script.status).toBe(400);
    const add = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-notes`, {
      cookie: s.cookie,
      body: { notes: [{ encounterId: s.encounterId, threadId: s.threadId, day: '2026-11-19', part: 'plan', planKind: 'tx', text: '経口への切り替えを検討する。', origin: 'ai', refs }] },
    });
    expect(add.status).toBe(200);
    const note = (await s.record()).apNotes[0];
    expect(note).toMatchObject({ origin: 'ai', refs });
    // 参照に本文（抜き出し・引用の字）を入れられない
    const withText = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-notes`, {
      cookie: s.cookie,
      body: { notes: [{ encounterId: s.encounterId, threadId: s.threadId, day: '2026-11-19', part: 'plan', planKind: 'tx', text: '案', origin: 'ai', refs: [{ ...refs[1], snippet: '本文' }] }] },
    });
    expect(withText.status).toBe(400);
    // 「直した」は、本人だけが付けられない印（origin に ai_edited を送れない）
    const fake = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-notes`, {
      cookie: s.cookie,
      body: { notes: [{ encounterId: s.encounterId, threadId: s.threadId, day: '2026-11-19', part: 'plan', planKind: 'tx', text: '案', origin: 'ai_edited', refs: [] }] },
    });
    expect(fake.status).toBe(400);
    await s.w.call('PATCH', `/api/ap-notes/${note?.id ?? ''}`, { cookie: s.cookie, body: { text: '経口への切り替えを、明日検討する。' } });
    expect((await s.record()).apNotes[0]).toMatchObject({ origin: 'ai_edited', text: '経口への切り替えを、明日検討する。' });
  });

  test('ほかの患者の筋・ほかの受診には残せない。選別が失敗したら、何も残さない', async () => {
    const s = await setup();
    const other = (await (await s.w.call('POST', '/api/patients', { cookie: s.cookie, body: { age: 50, ageOn: '2026-11-20', sex: 'female', encounter: { kind: 'outpatient', start: '2026-11-20T10:00' } } })).json()) as {
      encounter: { id: string };
    };
    const theirs = await s.w.call('POST', `/api/encounters/${other.encounter.id}/ap-notes`, {
      cookie: s.cookie,
      body: { notes: [{ encounterId: other.encounter.id, threadId: s.threadId, day: '2026-11-20', part: 'assessment', planKind: null, text: '評価', origin: 'self', refs: [] }] },
    });
    expect(theirs.status).toBe(404);
    const mismatch = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-notes`, {
      cookie: s.cookie,
      body: { notes: [{ encounterId: other.encounter.id, threadId: s.threadId, day: '2026-11-20', part: 'assessment', planKind: null, text: '評価', origin: 'self', refs: [] }] },
    });
    expect(mismatch.status).toBe(400);

    const failing = await setup({}, { selector: fakeSelector([], (text) => (text === '評価' ? { ok: false, reason: 'unavailable' } : { ok: true, answer: { identifiers: [] } })) });
    const r = await failing.w.call('POST', `/api/encounters/${failing.encounterId}/ap-notes`, {
      cookie: failing.cookie,
      body: { notes: [{ encounterId: failing.encounterId, threadId: failing.threadId, day: '2026-11-19', part: 'assessment', planKind: null, text: '評価', origin: 'self', refs: [] }] },
    });
    expect(r.status).toBe(502);
    expect(failing.w.db.raw.prepare('SELECT COUNT(*) AS n FROM ap_notes').get()).toEqual({ n: 0 });
  });
});

describe('書籍の検索（RAG）', () => {
  test('/api/search に、合鍵と問題の名前だけを送り、題・頁・抜き出しを受ける。失敗は空', async () => {
    const asked: { url: string; auth: string | null; body: unknown }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      const request = new Request(url, init);
      asked.push({ url: request.url, auth: request.headers.get('authorization'), body: await request.json() });
      return new Response(JSON.stringify({ results: [{ book_title: '架空の内科学', path: '呼吸器', page_label: '120', snippet: 'あ'.repeat(500), text: '本文はここに来ない' }] }), { status: 200 });
    };
    const searcher = createRagSearcher({ url: 'https://medbook-rag.internal', token: 'test-token', fetcher });
    const hits = await searcher.search(['#1 市中肺炎']);
    expect(asked).toEqual([{ url: 'https://medbook-rag.internal/api/search', auth: 'Bearer test-token', body: { queries: ['#1 市中肺炎'], parents: 6 } }]);
    expect(hits).toEqual([{ title: '架空の内科学', path: '呼吸器', page: '120', snippet: 'あ'.repeat(240) }]);
    const failing = createRagSearcher({ url: 'https://medbook-rag.internal', token: 't', fetcher: () => Promise.resolve(new Response('', { status: 401 })) });
    expect(await failing.search(['x'])).toEqual([]);
  });

  test('バインディングかトークンがなければ、書籍を参照元にしない', () => {
    const binding = { fetch: () => Promise.resolve(new Response('{}')) };
    expect(ragSearcherOf({})).toBeNull();
    expect(ragSearcherOf({ RAG: binding })).toBeNull();
    expect(ragSearcherOf({ RAG: binding, RAG_TOKEN: '  ' })).toBeNull();
    expect(ragSearcherOf({ RAG_TOKEN: 't' })).toBeNull();
    expect(ragSearcherOf({ RAG: binding, RAG_TOKEN: 't' })).not.toBeNull();
  });
});

describe('書籍のつながりの確かめ', () => {
  test('設定がなければ off。あれば、決めた一般の語だけで1回検索し、ok・鍵が違う・つながらないを返す', async () => {
    const off = await setup();
    expect(await (await off.w.call('GET', '/api/references', { cookie: off.cookie })).json()).toEqual({ books: 'off' });
    const on = await setup({}, { books: new FakeBooks([]) });
    expect(await (await on.w.call('GET', '/api/references', { cookie: on.cookie })).json()).toEqual({ books: 'ok' });

    const sent: unknown[] = [];
    const answer = (status: number) =>
      createRagSearcher({
        url: 'https://medbook-rag.internal',
        token: 't',
        fetcher: async (url, init) => {
          sent.push(await new Request(url, init).json());
          return new Response('{}', { status });
        },
      });
    expect(await answer(200).check()).toBe('ok');
    expect(await answer(401).check()).toBe('unauthorized');
    expect(await answer(500).check()).toBe('unavailable');
    expect(await createRagSearcher({ url: 'https://medbook-rag.internal', token: 't', fetcher: () => Promise.reject(new Error('x')) }).check()).toBe('unavailable');
    expect(sent[0]).toEqual({ queries: ['肺炎'], parents: 1 });
  });

  test('登録していない端末には答えない', async () => {
    const s = await setup({}, { books: new FakeBooks([]) });
    expect((await s.w.call('GET', '/api/references')).status).toBe(401);
  });
});
