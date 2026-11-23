// スコア・診断基準の E2E（段K4。CA-059・CA-063）：いまの問題の名前（敗血症）とバイタルから、qSOFA が勧められ、記録の値で計算される。
// 手で選ぶ項目は「未入力」で、選ぶと（画面のメモリだけ）合計が変わる。未確認と出典が出る。ほかの定義を一覧から開ける。電話の幅で横にはみ出さない。値はすべて架空。
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type OrganizeAnswer, PRESETS, presetSources } from '@clinical-carte/core';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
const contexts: BrowserContext[] = [];
const problems: string[] = [];
const SHOTS = process.env.CARTE_SCREENSHOTS;

const NOTE = '#1 敗血症\nA) 抗菌薬で加療中';
const ANSWERS: Record<string, OrganizeAnswer> = {
  [NOTE]: {
    ...EMPTY_ORGANIZE,
    segments: [
      { label: 'problem_heading', start: '#1 敗血症', when: null },
      { label: 'assessment', start: 'A) 抗菌薬', when: null },
    ],
    problems: [{ name: '#1 敗血症', status: 'problem', activity: null }],
  },
};

beforeAll(async () => {
  app = await buildApp();
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
  await app.remove();
});
beforeEach(async () => {
  problems.length = 0;
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer: fakeOrganizer((text) => ({ ok: true, answer: ANSWERS[text] ?? EMPTY_ORGANIZE })) });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openPatient(): Promise<Page> {
  const context = await browser.newContext({ ...presets['iPhone 15'], colorScheme: 'light' });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
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

async function sendAndWait(page: Page): Promise<void> {
  const before = await page.getByTestId('source').count();
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(before + 1);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('スコア・診断基準（臨床支援）', () => {
  test('問題の名前とバイタルから qSOFA が勧められ、記録の値と、手で選ぶ項目の未入力が出る。選ぶと合計が変わる', async () => {
    const page = await openPatient();
    await page.getByTestId('kind-chip-progress_note').click();
    await page.getByTestId('at-day').fill('2026-11-18');
    await page.getByTestId('at-time').fill('09:00');
    await page.getByTestId('text').fill(NOTE);
    await sendAndWait(page);
    await page.getByTestId('kind-chip-vital').click();
    await page.getByTestId('at-day').fill('2026-11-18');
    await page.getByTestId('at-time').fill('10:00');
    await page.getByTestId('quick-RR').fill('24');
    await page.getByTestId('quick-SBP').fill('92');
    await page.getByTestId('quick-DBP').fill('54');
    await page.getByTestId('quick-apply').click();
    await sendAndWait(page);

    await page.getByTestId('tab-state').click();
    const section = page.getByTestId('state-scores');
    await section.waitFor();
    // 畳んである（見出しに、勧めた定義と結果）
    expect(await section.getAttribute('open')).toBeNull();
    expect(await section.locator('summary').first().textContent()).toContain('qSOFA');
    await section.locator('summary').first().click();
    expect(await page.getByTestId('scores-note').textContent()).toContain('AI は使っていません');

    const card = section.locator('[data-preset="qsofa"]');
    await card.locator('summary').click();
    expect(await card.getByTestId('preset-why').textContent()).toContain('敗血症');
    expect(await card.textContent()).toContain('未確認（原典と照らしていない）');
    const qsofa = PRESETS.get('qsofa');
    if (qsofa === null) throw new Error('qsofa');
    const title = presetSources(qsofa)[0]?.title ?? '';
    expect(await card.getByTestId('preset-sources').textContent()).toContain(title.slice(0, 20));

    const items = card.getByTestId('preset-item');
    const rr = items.filter({ hasText: '呼吸数' });
    expect(await rr.getByTestId('preset-item-state').textContent()).toBe('あてはまる');
    expect(await rr.textContent()).toContain('呼吸数 24');
    const mentation = items.filter({ hasText: '意識' });
    expect(await mentation.getByTestId('preset-item-state').textContent()).toBe('未入力');
    expect(await mentation.textContent()).toContain('手で選ぶ項目（未入力）');

    const before = (await card.getByTestId('preset-result').textContent()) ?? '';
    expect(before).toContain('〜'); // 意識が未入力なので、合計は幅
    await mentation.getByRole('button', { name: 'あてはまる', exact: true }).click();
    await expect.poll(() => card.getByTestId('preset-result').textContent()).not.toContain('〜');
    expect(await mentation.getByTestId('preset-item-state').textContent()).toBe('あてはまる');
    expect(await mentation.textContent()).toContain('手で選んだ（この画面だけ）');

    // ほかの定義を一覧から開く
    await page.getByTestId('preset-picker').locator('summary').click();
    await page.getByTestId('preset-pick').filter({ hasText: 'Child-Pugh' }).click();
    await section.locator('[data-preset="child-pugh"]').waitFor();

    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await section.screenshot({ path: `${SHOTS}/scores-iphone.png` });
    expect(problems).toEqual([]);
  });
});
