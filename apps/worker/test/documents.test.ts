// 段I（CA-054）：カルテ記載。出す・相談して直す（保存しない）、残す・直す・消す（選別 C-1 を通す）。AI と RAG は試験の代役。架空症例だけ。
import type { OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import type { BookHit, BookSearcher } from '../src/references.ts';
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
const BOOK: BookHit = { title: '架空の内科学', path: '呼吸器 > 肺炎', page: '120', snippet: '市中肺炎では、臨床の改善を見て、静注から経口へ切り替える。' };

interface Doc {
  id: string;
  type: string;
  day: string;
  origin: string;
  sections: { key: string; text: string; refs: unknown[] }[];
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
  const documents = async (): Promise<Doc[]> => ((await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as { documents: Doc[] }).documents;
  return { w, cookie, organizer, selector, encounterId: created.encounter.id, patientId: created.patient.id, documents };
}

const count = (s: Awaited<ReturnType<typeof setup>>, table: string): unknown => s.w.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();

describe('出す（保存しない）', () => {
  test('種類と日で資料を作り、出来上がった記載を見出しの順に返す。書籍には問題の名前だけ。数の照らし合わせの表は数だけ。何も保存しない', async () => {
    const books = new FakeBooks([BOOK]);
    const s = await setup(
      {
        document: () => ({
          ok: true,
          answer: {
            sections: [
              { key: 'ap', text: '#1 市中肺炎\nA) 抗菌薬に反応。\nP) セフトリアキソン 2g 継続。経口への切り替えを検討（推論）', refs: ['R1', 'B1'] },
              { key: 's', text: '咳は減った', refs: ['R1'] },
            ],
          },
        }),
      },
      { books },
    );
    const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/documents/generate`, { cookie: s.cookie, body: { type: 'progress', day: '2026-11-19', web: false } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      document: { sections: { key: string; heading: string; text: string; refs: { k: string }[] }[] };
      backing: { body: string[]; when: string[] };
      refs: { id: string; kind: string; label: string }[];
      material: { records: number };
    };
    expect(body.document.sections.map((x) => [x.key, x.heading])).toEqual([
      ['s', 'S'],
      ['o', 'O'],
      ['ap', 'A/P'],
    ]);
    expect(body.document.sections[1]?.text).toBe('');
    expect(body.document.sections[2]?.refs.map((x) => x.k)).toEqual(['record', 'book']);
    expect(body.backing.body).toContain('37.1');
    expect(body.refs).toEqual([{ id: 'B1', kind: 'book', label: '架空の内科学 120（呼吸器 > 肺炎）' }]);
    expect(body.material.records).toBe(1);
    expect(books.asked).toEqual([['#1 市中肺炎']]);
    // AI に送った資料：保存した文（名前は置き換えた後）
    const sent = s.organizer.documented[0] ?? '';
    expect(sent).toContain('A) 抗菌薬に反応');
    expect(sent).not.toContain(NAME);
    expect(sent).toContain('プログレスノート');
    expect(s.organizer.researched).toHaveLength(0);
    expect(count(s, 'documents')).toEqual({ n: 0 });
    // 答えの中の数・文は、ログや表に残さない（書き込みは回数だけ）
    expect(s.w.db.raw.prepare('SELECT calls FROM usage_daily').get()).toEqual({ calls: 3 }); // 取り込みの選別・整理・記載
  });

  test('記録のない日・上限では、AI を呼ばない。AI の失敗は名前だけ。ウェブ検索は、問題の名前だけを渡す', async () => {
    const s = await setup();
    const early = await s.w.call('POST', `/api/encounters/${s.encounterId}/documents/generate`, { cookie: s.cookie, body: { type: 'admission', day: '2026-11-17', web: false } });
    expect(early.status).toBe(422);
    expect(await early.json()).toEqual({ error: 'document_empty' });
    expect(s.organizer.documented).toHaveLength(0);
    const limited = await setup({}, { dailyAiLimit: 2 });
    const r = await limited.w.call('POST', `/api/encounters/${limited.encounterId}/documents/generate`, { cookie: limited.cookie, body: { type: 'progress', day: '2026-11-19', web: false } });
    expect(r.status).toBe(429);
    const bad = await setup({ document: () => ({ ok: false, reason: 'refused' }) });
    const b = await bad.w.call('POST', `/api/encounters/${bad.encounterId}/documents/generate`, { cookie: bad.cookie, body: { type: 'progress', day: '2026-11-19', web: false } });
    expect(b.status).toBe(422);
    expect(await b.json()).toEqual({ error: 'ai_refused' });
    const web = await setup({ research: () => ({ ok: false, reason: 'unavailable' }) });
    const wr = await web.w.call('POST', `/api/encounters/${web.encounterId}/documents/generate`, { cookie: web.cookie, body: { type: 'progress', day: '2026-11-19', web: true } });
    expect(((await wr.json()) as { webFailed: boolean }).webFailed).toBe(true);
    expect(JSON.parse(web.organizer.researched[0] ?? '{}')).toEqual({ problems: ['#1 市中肺炎'] });
    const unknownType = await s.w.call('POST', `/api/encounters/${s.encounterId}/documents/generate`, { cookie: s.cookie, body: { type: 'letter', day: '2026-11-19', web: false } });
    expect(unknownType.status).toBe(400);
  });
});

describe('相談して直す（保存しない）', () => {
  test('いまの記載・やりとり・頼みを資料と一緒に送り、答えと直した記載を返す。答えの識別情報の形は伏せる。外の検索に頼みを渡さない', async () => {
    const books = new FakeBooks([BOOK]);
    const phone = ['090', '1234', '5678'].join('-');
    const s = await setup({ revise: () => ({ ok: true, answer: { reply: `短くしました ${phone}`, sections: [{ key: 's', text: '咳は軽減', refs: [] }] } }) }, { books });
    const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/documents/revise`, {
      cookie: s.cookie,
      body: { type: 'progress', day: '2026-11-19', web: false, sections: [{ key: 's', text: '咳は減った。' }], instruction: 'S を短くして。体温 37.1 も入れて', history: [{ role: 'doctor', text: '前の頼み' }, { role: 'ai', text: '前の答え' }] },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { reply: string; document: { sections: { key: string; text: string }[] } };
    expect(body.reply).toContain('短くしました');
    expect(body.reply).not.toContain(phone);
    expect(body.document.sections.find((x) => x.key === 's')?.text).toBe('咳は軽減');
    const sent = JSON.parse(s.organizer.revised[0] ?? '{}') as { instruction: string; conversation: unknown[]; current: { key: string; text: string }[] };
    expect(sent.instruction).toBe('S を短くして。体温 37.1 も入れて');
    expect(sent.conversation).toHaveLength(2);
    expect(sent.current[0]?.text).toBe('咳は減った。');
    expect(books.asked).toEqual([['#1 市中肺炎']]);
    expect(count(s, 'documents')).toEqual({ n: 0 });
  });

  test('いまの記載・頼み・やりとりに電話・メールなどの形があれば、送らない', async () => {
    const s = await setup();
    const phone = ['090', '1234', '5678'].join('-');
    for (const body of [
      { sections: [{ key: 's', text: `連絡 ${phone}` }], instruction: '直して', history: [] },
      { sections: [{ key: 's', text: '咳' }], instruction: `連絡先は ${phone}`, history: [] },
    ]) {
      const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/documents/revise`, { cookie: s.cookie, body: { type: 'progress', day: '2026-11-19', web: false, ...body } });
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({ error: 'shape' });
    }
    expect(s.organizer.revised).toHaveLength(0);
  });
});

describe('残す・直す・消す', () => {
  test('保存は選別を通す（名前は置き換わる）。AI が書いたまま・直した・先生が書いたの印。直すと「AI が書いて先生が直した」。履歴に文は残らない', async () => {
    const s = await setup();
    const save = (origin: 'ai' | 'self', edited: boolean, text: string) =>
      s.w.call('POST', `/api/encounters/${s.encounterId}/documents`, {
        cookie: s.cookie,
        body: { type: 'progress', day: '2026-11-19', sections: [{ key: 's', text, refs: [] }, { key: 'o', text: '', refs: [] }, { key: 'ap', text: '#1 市中肺炎\nA) 反応', refs: [{ k: 'book', title: '架空の内科学', page: '120', path: null }] }], origin, edited },
      });
    expect((await save('ai', false, `${NAME}さんは咳が減った`)).status).toBe(200);
    expect((await save('ai', true, '咳が減った')).status).toBe(200);
    expect((await save('self', false, '咳が減った')).status).toBe(200);
    const docs = await s.documents();
    expect(docs.map((d) => d.origin).sort()).toEqual(['ai', 'ai_edited', 'self']);
    const ai = docs.find((d) => d.origin === 'ai');
    expect(ai?.sections[0]?.text).toBe('〔氏名〕さんは咳が減った');
    expect(ai?.sections[1]?.text).toBe('');
    expect(ai?.sections[2]?.refs).toEqual([{ k: 'book', title: '架空の内科学', page: '120', path: null }]);
    // 選別に届いたのは、中身のある見出しだけ
    expect(s.selector.seen.at(-1)).not.toContain('――――\n\n――――');

    const patched = await s.w.call('PATCH', `/api/documents/${ai?.id ?? ''}`, { cookie: s.cookie, body: { sections: [{ key: 's', text: '咳は軽減', refs: [] }] } });
    expect(patched.status).toBe(200);
    expect((await s.documents()).find((d) => d.id === ai?.id)?.origin).toBe('ai_edited');
    const removed = await s.w.call('DELETE', `/api/documents/${ai?.id ?? ''}`, { cookie: s.cookie });
    expect(removed.status).toBe(200);
    expect((await s.documents()).length).toBe(2);
    // 試験の時計は止まっているので、並びではなく、中身の組で比べる
    const history = (s.w.db.raw.prepare('SELECT action, origin FROM document_history').all() as { action: string; origin: string | null }[]).map((h) => `${h.action}:${String(h.origin)}`).sort();
    expect(history).toEqual(['add:ai', 'add:ai_edited', 'add:self', 'delete:null', 'edit:ai_edited']);
    expect(JSON.stringify(s.w.db.raw.prepare('SELECT * FROM document_history').all())).not.toContain('咳');
  });

  test('知らない見出し・中身のない記載・選別の失敗では、何も残さない。患者を消すと、記載も消える', async () => {
    const s = await setup();
    const post = (sections: unknown) => s.w.call('POST', `/api/encounters/${s.encounterId}/documents`, { cookie: s.cookie, body: { type: 'progress', day: '2026-11-19', sections, origin: 'ai', edited: false } });
    expect((await post([{ key: 'zzz', text: 'a', refs: [] }])).status).toBe(400);
    expect((await post([{ key: 's', text: ' ', refs: [] }])).status).toBe(400);
    const failing = await setup({}, { selector: fakeSelector([], (text) => (text.includes('失敗させる') ? { ok: false, reason: 'unavailable' } : { ok: true, answer: { identifiers: [] } })) });
    const r = await failing.w.call('POST', `/api/encounters/${failing.encounterId}/documents`, { cookie: failing.cookie, body: { type: 'progress', day: '2026-11-19', sections: [{ key: 's', text: '失敗させる', refs: [] }], origin: 'ai', edited: false } });
    expect(r.status).toBe(502);
    expect(count(failing, 'documents')).toEqual({ n: 0 });
    expect((await post([{ key: 's', text: '咳', refs: [] }])).status).toBe(200);
    expect(count(s, 'documents')).toEqual({ n: 1 });
    await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie });
    expect(count(s, 'documents')).toEqual({ n: 0 });
    expect(count(s, 'document_history')).toEqual({ n: 0 });
  });
});

describe('数の照らし合わせの表（AI を使わない）', () => {
  test('種類と日から、資料の数だけを返す（本文は返さない）。AI は呼ばない', async () => {
    const s = await setup();
    const before = s.w.db.raw.prepare('SELECT calls FROM usage_daily').get();
    const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/documents/backing`, { cookie: s.cookie, body: { type: 'progress', day: '2026-11-19' } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { backing: { body: string[]; when: string[] } };
    expect(body.backing.body).toContain('37.1');
    expect(JSON.stringify(body)).not.toContain('抗菌薬');
    expect(s.organizer.documented).toHaveLength(0);
    expect(s.w.db.raw.prepare('SELECT calls FROM usage_daily').get()).toEqual(before);
  });
});
