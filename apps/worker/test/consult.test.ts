// 段M（CA-081）：相談の窓口。記録と、書籍・ネットの出典から答え、確かめて返す。保存しない（問い・前のやりとり・答えの字は、どの表にも残らない）。
// 外の検索（書籍・ネット）に渡すのは、問題の名前と、問いから取り出して確かめた一般的な語だけ（問いの文・記録の字・数字は渡さない）。
// 残すのは、先生が「残す」を押した答えだけ（選別を通した後の字）。AI と RAG は試験の代役。文はすべて架空（synthetic）。
// 段M2：前の受診の記録も資料にする（CA-084）・確かめた文から順に返す（CA-085）・残した答えを直す（CA-083）と、その記録（文なし）。
import { type ConsultEvent, type ConsultNote, type ConsultReply, consultNoteRefs, consultNoteText, type OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { createRagSearcher } from '../src/references.ts';
import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '四郎'].join('');
const NOTE = `${NAME}さん。\n【現病歴】\n3日前の夕方から悪寒と発熱あり。\nCRP 12.4 と高値。\n#1 発熱\nA) 肺炎を疑う\nP) 抗菌薬を検討`;
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'present_illness', start: '【現病歴】', when: null },
    { label: 'problem_heading', start: '#1 発熱', when: null },
    { label: 'assessment', start: 'A) 肺炎', when: null },
    { label: 'plan', start: 'P) 抗菌薬', when: null },
  ],
  problems: [{ name: '#1 発熱', status: 'problem', activity: null }],
  measurements: [{ quote: 'CRP 12.4', when: null, specimen: null }],
};
const LIST: NonNullable<FakeDocAnswers['problemList']> = () => ({
  ok: true,
  answer: { items: [{ name: '市中肺炎疑い', certainty: 'suspected', activity: 'active', threads: ['T1'], course: [], basis: '発熱と、肺炎を疑うとの評価' }] },
});

const SNIPPET = '市中肺炎の診断では、胸部画像で浸潤影を確かめる。';
const QUESTION = '81歳、CRP 12.4 のこの方の抗菌薬はいつまで続ける？（架空の問い・照合用）';

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

