// 段5（CA-030〜035）：A/P の記録（本人・AI の案から採用）・A/P の案・議論・参照元（書籍とネット）。AI と RAG は試験の代役。
import type { OrganizeAnswer, ProposalAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { ragSearcherOf } from '../src/index.ts';
import { type BookHit, type BookSearcher, createRagSearcher } from '../src/references.ts';
import { EMPTY_ORGANIZE, type FakeApAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '花子'].join('');
const NOTE = `${NAME}さん。\n#1 市中肺炎\nS) 咳は減った\nO) 体温 37.1\nA) 抗菌薬に反応\nP) セフトリアキソン 2g 継続`;
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 市中肺炎' },
    { label: 'subjective', start: 'S) 咳' },
    { label: 'objective', start: 'O) 体温' },
    { label: 'assessment', start: 'A) 抗菌薬' },
    { label: 'plan', start: 'P) セフ' },
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
}

const BOOK: BookHit = { title: '架空の内科学', path: '呼吸器 > 肺炎', page: '120', snippet: '市中肺炎では、臨床の改善を見て、静注から経口へ切り替える。' };

async function setup(ap: FakeApAnswers = {}, overrides: Parameters<typeof world>[0] = {}) {
  const organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, undefined, ap);
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

const proposal: ProposalAnswer = {
  problems: [
    {
      problem: 'T1',
      assessment: [
        { text: '体温 37.1 で、抗菌薬に反応している。', cites: ['Q1', 'Q4'], basis: 'record' },
        { text: '体温 38.5 まで上がった。', cites: ['Q1'], basis: 'record' }, // 根拠にない数
      ],
      plan: [
        { text: 'セフトリアキソン 2g を継続する。', cites: ['Q2'], basis: 'record', kind: 'tx' },
        { text: '改善が続けば、経口への切り替えを検討する。', cites: ['B1'], basis: 'source', kind: 'tx' },
        { text: 'アモキシシリン 500mg に切り替える。', cites: ['B1'], basis: 'source', kind: 'tx' }, // 出典にない用量
        { text: '根拠のない方針。', cites: [], basis: 'inference', kind: 'other' },
      ],
    },
  ],
};

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

describe('A/P の案', () => {
  test('記録の引用と書籍を資料にし、確かめた文だけを返す（根拠にない数・根拠のない文は出さず、数だけ）。何も保存しない', async () => {
    const books = new FakeBooks([BOOK]);
    const s = await setup({ propose: () => ({ ok: true, answer: proposal }) }, { books });
    const before = s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM ap_notes').get();
    const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-proposal`, { cookie: s.cookie, body: { day: '2026-11-19', threadIds: [s.threadId], web: false } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      proposal: { problems: { assessment: { text: string; basis: string }[]; plan: { text: string; basis: string; kind: string; cites: { id: string; ref: { k: string } }[] }[] }[]; rejected: Record<string, number> };
      books: number;
      web: number;
    };
    const p = body.proposal.problems[0];
    expect(p?.assessment.map((x) => x.text)).toEqual(['体温 37.1 で、抗菌薬に反応している。']);
    expect(p?.plan.map((x) => [x.text, x.basis, x.kind])).toEqual([
      ['セフトリアキソン 2g を継続する。', 'record', 'tx'],
      ['改善が続けば、経口への切り替えを検討する。', 'source', 'tx'],
    ]);
    expect(p?.plan[1]?.cites[0]?.ref.k).toBe('book');
    expect(body.proposal.rejected).toEqual({ number: 2, no_cite: 1 });
    expect(body.books).toBe(1);
    expect(body.web).toBe(0);
    // 書籍に送ったのは、問題の名前だけ
    expect(books.asked).toEqual([['#1 市中肺炎']]);
    // AI に送った資料：記録の A・P・S・O の区切り（置き換えた後）と書籍の抜き出し。区切りの外の文（名前の行）は送らない
    const sent = s.organizer.proposed[0] ?? '';
    expect(sent).toContain('A) 抗菌薬に反応');
    expect(sent).toContain('O) 体温 37.1');
    expect(sent).toContain(BOOK.snippet);
    expect(sent).not.toContain(NAME);
    expect(sent).not.toContain('〔氏名〕さん');
    // ウェブ検索は頼まなければ呼ばない
    expect(s.organizer.researched).toHaveLength(0);
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM ap_notes').get()).toEqual(before);
  });

  test('ウェブ検索を頼むと、問題の名前だけを検索の係に渡し、引用を W の出典にする。AI の回数は2回に数える', async () => {
    const s = await setup({
      research: () => ({ ok: true, hits: [{ title: '架空のガイドライン', url: 'https://example.org/cap', citedText: '臨床的に安定すれば、経口抗菌薬へ切り替える。' }] }),
      propose: () => ({
        ok: true,
        answer: { problems: [{ problem: 'T1', assessment: [], plan: [{ text: '安定すれば経口への切り替えを検討する。', cites: ['W1'], basis: 'source', kind: 'tx' }] }] },
      }),
    });
    const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-proposal`, { cookie: s.cookie, body: { day: '2026-11-19', threadIds: [s.threadId], web: true } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { proposal: { problems: { plan: { cites: { ref: unknown }[] }[] }[] }; web: number; webFailed: boolean };
    expect(body.web).toBe(1);
    expect(body.webFailed).toBe(false);
    expect(body.proposal.problems[0]?.plan[0]?.cites[0]?.ref).toEqual({ k: 'web', title: '架空のガイドライン', url: 'https://example.org/cap' });
    expect(JSON.parse(s.organizer.researched[0] ?? '{}')).toEqual({ problems: ['#1 市中肺炎'] });
    expect(s.w.db.raw.prepare('SELECT calls FROM usage_daily').get()).toEqual({ calls: 2 + 2 }); // 取り込みの選別1回・整理1回＋検索1回・案1回
  });

  test('ウェブ検索が失敗しても、記録だけで案を作り、失敗したことを返す。AI の失敗は名前だけ', async () => {
    const s = await setup({ research: () => ({ ok: false, reason: 'unavailable' }), propose: () => ({ ok: true, answer: proposal }) });
    const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-proposal`, { cookie: s.cookie, body: { day: '2026-11-19', threadIds: [s.threadId], web: true } });
    expect(((await r.json()) as { webFailed: boolean }).webFailed).toBe(true);
    const bad = await setup({ propose: () => ({ ok: false, reason: 'refused' }) });
    const b = await bad.w.call('POST', `/api/encounters/${bad.encounterId}/ap-proposal`, { cookie: bad.cookie, body: { day: '2026-11-19', threadIds: [bad.threadId], web: false } });
    expect(b.status).toBe(422);
    expect(await b.json()).toEqual({ error: 'ai_refused' });
  });

  test('記載がまだない日・知らない筋では、AI を呼ばない。上限なら呼ばない', async () => {
    const s = await setup({ propose: () => ({ ok: true, answer: proposal }) });
    const early = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-proposal`, { cookie: s.cookie, body: { day: '2026-11-18', threadIds: [s.threadId], web: false } });
    expect(early.status).toBe(422);
    const unknown = await s.w.call('POST', `/api/encounters/${s.encounterId}/ap-proposal`, { cookie: s.cookie, body: { day: '2026-11-19', threadIds: ['01KAAAAAAAAAAAAAAAAAAAAAAA'], web: false } });
    expect(unknown.status).toBe(404);
    expect(s.organizer.proposed).toHaveLength(0);
    const limited = await setup({ propose: () => ({ ok: true, answer: proposal }) }, { dailyAiLimit: 2 }); // 取り込みの選別と整理で、2回を使い切る
    const r = await limited.w.call('POST', `/api/encounters/${limited.encounterId}/ap-proposal`, { cookie: limited.cookie, body: { day: '2026-11-19', threadIds: [limited.threadId], web: false } });
    expect(r.status).toBe(429);
    expect(limited.organizer.proposed).toHaveLength(0);
  });
});

