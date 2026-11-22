// 段K5（CA-059・CA-064）：AI の臨床支援。組み直す・確かめて残す・1日の上限・外の検索に渡すのは問題の名前だけ・患者を消すと消える。
// AI と RAG は試験の代役（RAG は本物の呼び出し方で、宛先だけ代役）。文はすべて架空（synthetic）。
import { type OrganizeAnswer, supportBasis, type SupportBody } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { createRagSearcher } from '../src/references.ts';
import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '次郎'].join('');
const NOTE = `${NAME}さん。\n【現病歴】\n3日前の夕方から悪寒と発熱あり。\n#1 発熱\nA) 肺炎を疑う\nP) 抗菌薬を検討`;
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'present_illness', start: '【現病歴】', when: null },
    { label: 'problem_heading', start: '#1 発熱', when: null },
    { label: 'assessment', start: 'A) 肺炎', when: null },
    { label: 'plan', start: 'P) 抗菌薬', when: null },
  ],
  problems: [{ name: '#1 発熱', status: 'problem', activity: null }],
  course: [{ quote: '3日前の夕方から悪寒と発熱あり', summary: '悪寒・発熱が出現', category: 'onset', when: '3日前の夕方', whenHint: { base: 'note', days: -3, hours: null, minutes: null, time: null, part: 'evening', spanDays: null } }],
};

const LIST: NonNullable<FakeDocAnswers['problemList']> = () => ({
  ok: true,
  answer: {
    items: [
      { name: '市中肺炎疑い', certainty: 'suspected', activity: 'active', threads: ['T1'], course: ['C1'], basis: '発熱と、肺炎を疑うとの評価' },
      { name: '発熱の既往', certainty: 'problem', activity: 'inactive', threads: [], course: ['C1'], basis: '' },
    ],
  },
});

const SNIPPET = '市中肺炎の診断では、胸部画像で浸潤影を確かめる。';

/** RAG の宛先の代役：届いた要求の本文を残し、決まった当たりを返す */
function ragFake() {
  const bodies: string[] = [];
  const books = createRagSearcher({
    url: 'https://medbook-rag.internal',
    token: 'test-token',
    fetcher: async (_url, init) => {
      bodies.push(typeof init.body === 'string' ? init.body : '');
      return Promise.resolve(new Response(JSON.stringify({ results: [{ book_title: '架空の内科学', page_label: '120', path: '呼吸器 > 肺炎', snippet: SNIPPET }] }), { status: 200 }));
    },
  });
  return { books, bodies };
}

async function setup(docs: FakeDocAnswers = {}, overrides: Parameters<typeof world>[0] = {}) {
  const organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, { problemList: LIST, ...docs });
  const w = world({ selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'admission_note', authorRole: 'self', at: '2026-11-20T10:30', text: NOTE } });
  const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
  await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
  const listed = await w.call('POST', `/api/patients/${created.patient.id}/problem-list`, { cookie, body: {} });
  const record = async () =>
    (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as {
      support: { madeAt: string; promptVersion: string; basis: string; body: SupportBody } | null;
      sources: { id: string; organized: string | null }[];
      problemList: { madeAt: string } | null;
    };
  const build = (web: boolean) => w.call('POST', `/api/patients/${created.patient.id}/support`, { cookie, body: { web } });
  return { w, cookie, organizer, patientId: created.patient.id, listedStatus: listed.status, record, build };
}

const usage = (s: Awaited<ReturnType<typeof setup>>): number => (s.w.db.raw.prepare('SELECT calls FROM usage_daily').get() as { calls: number }).calls;

