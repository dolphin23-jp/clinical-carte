// 本人の調節（CA-029）の E2E：問題の確からしさ・状態・並び・外す・打って直す名前（選別を通す）、
// 文をなぞって足す、区切りの見出し・記載の種類を直す、文を打ち直す（選別を通す）。AI は試験の代役。文はすべて架空。
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NAME = ['架空', '三郎'].join('');
const NOTE = '#1 発熱\nA) 原因を検索\n#2 低K血症\nO) K 3.1 Na 128\n便秘あり。酸化マグネシウム 開始。';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 発熱' },
    { label: 'assessment', start: 'A) 原因' },
    { label: 'problem_heading', start: '#2 低K' },
    { label: 'objective', start: 'O) K' },
  ],
  problems: [
    { name: '#1 発熱', status: 'problem', activity: null },
    { name: '#2 低K血症', status: 'problem', activity: null },
  ],
};

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
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
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector([{ kind: 'person', quote: NAME }]), organizer: fakeOrganizer((text) => ({ ok: true, answer: text.includes('#1 発熱') ? ANSWER : EMPTY_ORGANIZE })) });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openWithNote(): Promise<Page> {
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
  await page.getByTestId('text').fill(NOTE);
  await page.getByTestId('send').click();
  await page.getByTestId('source').first().waitFor();
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
  return page;
}

