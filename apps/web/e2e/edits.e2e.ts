// 段3e の E2E：記録の種類の絞り込み、事実を外す・直す（と、見方から消えること・直した記録）。
// AI は試験の代役。文はすべて架空。
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NOTE = '#1 市中肺炎\nO) CRP 6.8\nA) 抗菌薬に反応\nP) セフトリアキソン 2g 継続。胸部X線を撮影。';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 市中肺炎', when: null },
    { label: 'objective', start: 'O) CRP', when: null },
    { label: 'assessment', start: 'A) 抗菌薬', when: null },
    { label: 'plan', start: 'P) セフ', when: null },
  ],
  problems: [{ name: '#1 市中肺炎', status: 'diagnosis', activity: null }],
  medications: [{ name: 'セフトリアキソン', dose: '2g', action: 'continue', when: null }],
  events: [{ kind: 'test', title: '胸部X線を撮影', when: null }],
  measurements: [{ quote: 'CRP 6.8', when: null, specimen: null }],
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
  server = await startDevServer({
    dist: app.dir,
    key: TEST_KEY,
    selector: fakeSelector(),
    organizer: fakeOrganizer((text) => ({ ok: true, answer: text === NOTE ? ANSWER : EMPTY_ORGANIZE })),
  });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openPatient(): Promise<Page> {
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
  return page;
}

async function send(page: Page, kind: string, text: string, day: string): Promise<void> {
  const before = await page.getByTestId('source').count();
  await page.getByTestId(`kind-chip-${kind}`).click();
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill('09:00');
  await page.getByTestId('text').fill(text);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(before + 1);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('段3e：種類で絞る・事実を直す', () => {
  test('記録を種類で絞れる。自分のメモには「carte だけの記録」が付く', async () => {
    const page = await openPatient();
    await send(page, 'progress_note', NOTE, '2026-11-19');
    await send(page, 'memo', '明日、家族への説明の時間を確かめる。', '2026-11-19');
    const filter = page.getByTestId('kind-filter');
    await filter.waitFor();
    await page.getByTestId('kind-filter-memo').click();
    expect(await page.getByTestId('source').count()).toBe(1);
    expect(await page.getByTestId('source').first().textContent()).toContain('carte だけの記録');
    await page.getByTestId('kind-filter-all').click();
    expect(await page.getByTestId('source').count()).toBe(2);
  });

  test('事実を外すと、経過表・投薬・いまから消え、戻せる。動きを選び直すと、直した記録が残る', async () => {
    const page = await openPatient();
    await send(page, 'progress_note', NOTE, '2026-11-19');
    const facts = page.getByTestId('source-facts').first();
    await facts.locator('summary').click();
    const med = facts.getByTestId('fact-row').filter({ hasText: 'セフトリアキソン' });
    await med.getByTestId('fact-action').selectOption('start');
    await expect.poll(() => page.getByTestId('fact-edits').first().textContent()).toContain('投薬の動き');
    expect(await page.getByTestId('fact-edits').first().textContent()).toContain('継続 → 開始');

    // 胸部X線（できごと）を外す
    const ev = page.getByTestId('source-facts').first().getByTestId('fact-row').filter({ hasText: '胸部X線' });
    await ev.getByTestId('fact-exclude').click();
    await expect.poll(() => ev.getAttribute('data-excluded')).toBe('true');
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-events').click();
    expect(await page.getByTestId('events').textContent()).not.toContain('胸部X線');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) {
      await page.getByTestId('tab-notes').click();
      await page.getByTestId('source-facts').first().locator('summary').click();
      await page.screenshot({ path: `${SHOTS}/facts-iphone.png`, fullPage: true });
      await page.getByTestId('tab-course').click();
      await page.getByTestId('tab-events').click();
    }
    // 戻す
    await page.getByTestId('tab-notes').click();
    const facts2 = page.getByTestId('source-facts').first();
    if ((await facts2.getAttribute('open')) === null) await facts2.locator('summary').click();
    await facts2.getByTestId('fact-row').filter({ hasText: '胸部X線' }).getByTestId('fact-exclude').click();
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-events').click();
    await expect.poll(() => page.getByTestId('events').textContent()).toContain('胸部X線');
  });
});