describe('議論', () => {
  test('問いとやりとりを、資料と一緒に送り、確かめた答えだけを返す。何も保存しない。外の検索には問いを渡さない', async () => {
    const books = new FakeBooks([BOOK]);
    const s = await setup(
      {
        research: () => ({ ok: true, hits: [] }),
        discuss: () => ({
          ok: true,
          answer: {
            paragraphs: [
              { text: '改善が続けば、経口への切り替えは選択肢です。', cites: ['B1'], basis: 'source' },
              { text: '7 日で終えられます。', cites: ['B1'], basis: 'source' },
            ],
          },
        }),
      },
      { books },
    );
    const question = '経口に切り替えるのは早すぎるか、体温 37.1 で判断してよいか';
    const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/discuss`, {
      cookie: s.cookie,
      body: { threadId: s.threadId, day: '2026-11-19', web: true, question, history: [{ role: 'doctor', text: '前の問い' }, { role: 'ai', text: '前の答え' }] },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { discussion: { paragraphs: { text: string }[]; rejected: Record<string, number> } };
    expect(body.discussion.paragraphs.map((p) => p.text)).toEqual(['改善が続けば、経口への切り替えは選択肢です。']);
    expect(body.discussion.rejected).toEqual({ number: 1 });
    const sent = JSON.parse(s.organizer.discussed[0] ?? '{}') as { question: string; conversation: unknown[] };
    expect(sent.question).toBe(question);
    expect(sent.conversation).toHaveLength(2);
    // 外の検索（RAG・ウェブ）には、問いもやりとりも渡さない（問題の名前だけ）
    expect(books.asked).toEqual([['#1 市中肺炎']]);
    expect(s.organizer.researched[0]).not.toContain('37.1');
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM ap_notes').get()).toEqual({ n: 0 });
  });

  test('問い・やりとりに電話・メールなどの形があれば、送らない', async () => {
    const s = await setup();
    const phone = ['090', '1234', '5678'].join('-');
    const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/discuss`, {
      cookie: s.cookie,
      body: { threadId: s.threadId, day: '2026-11-19', web: false, question: `連絡先は ${phone}`, history: [] },
    });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'shape' });
    expect(s.organizer.discussed).toHaveLength(0);
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