/** 選んだ範囲を、なぞったのと同じに作る（文の字の並びの中の場所で） */
async function select(page: Page, quote: string): Promise<void> {
  await page.getByTestId('pick-text').first().evaluate((el, q) => {
    const node = el.firstChild;
    if (node === null) return;
    const text = node.textContent ?? '';
    const start = text.indexOf(q);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + q.length);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, quote);
  await page.getByTestId('pick-capture').first().click();
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const card = (page: Page, name: string) => page.getByTestId('problem-line').filter({ has: page.getByTestId('thread-name').filter({ hasText: name }) });

describe('問題を調節する', () => {
  test('確からしさ・状態を先生が決める。並べ替える。外して戻す。名前を打って直す（氏名は置き換わる）', async () => {
    const page = await openWithNote();
    await page.getByTestId('tab-problems').click();
    const lowK = card(page, '#2 低K血症');
    await lowK.getByTestId('thread-edit').locator(':scope > summary').click();
    await lowK.getByTestId('thread-up').click();
    await expect.poll(() => page.getByTestId('thread-name').first().textContent()).toBe('#2 低K血症');

    const fever = card(page, '#1 発熱');
    await fever.getByTestId('thread-edit').locator(':scope > summary').click();
    await fever.getByTestId('thread-status').selectOption('suspected');
    await expect.poll(() => card(page, '#1 発熱').locator('.tag').first().textContent()).toBe('疑い（先生）');
    await card(page, '#1 発熱').getByTestId('thread-activity').selectOption('resolved');
    await expect.poll(() => page.getByTestId('thread-group-closed').textContent()).toContain('#1 発熱');

    // 別のまとまりへ移ると、カードが作り直され「直す」が閉じる
    const moved = card(page, '#1 発熱').getByTestId('thread-edit');
    if ((await moved.getAttribute('open')) === null) await moved.locator(':scope > summary').click();
    await card(page, '#1 発熱').getByTestId('thread-typed-name').fill(`#1 ${NAME}さんの右下葉肺炎`);
    await card(page, '#1 発熱').getByTestId('thread-typed-save').click();
    await expect.poll(() => page.getByTestId('thread-group-closed').getByTestId('thread-name').textContent()).toBe('#1 〔氏名〕さんの右下葉肺炎');
    expect(await page.content()).not.toContain(NAME);

    const renamed = card(page, '#1 〔氏名〕さんの右下葉肺炎');
    if ((await renamed.getByTestId('thread-edit').getAttribute('open')) === null) await renamed.getByTestId('thread-edit').locator(':scope > summary').click();
    await renamed.getByTestId('thread-exclude').click();
    await page.getByTestId('thread-excluded').waitFor();
    await page.getByTestId('thread-excluded').locator(':scope > summary').click();
    await page.getByTestId('thread-restore').click();
    await expect.poll(() => page.getByTestId('thread-excluded').count()).toBe(0);

    await page.getByTestId('thread-history').locator(':scope > summary').click();
    const history = await page.getByTestId('thread-history').textContent();
    expect(history).toContain('確からしさを、疑いにした');
    expect(history).toContain('外した');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/adjust-problems-iphone.png`, fullPage: true });
  });
});

describe('記載を調節する', () => {
  test('文をなぞって問題・投薬・値を足す。区切りの見出しと記載の種類を直す', async () => {
    const page = await openWithNote();
    await page.getByTestId('tab-notes').click();
    const edit = page.getByTestId('source-edit').first();
    await edit.locator(':scope > summary').click();
    await edit.getByTestId('picker').first().locator(':scope > summary').click();

    await select(page, '便秘');
    expect(await page.getByTestId('pick-quote').textContent()).toBe('便秘');
    await page.getByTestId('pick-type').selectOption('problem');
    await page.getByTestId('pick-add').click();
    await expect.poll(() => page.getByTestId('source-edit-message').textContent()).toContain('問題として足しました');

    const edit2 = page.getByTestId('source-edit').first();
    if ((await edit2.getAttribute('open')) === null) await edit2.locator(':scope > summary').click();
    const picker = edit2.getByTestId('picker').first();
    if ((await picker.getAttribute('open')) === null) await picker.locator(':scope > summary').click();
    await select(page, '酸化マグネシウム');
    await page.getByTestId('pick-type').selectOption('medication');
    await page.getByTestId('pick-action').selectOption('start');
    await page.getByTestId('pick-add').click();
    await expect.poll(() => page.getByTestId('source-edit-message').textContent()).toContain('投薬として足しました');

    await select(page, 'Na 128');
    await page.getByTestId('pick-type').selectOption('observation');
    await page.getByTestId('pick-add').click();
    await expect.poll(() => page.getByTestId('source-edit-message').textContent()).toContain('値として足しました');

    // 区切りの見出しを選び直す・記載の種類を直す
    await page.getByTestId('segment-row').filter({ hasText: 'O) K' }).getByTestId('segment-label-select').selectOption('subjective');
    await expect.poll(() => page.getByTestId('segment-row').filter({ hasText: 'O) K' }).textContent()).toContain('直した');
    await page.getByTestId('source-kind').first().selectOption('admission_note');
    await expect.poll(() => page.getByTestId('source').first().textContent()).toContain('入院時');

    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/adjust-source-iphone.png`, fullPage: true });
    await page.getByTestId('tab-problems').click();
    await expect.poll(() => page.getByTestId('thread-name').allTextContents()).toContain('便秘');
    await page.getByTestId('tab-medications').click();
    expect(await page.getByTestId('medications').textContent()).toContain('酸化マグネシウム');
    expect(await fits(page)).toBe(true);
  });

  test('文を打ち直す：選別を通して保存し、整理し直す。紛れた氏名は残らない', async () => {
    const page = await openWithNote();
    await page.getByTestId('tab-notes').click();
    const edit = page.getByTestId('source-edit').first();
    await edit.locator(':scope > summary').click();
    await edit.getByTestId('retype').locator(':scope > summary').click();
    await page.getByTestId('retype-text').fill(`${NAME}さん。\n${NOTE}`);
    await page.getByTestId('retype-save').click();
    await expect.poll(() => page.getByTestId('source').first().textContent()).toContain('〔氏名〕さん。');
    expect(await page.content()).not.toContain(NAME);
    await expect.poll(() => page.getByTestId('segment-label').count()).toBeGreaterThan(0);
  });
});
