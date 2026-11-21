// 記載と A/P の E2E（段5。CA-030〜035）：日ごとの S・O と値、自分で書く A/P、AI の案から選んで残す（印と参照）、直すと「AI 案を直した」、
// AI との議論（保存しない）から A・P に足す。AI と書籍の検索は試験の代役。文はすべて架空。
import type { OrganizeAnswer, ProposalAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { BookHit, BookSearcher } from '../../worker/src/references.ts';
import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, type FakeOrganizer, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NOTE = '#1 市中肺炎\nS) 咳は減った\nO) 体温 37.1\nA) 抗菌薬に反応\nP) セフトリアキソン 2g 継続';
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

// 解決と書かれた問題がある記載（A/P の案の、はじめの選び）
const NOTE2 = '#1 市中肺炎\nA) 抗菌薬に反応\n#2 低K血症\nA) 補正後、解決。';
const ANSWER2: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 市中肺炎', when: null },
    { label: 'assessment', start: 'A) 抗菌薬', when: null },
    { label: 'problem_heading', start: '#2 低K血症', when: null },
    { label: 'assessment', start: 'A) 補正後', when: null },
  ],
  problems: [
    { name: '#1 市中肺炎', status: 'diagnosis', activity: null },
    { name: '#2 低K血症', status: 'problem', activity: 'resolved' },
  ],
};

const BOOK: BookHit = { title: '架空の内科学', path: '呼吸器 > 肺炎', page: '120', snippet: '臨床の改善を見て、静注から経口へ切り替える。' };
const books: BookSearcher = { search: () => Promise.resolve([BOOK]), check: () => Promise.resolve('ok') };

const PROPOSAL: ProposalAnswer = {
  problems: [
    {
      problem: 'T1',
      assessment: [{ text: '体温 37.1 で、抗菌薬に反応している。', cites: ['Q4', 'Q1'], basis: 'record' }],
      plan: [
        { text: '改善が続けば、経口への切り替えを検討する。', cites: ['B1'], basis: 'source', kind: 'tx' },
        { text: 'アモキシシリン 500mg に切り替える。', cites: ['B1'], basis: 'source', kind: 'tx' },
      ],
    },
  ],
};

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
let organizer: FakeOrganizer;
const contexts: BrowserContext[] = [];
const SHOTS = process.env.CARTE_SCREENSHOTS;

