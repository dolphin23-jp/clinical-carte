// 選別の評価の E2E：画面のボタンから、架空の文を1件ずつ動かし、数を出す。AI は、試験の代役。
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { CASES } from '../../worker/eval/cases.ts';
import { checkCases, oracleSelector } from '../../worker/eval/lib.ts';
import { ORGANIZE_CASES } from '../../worker/eval/organize-cases.ts';
import { checkOrganizeCases } from '../../worker/eval/organize-lib.ts';
import { ORGANIZE_PROMPT_VERSION, ORGANIZE_PROMPT_VERSION_PREVIOUS } from '../../worker/src/prompt.ts';
import type { Selector } from '../../worker/src/selector.ts';
import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, type FakeOrganizer, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const cases = checkCases(CASES);
const organizeCases = checkOrganizeCases(ORGANIZE_CASES);
let app: BuiltApp;
let browser: Browser;
let server: DevServer | null = null;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  app = await buildApp();
  browser = await launch();
});

afterAll(async () => {
  await browser.close();
  await app.remove();
});

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server?.close();
  server = null;
});

async function open(selector: Selector | null, organizer?: FakeOrganizer): Promise<{ page: Page; server: DevServer }> {
  const started = await startDevServer({ dist: app.dir, key: TEST_KEY, selector, ...(organizer === undefined ? {} : { organizer }) });
  server = started;
  const context = await browser.newContext({ ...presets['iPhone 15'] });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(started.url);
  await page.getByTestId('key').fill(TEST_KEY);
  await page.getByTestId('register').click();
  await page.getByTestId('home').waitFor();
  await page.getByTestId('show-selfcheck').click();
  await page.getByTestId('selfcheck').waitFor();
  return { page, server: started };
}

describe('選別の評価', () => {
  test('漏れのない AI なら、漏れ 0 と出る。モデルと指示の版が出る。記録には、何も保存しない', async () => {
    const { page, server: s } = await open(oracleSelector(cases));
    await page.getByTestId('selfcheck-config').waitFor();
    expect(await page.getByTestId('selfcheck-config').textContent()).toContain('test-model');
    await page.getByTestId('run-selfcheck').click();
    const verdict = page.getByTestId('selfcheck-verdict');
    await verdict.waitFor();
    expect(await verdict.textContent()).toContain('漏れが 0 でした');
    const result = (await page.getByTestId('selfcheck-result').textContent()) ?? '';
    expect(result).toContain('漏れ（識別情報が残った）：0 件・0 か所');
    expect(result).toContain(`調べた文：${String(cases.length)} / ${String(cases.length)}`);
    expect(s.db.raw.prepare('SELECT calls FROM usage_daily').get()).toEqual({ calls: cases.length });
    for (const table of ['patients', 'sources', 'observations']) expect(s.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    // 文のひな形・混ぜた場所の印が、画面に出ていない
    expect(await page.content()).not.toMatch(/\{[A-Z]+\d\}/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    // もう一度動かせる
    expect(await page.getByTestId('run-selfcheck').textContent()).toContain('もう一度');
  });

  test('何も指さない AI なら、漏れの数と、文の id が出て、実際の文を入れないように知らせる', async () => {
    const { page } = await open(fakeSelector());
    await page.getByTestId('run-selfcheck').click();
    const verdict = page.getByTestId('selfcheck-verdict');
    await verdict.waitFor();
    expect(await verdict.textContent()).toContain('漏れがありました。実際の患者の文は、まだ入れないでください');
    const result = (await page.getByTestId('selfcheck-result').textContent()) ?? '';
    expect(result).not.toContain('漏れ（識別情報が残った）：0 件');
    expect(result).toContain('er-01：漏れ');
  });

  test('AI の鍵がないときは、動かせない', async () => {
    const { page } = await open(null);
    await page.getByTestId('selfcheck').getByRole('alert').waitFor();
    expect(await page.getByTestId('run-selfcheck').isDisabled()).toBe(true);
  });
});

describe('整理の評価', () => {
  test('いまの版と前の版を、同じ架空の文で動かして並べる。選んだ版が整理の係に届く。記録には何も保存しない', async () => {
    // 代役：前の版は何も拾わない（欠けが出る）、いまの版も同じ答え（比べる行が出ることを確かめる）
    const organizer = fakeOrganizer(() => ({ ok: true, answer: EMPTY_ORGANIZE }));
    const { page, server: s } = await open(oracleSelector(cases), organizer);
    await page.getByTestId('show-organizecheck').click();
    await page.getByTestId('organizecheck-config').waitFor();
    const config = (await page.getByTestId('organizecheck-config').textContent()) ?? '';
    expect(config).toContain(ORGANIZE_PROMPT_VERSION);
    expect(config).toContain(ORGANIZE_PROMPT_VERSION_PREVIOUS);
    await page.getByTestId('run-organizecheck-previous').click();
    await page.getByTestId('organizecheck-result-previous').waitFor();
    await expect.poll(() => page.getByTestId('organizecheck-result-previous').textContent()).toContain(`調べた文：${String(organizeCases.length)} / ${String(organizeCases.length)}`);
    await page.getByTestId('run-organizecheck-current').click();
    await page.getByTestId('organizecheck-compare').waitFor();
    const current = (await page.getByTestId('organizecheck-result-current').textContent()) ?? '';
    expect(current).toContain('余分 0');
    expect(current).toContain('欠け「問題：一覧の #1 を拾う」');
    expect(organizer.prompts).toEqual([...organizeCases.map(() => 'previous'), ...organizeCases.map(() => 'current')]);
    expect(s.db.raw.prepare('SELECT calls FROM usage_daily').get()).toEqual({ calls: organizeCases.length * 2 });
    for (const table of ['patients', 'sources', 'observations', 'problems', 'medications', 'events']) expect(s.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    if (process.env.CARTE_SCREENSHOTS !== undefined) await page.getByTestId('organizecheck').screenshot({ path: `${process.env.CARTE_SCREENSHOTS}/organizecheck-iphone.png` });
    // 架空の文そのものは、画面に出さない
    expect(await page.content()).not.toContain('尿道カテーテル留置');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
