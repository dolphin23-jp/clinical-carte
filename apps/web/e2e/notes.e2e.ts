// カルテ記載の E2E（段I。CA-054）：種類と日を選んで「出す」と、出来上がった1つの記載が出る（一文ずつの採用はしない）。
// 記録にない数には下線と「※」。自分で直す・AI と相談して直す（やりとりは保存しない）・保存する（選別を通す。印）・開いて直す・消す。
// AI と書籍の検索は試験の代役。文はすべて架空。
import type { OrganizeAnswer } from '@clinical-carte/core';
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

// 解決と書かれた問題がある記載（経過のひな形）
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

// AI の代役の記載：体温 37.1・2g は記録にある。38.5 は記録にない（印が付く）
const DOC_SECTIONS = [
  { key: 's', text: '咳は減った', refs: ['R1'] },
  { key: 'o', text: '体温 37.1（前日 38.5）', refs: ['R1'] },
  { key: 'ap', text: '#1 市中肺炎\nA) 抗菌薬に反応。\nP) セフトリアキソン 2g 継続。改善が続けば経口への切り替えを検討（推論）', refs: ['R1', 'B1'] },
];

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
    {
      document: () => ({ ok: true, answer: { sections: DOC_SECTIONS } }),
      revise: (message) => {
        const sent = JSON.parse(message) as { current: { key: string; text: string }[] };
        return { ok: true, answer: { reply: 'S を短くしました。', sections: sent.current.map((x) => (x.key === 's' ? { key: 's', text: '咳は軽減', refs: [] } : { ...x, refs: [] })) } };
      },
    },
  );
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer, books });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openNotes(note = NOTE, viewport?: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext(viewport === undefined ? { ...presets['iPhone 15'], colorScheme: 'light' } : { viewport, colorScheme: 'light' });
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
  await page.getByTestId('composer-close').click();
  await page.getByTestId('tab-course').click();
  await page.getByTestId('tab-chart').click();
  await page.getByTestId('doc-view').first().waitFor();
  return page;
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('カルテ記載（段I）', () => {
  test('「出す」で、出来上がった記載が見出しの順に出る。記録にない数には印。採用のボタンはない。保存するまで残らない', async () => {
    const page = await openNotes();
    // 入院の受診では、プログレスノートが先。日は、記録の最後の日
    expect(await page.getByTestId('doc-type-progress').getAttribute('aria-checked')).toBe('true');
    expect(await page.getByTestId('doc-day').inputValue()).toBe('2026-11-19');
    await page.getByTestId('doc-generate').click();
    const doc = page.getByTestId('doc');
    await doc.waitFor();
    expect(await doc.getByTestId('doc-section').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).toEqual(['s', 'o', 'ap']);
    const text = (await doc.textContent()) ?? '';
    expect(text).toContain('【A/P】');
    expect(text).toContain('セフトリアキソン 2g 継続');
    // 記録にない数（38.5）だけに印
    expect(await doc.getByTestId('num-mark').allTextContents()).toEqual(['38.5※']);
    expect(await page.getByTestId('doc-marks-legend').textContent()).toContain('1 個');
    expect(await page.getByTestId('doc-origin').textContent()).toBe('AI が書いた');
    expect(await page.getByTestId('doc-state').textContent()).toBe('まだ保存していません');
    // 一文ずつの採用・コピーのボタンはない
    expect(await page.locator('[data-testid^="ap-proposal"]').count()).toBe(0);
    expect(text).not.toContain('採用');
    expect(text).not.toContain('コピー');
    // 書籍には問題の名前だけ。AI には保存した文
    expect(organizer.documented.at(-1)).toContain('A) 抗菌薬に反応');
    expect(await page.getByTestId('doc-saved-list').textContent()).toContain('保存した記載（0）');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/doc-iphone.png`, fullPage: true });
  });

  test('自分で直して保存すると「AI が書いて先生が直した」。AI と相談して直す（やりとりは保存しない）。開いて直す・消す', async () => {
    const page = await openNotes();
    await page.getByTestId('doc-generate').click();
    await page.getByTestId('doc').waitFor();
    // AI と相談：S を短く
    await page.getByTestId('doc-ask-text').fill('S を短くして');
    await page.getByTestId('doc-ask').click();
    await expect.poll(() => page.getByTestId('doc-reply').count()).toBe(1);
    expect(await page.getByTestId('doc-reply').textContent()).toContain('S を短くしました');
    expect(await page.locator('[data-key="s"]').textContent()).toContain('咳は軽減');
    expect(await page.locator('[data-key="s"]').textContent()).toContain('AI が直した');
    // 戻せる
    await page.getByTestId('doc-undo').click();
    expect(await page.locator('[data-key="s"]').textContent()).toContain('咳は減った');
    // 自分で直す
    await page.getByTestId('doc-edit').click();
    await page.getByTestId('doc-edit-text').first().fill('咳は減った。夜間も眠れている');
    await page.getByTestId('doc-edit').click();
    expect(await page.getByTestId('doc-origin').textContent()).toBe('AI が書いて先生が直した');
    await page.getByTestId('doc-save').click();
    await expect.poll(() => page.getByTestId('doc-state').textContent()).toBe('保存しました');
    await expect.poll(() => page.getByTestId('doc-saved-item').count()).toBe(1);
    expect(await page.getByTestId('doc-saved-item').textContent()).toContain('AI が書いて先生が直した');
    // 開いて直す：数の印は、AI を使わずに付く
    await page.getByTestId('doc-generate').click();
    await page.getByTestId('doc-saved-open').click();
    await expect.poll(() => page.getByTestId('doc-state').textContent()).toBe('保存しました');
    await expect.poll(() => page.getByTestId('num-mark').count()).toBe(1);
    await page.getByTestId('doc-edit').click();
    await page.getByTestId('doc-edit-text').first().fill('咳は減った');
    await page.getByTestId('doc-save').click();
    await expect.poll(() => page.getByTestId('doc-state').textContent()).toBe('保存しました');
    expect(await page.getByTestId('doc-saved-item').count()).toBe(1);
    // やりとりは保存しない：記録の答えに、頼みの字はない
    await page.getByTestId('doc-saved-delete').click();
    await page.getByTestId('doc-saved-confirm-delete').click();
    await expect.poll(() => page.getByTestId('doc-saved-item').count()).toBe(0);
    expect(await fits(page)).toBe(true);
  });

  test('種類を選べる（入院の受診では、プログレスノート・入院時記録・中間・退院サマリー。ほかの種類も選べる）。見出しだけで自分で書ける', async () => {
    const page = await openNotes();
    for (const t of ['progress', 'admission', 'interim_summary', 'discharge_summary']) await page.getByTestId(`doc-type-${t}`).waitFor();
    await page.getByTestId('doc-type-discharge_summary').click();
    await page.getByTestId('doc-blank').click();
    const headings = await page.getByTestId('doc').locator('.doc-heading').allTextContents();
    expect(headings).toEqual(['【診断】', '【主訴】', '【入院までの経過】', '【入院時の主な所見】', '【入院後経過】', '【退院時処方】', '【転帰】', '【退院後の方針】']);
    expect(await page.getByTestId('doc-origin').textContent()).toBe('先生が書いた');
    await page.getByTestId('doc-type-other').selectOption('er_record');
    expect(await page.getByTestId('doc-generate').textContent()).toBe('救急外来記録を出す');
    expect(await fits(page)).toBe(true);
  });

  test('PC の幅でも、はみ出さない', async () => {
    const page = await openNotes(NOTE, { width: 1280, height: 900 });
    await page.getByTestId('doc-generate').first().click();
    await page.getByTestId('doc').first().waitFor();
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/doc-pc.png`, fullPage: true });
  });

  test('経過の入れる欄に、いまの問題の見出しのひな形が出る（書かれた名前のまま。中身は先生が書く）', async () => {
    const page = await openNotes(NOTE2);
    await page.getByTestId('fab-compose').click();
    await page.getByTestId('kind-chip-progress_note').click();
    const template = page.getByTestId('template-0');
    expect(await template.textContent()).toContain('いまの問題の見出し（1）'); // 解決と書かれた #2 は入らない
    await page.getByTestId('text').fill('');
    await template.click();
    expect(await page.getByTestId('text').inputValue()).toBe('#1 市中肺炎\n');
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