beforeAll(async () => {
  app = await buildApp();
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
  await app.remove();
});
beforeEach(async () => {
  organizer = fakeOrganizer(
    (text) => ({ ok: true, answer: text.includes('#2 低K血症') ? ANSWER2 : ANSWER }),
    undefined,
    undefined,
    {
      propose: () => ({ ok: true, answer: PROPOSAL }),
      discuss: () => ({ ok: true, answer: { paragraphs: [{ text: '臨床的に安定すれば、経口への切り替えは選択肢です。', cites: ['B1'], basis: 'source' }] } }),
    },
  );
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer, books });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openNotes(note = NOTE): Promise<Page> {
  const context = await browser.newContext({ ...presets['iPhone 15'], colorScheme: 'light' });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByTestId('key').fill(TEST_KEY);
  await page.getByTestId('register').click();
  await page.getByTestId('home').waitFor();
  await page.getByTestId('new-patient').click();
  await page.getByTestId('age').fill('72');
  await page.getByRole('radio', { name: '男', exact: true }).check();
  await page.getByRole('radio', { name: '入院', exact: true }).check();
  await page.getByTestId('start-day').fill('2026-11-17');
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
  await page.getByTestId('kind-chip-progress_note').click();
  await page.getByTestId('at-day').fill('2026-11-19');
  await page.getByTestId('at-time').fill('09:00');
  await page.getByTestId('text').fill(note);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
  await page.getByTestId('tab-chart').click();
  await page.getByTestId('note-view').waitFor();
  return page;
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('記載', () => {
  test('日ごとに、問題ごとの S・O が、写した字のまま出る。自分で書いた A/P が残り、直せる・消せる', async () => {
    const page = await openNotes();
    expect(await page.getByTestId('note-day').textContent()).toBe('2026-11-19（3病日）');
    const problem = page.getByTestId('note-problem').first();
    expect(await problem.getByTestId('note-s').textContent()).toContain('S) 咳は減った');
    expect(await problem.getByTestId('note-o').textContent()).toContain('O) 体温 37.1');

    await problem.getByTestId('ap-own').locator(':scope > summary').click();
    await problem.getByTestId('ap-own-text').fill('抗菌薬に反応している');
    await problem.getByTestId('ap-own-save').click();
    await expect.poll(() => problem.getByTestId('ap-note').count()).toBe(1);
    expect(await problem.getByTestId('ap-origin').textContent()).toBe('先生');

    await problem.getByTestId('ap-edit').click();
    await problem.getByTestId('ap-edit-text').fill('抗菌薬に反応している（2日目）');
    await problem.getByTestId('ap-edit-save').click();
    await expect.poll(() => problem.getByTestId('ap-note').textContent()).toContain('（2日目）');
    expect(await problem.getByTestId('ap-origin').textContent()).toBe('先生');

    await problem.getByTestId('ap-delete').click();
    await problem.getByTestId('ap-delete-yes').click();
    await expect.poll(() => problem.getByTestId('ap-note').count()).toBe(0);
    expect(await fits(page)).toBe(true);
  });

  test('AI の案の問題は、はじめは「いまの問題」だけを選ぶ。解決と書かれた問題は、選べば入る', async () => {
    const page = await openNotes(NOTE2);
    const chips = page.getByTestId('ap-proposal-problem');
    await expect.poll(() => chips.count()).toBe(2);
    expect(await chips.nth(0).getAttribute('aria-pressed')).toBe('true');
    expect(await chips.nth(1).getAttribute('aria-pressed')).toBe('false');
    expect(await page.getByTestId('ap-proposal-count').textContent()).toContain('選んだ問題 1 / 2');
    await chips.nth(1).click();
    expect(await page.getByTestId('ap-proposal-count').textContent()).toContain('選んだ問題 2 / 2');
    await page.getByTestId('ap-proposal-make').click();
    await expect.poll(() => organizer.proposed.length).toBe(1);
    expect((JSON.parse(organizer.proposed[0] ?? '{}') as { problems: unknown[] }).problems).toHaveLength(2);
  });

  test('AI の案：確かめを通った文だけが出て、選んだものだけが印と参照つきで残る。直すと「AI 案を直した」になる', async () => {
    const page = await openNotes();
    expect(await page.getByTestId('ap-proposal-count').textContent()).toContain('選んだ問題 1 / 1');
    await page.getByTestId('ap-proposal-make').click();
    const sentences = page.getByTestId('ap-proposal-sentence');
    await expect.poll(() => sentences.count()).toBe(2); // 出典にない用量の文は出ない
    expect(await page.getByTestId('ap-proposal-report').textContent()).toContain('根拠の出典にない数（用量・閾値を含む）がある 1');
    expect(await page.getByTestId('ap-proposal').textContent()).not.toContain('アモキシシリン');
    // 何も選ばなければ、何も残らない
    expect(await page.getByTestId('ap-proposal-adopt').isDisabled()).toBe(true);
    // 書籍の根拠を開ける
    await sentences.nth(1).locator('.ap-cites > summary').click();
    expect(await sentences.nth(1).getByTestId('ap-cite').textContent()).toContain('架空の内科学');

    await sentences.nth(1).getByTestId('ap-proposal-pick').check();
    await page.getByTestId('ap-proposal-adopt').click();
    const problem = page.getByTestId('note-problem').first();
    await expect.poll(() => problem.getByTestId('ap-note').count()).toBe(1);
    expect(await problem.getByTestId('ap-origin').textContent()).toBe('AI 案から採用');
    expect(await problem.getByTestId('ap-refs').textContent()).toContain('書籍『架空の内科学』 120（呼吸器 > 肺炎）');
    expect(await problem.getByTestId('ap-note').textContent()).not.toContain(BOOK.snippet); // 参照に本文は入らない
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/notes-iphone.png`, fullPage: true });

    await problem.getByTestId('ap-edit').click();
    await problem.getByTestId('ap-edit-text').fill('改善が続けば、明日、経口への切り替えを検討する。');
    await problem.getByTestId('ap-edit-save').click();
    await expect.poll(() => problem.getByTestId('ap-origin').textContent()).toBe('AI 案を直した');
    // 外の検索（書籍）には問題の名前だけ。ネットは選ばなければ使わない
    expect(organizer.researched).toHaveLength(0);
    expect(await fits(page)).toBe(true);
  });

  test('AI と話す：やりとりは保存しない。答えの文を P に足すと、それだけが残る', async () => {
    const page = await openNotes();
    const problem = page.getByTestId('note-problem').first();
    await problem.getByTestId('discuss').locator(':scope > summary').click();
    await problem.getByTestId('discuss-question').fill('経口に切り替える時期は？');
    await problem.getByTestId('discuss-send').click();
    await expect.poll(() => problem.getByTestId('discuss-sentence').count()).toBe(1);
    expect(await problem.getByTestId('turn-doctor').textContent()).toContain('経口に切り替える時期は？');
    await problem.getByTestId('discuss-to-p').click();
    await expect.poll(() => problem.getByTestId('ap-note').count()).toBe(1);
    expect(await problem.getByTestId('ap-origin').textContent()).toBe('AI 案から採用');
    // 保存したのは足した1文だけ（問いもやりとりも、保存先にない）
    const saved = server.db.raw.prepare('SELECT text FROM ap_notes').all() as { text: string }[];
    expect(saved.map((r) => r.text)).toEqual(['臨床的に安定すれば、経口への切り替えは選択肢です。']);
    const everything = JSON.stringify(server.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => server.db.raw.prepare(`SELECT * FROM ${(t as { name: string }).name}`).all()));
    expect(everything).not.toContain('経口に切り替える時期は？');
    expect(await fits(page)).toBe(true);
  });
});

describe('書籍の参照元の設定', () => {
  test('ホームから、つながりを確かめ、鍵を作れる（鍵は 64 字の 16 進。画面の外へ送らない）', async () => {
    const context = await browser.newContext({ ...presets['iPhone 15'], colorScheme: 'light' });
    contexts.push(context);
    const page = await context.newPage();
    const sent: string[] = [];
    page.on('request', (r) => {
      sent.push(`${r.method()} ${new URL(r.url()).pathname} ${r.postData() ?? ''}`);
    });
    await page.goto(server.url);
    await page.getByTestId('key').fill(TEST_KEY);
    await page.getByTestId('register').click();
    await page.getByTestId('home').waitFor();
    await page.getByTestId('show-bookkey').click();
    await page.getByTestId('bookkey-check').click();
    await expect.poll(() => page.getByTestId('bookkey-status').textContent()).toContain('つながっています');
    await page.getByTestId('bookkey-make').click();
    const key = (await page.getByTestId('bookkey-key').textContent()) ?? '';
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.some((s) => s.includes(key))).toBe(false);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/bookkey-iphone.png`, fullPage: true });
  });
});