describe('AI の臨床支援（段K5）', () => {
  test('活動中の問題について組み、確かめて残す。書籍とネットの検索に渡すのは問題の名前だけ。AI に送るのは記録から作った資料（名前は置き換えた後）と出典', async () => {
    const rag = ragFake();
    const s = await setup(
      {
        research: () => ({ ok: true, hits: [{ title: '架空の学会の指針', url: 'https://example.org/guideline', citedText: '市中肺炎では重症度を評価して治療の場を決める。' }] }),
        support: () => ({
          ok: true,
          answer: {
            problems: [
              {
                problem: 'P1',
                differentials: [
                  { name: '市中肺炎', reasoning: '悪寒・発熱の出現と、肺炎を疑うとの評価', support: ['C1', 'T1'], against: [], missing: '胸部画像の記載がない', citations: ['B1'], inference: false },
                  { name: '架空の病名', reasoning: '', support: ['T9'], against: [], missing: '', citations: [], inference: true },
                ],
                tests: [{ name: '胸部X線', why: '浸潤影の有無を確かめる', support: ['T1'], citations: ['B1'], inference: false }],
                guideline: [
                  { statement: '抗菌薬を検討している（重症度の評価の記載はない）', status: 'unclear', support: ['T1'], citations: ['W1'], inference: false },
                  { statement: 'セフトリアキソン 2 g/日 を始める', status: 'gap', support: ['T1'], citations: [], inference: true },
                ],
                criteria: [],
                notes: '',
              },
              { problem: 'P2', differentials: [], tests: [], guideline: [], criteria: [], notes: '活動中でない' },
            ],
          },
        }),
      },
      { books: rag.books },
    );
    expect(s.listedStatus).toBe(200);
    const before = usage(s);
    const res = await s.build(true);
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { support: SupportBody }).support;
    expect(body.rejected).toEqual({ unknown_ref: 1, dose: 1, not_active: 1 });
    expect(body.research).toEqual({ books: 1, web: 1, webFailed: false });
    // 1日の上限に数える：ネットの検索と、支援の 2 回
    expect(usage(s) - before).toBe(2);

    // 外へ出すのは問題の名前だけ（RAG の本文・ネットの検索の頼み）。記録の字・名前は入らない
    expect(rag.bodies.map((b) => JSON.parse(b) as unknown)).toEqual([{ queries: ['市中肺炎疑い'], parents: 6 }]);
    expect(s.organizer.researched).toEqual([JSON.stringify({ problems: ['市中肺炎疑い'] })]);
    for (const sent of [...rag.bodies, ...s.organizer.researched]) {
      expect(sent).not.toContain('悪寒');
      expect(sent).not.toContain(NAME);
      expect(sent).not.toContain('2026');
    }
    // AI に送る資料：記録から作ったもの（名前は置き換えた後）と、出典の抜き出し
    const sent = s.organizer.supported[0] ?? '';
    expect(sent).toContain('悪寒・発熱が出現');
    expect(sent).toContain(SNIPPET);
    expect(sent).not.toContain(NAME);

    const r = await s.record();
    expect(r.support?.promptVersion).toBe('support-1');
    expect(r.support?.basis).toBe(supportBasis(r.sources, r.problemList?.madeAt ?? null));
    const p = r.support?.body.problems[0];
    expect([p?.no, p?.name, p?.focus]).toEqual([1, '市中肺炎疑い', 'differential']);
    expect(p?.differentials.map((d) => d.name)).toEqual(['市中肺炎']);
    expect(p?.differentials[0]?.citations).toEqual([{ k: 'book', title: '架空の内科学', page: '120', path: '呼吸器 > 肺炎' }]);
    expect(p?.guideline.map((g) => [g.status, g.citations])).toEqual([['unclear', [{ k: 'web', title: '架空の学会の指針', url: 'https://example.org/guideline' }]]]);
    // 出典の本文は残さない
    expect(JSON.stringify(r.support)).not.toContain(SNIPPET);
    const row = s.w.db.raw.prepare('SELECT body FROM clinical_support').get() as { body: string };
    expect(row.body).not.toContain(SNIPPET);
    expect(row.body).not.toContain(NAME);
  });

  test('プロブレムリストに活動中の問題がなければ、AI を呼ばない。上限なら呼ばない。ネットを頼まなければ、書籍だけ', async () => {
    const organizer = fakeOrganizer();
    const w = world({ selector: fakeSelector(), organizer });
    const { cookie } = await registered(w);
    const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 50, ageOn: '2026-11-20', sex: 'female', encounter: { kind: 'er', start: '2026-11-20T10:00' } } })).json()) as { patient: { id: string } };
    expect((await w.call('POST', `/api/patients/${created.patient.id}/support`, { cookie, body: { web: false } })).status).toBe(422);
    expect((await w.call('POST', `/api/patients/${created.patient.id}/support`, { cookie, body: { web: 'yes' } })).status).toBe(400);
    expect(organizer.supported).toHaveLength(0);

    const s = await setup();
    const before = usage(s);
    expect((await s.build(false)).status).toBe(200);
    expect(usage(s) - before).toBe(1);
    expect(s.organizer.researched).toHaveLength(0);

    // 選別・整理・リストで 3 回。上限 3 なら、支援は呼ばない
    const limited = await setup({}, { dailyAiLimit: 3 });
    expect(limited.listedStatus).toBe(200);
    expect((await limited.build(false)).status).toBe(429);
    expect(limited.organizer.supported).toHaveLength(0);
  });

  test('AI が失敗したら、前の支援を残す。患者を消すと、支援も消える', async () => {
    let fail = false;
    const s = await setup({ support: () => (fail ? { ok: false, reason: 'unavailable' } : { ok: true, answer: { problems: [{ problem: 'P1', differentials: [], tests: [], guideline: [], criteria: [], notes: '補足の文' }] } }) });
    expect((await s.build(false)).status).toBe(200);
    fail = true;
    expect((await s.build(false)).status).toBe(502);
    expect((await s.record()).support?.body.problems[0]?.notes.text).toBe('補足の文');
    await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie });
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM clinical_support').get()).toEqual({ n: 0 });
  });
});
