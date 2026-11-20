// 選別の評価の E2E：画面のボタンから、架空の文を1件ずつ動かし、数を出す。AI は、試験の代役。
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { CASES } from '../../worker/eval/cases.ts';
import { checkCases, oracleSelector } from '../../worker/eval/lib.ts';
import type { Selector } from '../../worker/src/selector.ts';
import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const cases = checkCases(CASES);
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

async function open(selector: Selector | null): Promise<{ page: Page; server: DevServer }> {
  const started = await startDevServer({ dist: app.dir, key: TEST_KEY, selector });
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