async function setup(docs: FakeDocAnswers = {}, overrides: Parameters<typeof world>[0] = {}, options: { list?: boolean; note?: boolean } = {}) {
  const organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, { problemList: LIST, ...docs });
  const w = world({ selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 81, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  let sourceId = '';
  if (options.note !== false) {
    const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'admission_note', authorRole: 'self', at: '2026-11-20T10:30', text: NOTE } });
    sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
    await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
    if (options.list !== false) await w.call('POST', `/api/patients/${created.patient.id}/problem-list`, { cookie, body: {} });
  }
  const consult = (body: unknown) => w.call('POST', `/api/patients/${created.patient.id}/consult`, { cookie, body });
  const keep = (body: unknown) => w.call('POST', `/api/patients/${created.patient.id}/consult-notes`, { cookie, body });
  const record = async () => (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as { consultNotes: ConsultNote[] };
  return { w, cookie, organizer, patientId: created.patient.id, sourceId, consult, keep, record };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const usage = (s: Setup): number => (s.w.db.raw.prepare('SELECT calls FROM usage_daily').get() as { calls: number } | undefined)?.calls ?? 0;

/** すべての表のすべての行（問いの字が残っていないかを見る） */
function everything(s: Setup): string {
  const tables = (s.w.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  return JSON.stringify(tables.map((t) => s.w.db.raw.prepare(`SELECT * FROM ${t}`).all()));
}

/** 相談の答えの代役：資料の記号を使って、確かめに通る文と、通らない文を返す */
const CONSULT: NonNullable<FakeDocAnswers['consult']> = (message) => {
  const m = JSON.parse(message) as { records: { ref: string }[]; values: { ref: string }[] };
  const r1 = m.records[0]?.ref ?? '';
  return {
    ok: true,
    answer: {
      statements: [
        { section: 'treatment', text: '治療期間は、解熱と全身状態の改善を確かめて決める。', support: [r1], citations: ['B1'] },
        { section: 'summary', text: '発熱と CRP 12.4 の高値があり、肺炎を疑って抗菌薬を検討している。', support: [r1, m.values[0]?.ref ?? '', 'T9'], citations: [] },
        { section: 'treatment', text: 'セフトリアキソン 2 g/日 を 7 日間続ける。', support: [r1], citations: [] },
        { section: 'workup', text: '胸部画像の記載がないので、浸潤影の有無を確かめる。', support: [r1], citations: ['W1'] },
      ],
      unknown: '培養の結果の記載がなく、起因菌は分からない。',
    },
  };
};

describe('相談の窓口（段M）', () => {
  test('記録と出典から答え、確かめて返す。外の検索に渡すのは、問題の名前と、確かめた一般的な語だけ。問い・答えは、どの表にも残らない', async () => {
    const rag = ragFake();
    const s = await setup(
      {
        // 取り出した語のうち、数字・年齢・文の形・問題の名前と同じ語は、渡さない
        consultTerms: () => ({ ok: true, answer: { terms: ['抗菌薬 治療期間', '81歳', 'CRP 12.4', '市中肺炎疑い', 'いつまで続けるか？', '経口スイッチ'] } }),
        research: () => ({ ok: true, hits: [{ title: '架空の学会の指針', url: 'https://example.org/guideline', citedText: '市中肺炎では、胸部画像で浸潤影を確かめる。' }] }),
        consult: CONSULT,
      },
      { books: rag.books },
    );
    const tablesBefore = everything(s);
    const before = usage(s);
    const res = await s.consult({ question: QUESTION, turns: [{ question: '前の問い（架空）', answer: '前の答え（架空）' }], web: true, past: false });
    expect(res.status).toBe(200);
    const reply = ((await res.json()) as { answer: ConsultReply }).answer;
    // 1日の上限に数える：検索の語・ネットの検索・答えの 3 回
    expect(usage(s) - before).toBe(3);

    // 確かめ：用量のある出典なしの文は出さない。資料にない記号は根拠から外す。出典のない文には「（推論）」。見出しの順に並ぶ
    expect(reply.rejected).toEqual({ dose: 1, unknown_ref: 1 });
    expect(reply.statements.map((x) => x.section)).toEqual(['summary', 'workup', 'treatment']);
    const summary = reply.statements[0];
    expect(summary?.inferred).toBe(true);
    expect(summary?.text.endsWith('（推論）')).toBe(true);
    expect(summary?.marks).toEqual([]);
    expect(summary?.support.map((x) => x.id)).toHaveLength(2);
    const treatment = reply.statements[2];
    expect(treatment?.inferred).toBe(false);
    expect(treatment?.citations).toEqual([{ k: 'book', title: '架空の内科学', page: '120', path: '呼吸器 > 肺炎' }]);
    expect(reply.statements[1]?.citations).toEqual([{ k: 'web', title: '架空の学会の指針', url: 'https://example.org/guideline' }]);
    expect(reply.unknown).toContain('培養');
    // 何を外へ出したかを、答えと一緒に返す（画面に、いつも出す）
    expect(reply.research).toEqual({ books: 1, web: 1, webFailed: false, names: ['市中肺炎疑い'], terms: ['抗菌薬 治療期間', '経口スイッチ'] });

    // 語を取り出す係（Anthropic）に送るのは、問いと問題の名前だけ（記録は送らない）
    expect(s.organizer.termed.map((t) => JSON.parse(t) as unknown)).toEqual([{ problems: ['市中肺炎疑い'], question: QUESTION }]);
    // 外の検索（書籍・ネット）に渡すのは、問題の名前と、確かめた語だけ
    expect(rag.bodies.map((b) => JSON.parse(b) as unknown)).toEqual([{ queries: ['抗菌薬 治療期間', '経口スイッチ', '市中肺炎疑い'], parents: 6 }]);
    expect(s.organizer.researched).toEqual([JSON.stringify({ problems: ['市中肺炎疑い'], topics: ['抗菌薬 治療期間', '経口スイッチ'] })]);
    for (const sent of [...rag.bodies, ...s.organizer.researched]) {
      expect(sent).not.toContain('照合用');
      expect(sent).not.toContain('悪寒');
      expect(sent).not.toContain(NAME);
      expect(sent).not.toMatch(/[0-9]{2}/u);
    }
    // 答える係（Anthropic）に送る資料：記録から作ったもの（名前は置き換えた後）・出典の抜き出し・前のやりとり・問い
    const sent = JSON.parse(s.organizer.consulted[0] ?? '{}') as { question: string; conversation: unknown[]; records: { text: string }[]; references: { id: string }[]; problems: unknown[] };
    expect(sent.question).toBe(QUESTION);
    expect(sent.conversation).toEqual([{ question: '前の問い（架空）', answer: '前の答え（架空）' }]);
    expect(sent.records[0]?.text).toContain('悪寒と発熱');
    expect(sent.references.map((x) => x.id)).toEqual(['B1', 'W1']);
    expect(sent.problems).toHaveLength(1);
    expect(JSON.stringify(sent)).toContain(SNIPPET);
    expect(JSON.stringify(sent)).not.toContain(NAME);

    // 問い・答えの字は、どの表にも残らない（変わるのは、日ごとの回数だけ）
    const after = everything(s);
    expect(after).not.toContain('照合用');
    expect(after).not.toContain('前の問い');
    expect(after).not.toContain('治療期間');
    expect(after.replace(/"calls":\d+/gu, '')).toBe(tablesBefore.replace(/"calls":\d+/gu, ''));
    expect((await s.record()).consultNotes).toEqual([]);
  });

  test('書籍の設定がなく、ネットも頼まないときは、外を探さない（語も取り出さない）。答えは、すべて「（推論）」', async () => {
    const s = await setup({ consult: CONSULT });
    const before = usage(s);
    const res = await s.consult({ question: 'いまの方針をまとめて', turns: [], web: false, past: false });
    expect(res.status).toBe(200);
    const reply = ((await res.json()) as { answer: ConsultReply }).answer;
    expect(usage(s) - before).toBe(1);
    expect(s.organizer.termed).toEqual([]);
    expect(s.organizer.researched).toEqual([]);
    expect(reply.research).toEqual({ books: 0, web: 0, webFailed: false, names: [], terms: [] });
    // 出典がないので、出典の記号は根拠から外れ、残った文は、どれも推論
    expect(reply.statements.length).toBeGreaterThan(0);
    expect(reply.statements.every((x) => x.inferred && x.text.endsWith('（推論）'))).toBe(true);
  });

  test('語の取り出しが失敗しても、問題の名前だけで探して答える。プロブレムリストがなければ、記録に書かれた問題の名前で探す', async () => {
    const rag = ragFake();
    const s = await setup({ consultTerms: () => ({ ok: false, reason: 'unavailable' }), consult: CONSULT }, { books: rag.books });
    const res = await s.consult({ question: '方針は？', turns: [], web: false, past: false });
    expect(res.status).toBe(200);
    expect(rag.bodies.map((b) => JSON.parse(b) as unknown)).toEqual([{ queries: ['市中肺炎疑い'], parents: 6 }]);
    expect(((await res.json()) as { answer: ConsultReply }).answer.research.terms).toEqual([]);

    const rag2 = ragFake();
    const noList = await setup({ consult: CONSULT }, { books: rag2.books }, { list: false });
    expect((await noList.consult({ question: '方針は？', turns: [], web: false, past: false })).status).toBe(200);
    const queries = (JSON.parse(rag2.bodies[0] ?? '{}') as { queries: string[] }).queries;
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('発熱');
  });

  test('問い・前のやりとりに識別情報の形があれば、AI に送らない。空・長すぎ・形の違う頼みは 400', async () => {
    const s = await setup();
    const phone = ['090', '1234', '5678'].join('-');
    const r = await s.consult({ question: `${phone} に連絡する？`, turns: [], web: false, past: false });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'shape' });
    expect((await s.consult({ question: '方針は？', turns: [{ question: '前の問い', answer: `${phone} へ` }], web: false, past: false })).status).toBe(422);
    expect((await s.consult({ question: '', turns: [], web: false, past: false })).status).toBe(400);
    expect((await s.consult({ question: 'あ'.repeat(801), turns: [], web: false, past: false })).status).toBe(400);
    expect((await s.consult({ question: '方針は？', turns: [] })).status).toBe(400);
    expect((await s.consult({ question: '方針は？', turns: [], web: false })).status).toBe(400);
    expect((await s.consult({ question: '方針は？', turns: [], web: false, past: false, patient: 'x' })).status).toBe(400);
    expect(s.organizer.consulted).toEqual([]);
    expect(s.organizer.termed).toEqual([]);
  });

  test('記載がなければ AI を呼ばない。1日の上限に数える。鍵がなければ 503', async () => {
    const empty = await setup({}, {}, { note: false });
    const r = await empty.consult({ question: '方針は？', turns: [], web: false, past: false });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'consult_empty' });
    expect(empty.organizer.consulted).toEqual([]);

    const limited = await setup({}, { dailyAiLimit: 50 });
    limited.w.db.raw.exec('UPDATE usage_daily SET calls = 50');
    expect((await limited.consult({ question: '方針は？', turns: [], web: true, past: false })).status).toBe(429);
    expect(limited.organizer.consulted).toEqual([]);
    expect(limited.organizer.termed).toEqual([]);

    const none = world({ organizer: null });
    const { cookie } = await registered(none);
    expect((await none.call('POST', `/api/patients/${empty.patientId}/consult`, { cookie, body: { question: '方針は？', turns: [], web: false, past: false } })).status).toBe(503);
  });

  test('残すのは、先生が「残す」を押した答えだけ：選別を通した後の字と、参照（題・頁・URL・この患者の記録の場所）。消せる。患者を消すと消える', async () => {
    const rag = ragFake();
    const s = await setup({ consult: CONSULT }, { books: rag.books });
    const reply = ((await (await s.consult({ question: QUESTION, turns: [], web: false, past: false })).json()) as { answer: ConsultReply }).answer;
    const other = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
    const before = usage(s);
    const kept = await s.keep({
      mode: 'consult',
      text: `${consultNoteText(reply)}\n${NAME}さんの家族にも説明する。`,
      refs: [...consultNoteRefs(reply), { k: 'record', sourceId: s.sourceId, start: 0, end: 4 }, { k: 'record', sourceId: other, start: 0, end: 4 }],
    });
    expect(kept.status).toBe(200);
    // 残すときの選別の 1 回
    expect(usage(s) - before).toBe(1);
    const notes = (await s.record()).consultNotes;
    expect(notes).toHaveLength(1);
    const note = notes[0];
    expect(note?.mode).toBe('consult');
    expect(note?.text).toContain('【治療・方針】');
    expect(note?.text).toContain('（推論）');
    // 選別を通した後の字：名前は置き換わっている
    expect(note?.text).not.toContain(NAME);
    // 参照：出典の題・頁と、この患者の記録の場所だけ（ほかの文の id は残さない）
    expect(note?.refs).toEqual([{ k: 'book', title: '架空の内科学', page: '120', path: '呼吸器 > 肺炎' }, { k: 'record', sourceId: s.sourceId, start: 0, end: 4 }]);
    // 表に入るのは、決めた列だけ（問いの文の列はない）
    const rows = s.w.db.raw.prepare('SELECT * FROM consult_notes').all() as Record<string, unknown>[];
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['edited', 'entered_at', 'id', 'mode', 'patient_id', 'refs', 'text', 'updated_at']);
    expect(JSON.stringify(rows)).not.toContain('照合用');

    // 形の違う頼み（問いの文の欄など）は受け取らない。選別の鍵がなければ 503
    expect((await s.keep({ mode: 'consult', text: '答え', refs: [], question: QUESTION })).status).toBe(400);
    expect((await s.keep({ mode: 'other', text: '答え', refs: [] })).status).toBe(400);
    expect((await s.keep({ mode: 'record', text: '', refs: [] })).status).toBe(400);
    expect((await s.w.call('POST', '/api/patients/01HZZZZZZZZZZZZZZZZZZZZZZZ/consult-notes', { cookie: s.cookie, body: { mode: 'record', text: '答え', refs: [] } })).status).toBe(404);

    // 消す
    const id = note?.id ?? '';
    expect((await s.w.call('DELETE', `/api/consult-notes/${id}`, { cookie: s.cookie })).status).toBe(200);
    expect((await s.w.call('DELETE', `/api/consult-notes/${id}`, { cookie: s.cookie })).status).toBe(404);
    expect((await s.record()).consultNotes).toEqual([]);

    // 残した・消した記録（文は持たない）
    const log = s.w.db.raw.prepare('SELECT * FROM consult_note_history ORDER BY id').all() as Record<string, unknown>[];
    expect(log.map((r) => [r['action'], r['mode'], r['note_id']])).toEqual([['add', 'consult', id], ['delete', 'consult', id]]);
    expect(Object.keys(log[0] ?? {}).sort()).toEqual(['action', 'at', 'id', 'mode', 'note_id', 'patient_id']);

    // 患者を消すと、残した答えも、その記録も消える
    expect((await s.keep({ mode: 'record', text: '・K の補正は入院1日目から（架空）', refs: [] })).status).toBe(200);
    expect(s.w.db.raw.prepare('SELECT count(*) AS n FROM consult_notes').get()).toEqual({ n: 1 });
    expect((await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie })).status).toBe(200);
    expect(s.w.db.raw.prepare('SELECT count(*) AS n FROM consult_notes').get()).toEqual({ n: 0 });
    expect(s.w.db.raw.prepare('SELECT count(*) AS n FROM consult_note_history').get()).toEqual({ n: 0 });
  });

  test('選別が失敗したら、残さない', async () => {
    const organizer = fakeOrganizer();
    const w = world({ selector: { select: () => Promise.resolve({ ok: false, reason: 'unavailable' }) }, organizer });
    const { cookie } = await registered(w);
    const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 60, ageOn: '2026-11-20', sex: 'female', encounter: { kind: 'inpatient', start: '2026-11-20T10:00' } } })).json()) as { patient: { id: string } };
    const r = await w.call('POST', `/api/patients/${created.patient.id}/consult-notes`, { cookie, body: { mode: 'consult', text: '・答え（架空）', refs: [] } });
    expect(r.status).toBe(502);
    expect(w.db.raw.prepare('SELECT count(*) AS n FROM consult_notes').get()).toEqual({ n: 0 });
  });

  test('残した答えを直す（CA-083）：打った字を選別に通して置き換え、「先生が直した」の印と記録を残す。前の字は残らない', async () => {
    const s = await setup({ consult: CONSULT });
    expect((await s.keep({ mode: 'consult', text: '・まず胸部画像を確かめる（架空・直す前）', refs: [] })).status).toBe(200);
    const before = (await s.record()).consultNotes[0];
    expect(before?.edited).toBe(false);
    expect(before?.updatedAt).toBe(before?.enteredAt);
    const id = before?.id ?? '';
    const used = usage(s);
    const patched = await s.w.call('PATCH', `/api/consult-notes/${id}`, { cookie: s.cookie, body: { text: `・${NAME}さんは、胸部CT を先に確かめる（架空・直した後）` } });
    expect(patched.status).toBe(200);
    expect(usage(s) - used).toBe(1);
    const after = (await s.record()).consultNotes[0];
    expect(after?.edited).toBe(true);
    expect(after?.mode).toBe('consult');
    expect(after?.text).toContain('胸部CT を先に確かめる');
    // 選別を通した後の字（名前は置き換わる）。前の字は、どの表にも残らない
    expect(after?.text).not.toContain(NAME);
    expect(everything(s)).not.toContain('直す前');
    const log = s.w.db.raw.prepare('SELECT action, mode FROM consult_note_history ORDER BY id').all();
    expect(log).toEqual([{ action: 'add', mode: 'consult' }, { action: 'edit', mode: 'consult' }]);
    expect(JSON.stringify(s.w.db.raw.prepare('SELECT * FROM consult_note_history').all())).not.toContain('胸部');

    // 形の違う頼み・ない答え
    expect((await s.w.call('PATCH', `/api/consult-notes/${id}`, { cookie: s.cookie, body: { text: '' } })).status).toBe(400);
    expect((await s.w.call('PATCH', `/api/consult-notes/${id}`, { cookie: s.cookie, body: { text: '字', mode: 'record' } })).status).toBe(400);
    expect((await s.w.call('PATCH', '/api/consult-notes/01HZZZZZZZZZZZZZZZZZZZZZZZ', { cookie: s.cookie, body: { text: '字' } })).status).toBe(404);
  });

  test('前の受診の記録も資料にする（CA-084）：選んだときだけ、前の受診の記載が AI に渡る。答えに、範囲の数が付く', async () => {
    const s = await setup({ consult: CONSULT });
    // いまの受診の前に、外来の受診と記載を足す
    const older = (await (await s.w.call('POST', `/api/patients/${s.patientId}/encounters`, { cookie: s.cookie, body: { kind: 'outpatient', start: '2026-10-01T09:00' } })).json()) as { encounter: { id: string } };
    const saved = await s.w.call('POST', `/api/encounters/${older.encounter.id}/sources`, { cookie: s.cookie, body: { kind: 'outpatient_first', authorRole: 'self', at: '2026-10-01T09:30', text: '健診で胸部異常影を指摘された（架空の前の受診）。' } });
    expect(saved.status).toBe(200);

    const now = ((await (await s.consult({ question: '方針は？', turns: [], web: false, past: false })).json()) as { answer: ConsultReply }).answer;
    expect(now.scope).toEqual({ records: 1, encounters: 1, past: false });
    expect(s.organizer.consulted[0]).not.toContain('胸部異常影');

    const all = ((await (await s.consult({ question: '方針は？', turns: [], web: false, past: true })).json()) as { answer: ConsultReply }).answer;
    expect(all.scope).toEqual({ records: 2, encounters: 2, past: true });
    const sent = JSON.parse(s.organizer.consulted[1] ?? '{}') as { records: { text: string; encounter: string }[]; encounters: unknown[] };
    expect(sent.records.map((r) => r.encounter)).toEqual(['外来 2026-10-01 09:00〜', expect.stringContaining('入院') as string]);
    expect(sent.records[0]?.text).toContain('胸部異常影');
    expect(sent.encounters).toHaveLength(2);
  });

  test('確かめた文から順に返す（CA-085）：いま何をしているか → 確かめた後の文 → 最後の答え。出さない文・確かめる前の字は流れない。保存しない', async () => {
    const rag = ragFake();
    const s = await setup({ consultTerms: () => ({ ok: true, answer: { terms: ['経口スイッチ'] } }), consult: CONSULT }, { books: rag.books });
    const tablesBefore = everything(s);
    const res = await s.consult({ question: QUESTION, turns: [], web: false, past: false, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const raw = await res.text();
    const events = raw.trim().split('\n').map((l) => JSON.parse(l) as ConsultEvent);
    const stages = events.flatMap((e) => ('stage' in e ? [e.stage] : []));
    expect(stages).toEqual(['terms', 'references', 'answer']);
    const statements = events.flatMap((e) => ('statement' in e ? [e.statement] : []));
    const done = events.at(-1);
    if (done === undefined || !('done' in done)) throw new Error('最後の答えがない');
    // 流れた文は、書かれた順の、確かめに通った文（用量のある出典なしの文は流れない）。最後の答えは、同じ文を見出しの順に並べたもの
    expect(statements.map((x) => x.section)).toEqual(['treatment', 'summary', 'workup']);
    expect(raw).not.toContain('セフトリアキソン');
    expect(statements.find((x) => x.section === 'summary')?.text.endsWith('（推論）')).toBe(true);
    expect(done.done.statements.map((x) => x.section)).toEqual(['summary', 'workup', 'treatment']);
    expect(new Set(done.done.statements.map((x) => x.text))).toEqual(new Set(statements.map((x) => x.text)));
    // ネットを頼んでいないので、W1 を指した文は、出典の記号が外れて（数える）、推論の文として流れる
    expect(statements.find((x) => x.section === 'workup')?.inferred).toBe(true);
    expect(done.done.rejected).toEqual({ dose: 1, unknown_ref: 2 });
    expect(done.done.scope).toEqual({ records: 1, encounters: 1, past: false });
    // 保存しない（変わるのは、日ごとの回数だけ）
    expect(everything(s).replace(/"calls":\d+/gu, '')).toBe(tablesBefore.replace(/"calls":\d+/gu, ''));

    // 誤りは、名前だけを1行で返す（記載がない・上限）
    const empty = await setup({}, {}, { note: false });
    const e = await empty.consult({ question: '方針は？', turns: [], web: false, past: false, stream: true });
    expect((await e.text()).trim()).toBe(JSON.stringify({ error: 'consult_empty' }));
    const limited = await setup({}, { dailyAiLimit: 50 });
    limited.w.db.raw.exec('UPDATE usage_daily SET calls = 50');
    const l = await limited.consult({ question: '方針は？', turns: [], web: false, past: false, stream: true });
    expect((await l.text()).trim()).toBe(JSON.stringify({ error: 'ai_limit' }));
    // 識別情報の形・形の違う頼みは、流す前に断る
    expect((await s.consult({ question: `${['090', '1234', '5678'].join('-')} へ`, turns: [], web: false, past: false, stream: true })).status).toBe(422);
  });
});
