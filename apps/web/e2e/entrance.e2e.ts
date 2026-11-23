// 入口の E2E（CA-016・CA-019）：登録していない端末には登録の画面だけ。登録は1回で、以後はログインの画面が出ない。
// 帯は、どの画面でも出る。画面は、端末の保存先を使わず、自分のオリジンにだけ通信する。
import { BANNER_LINES, keyProblem, MAX_FAILED_PER_DAY } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
const contexts: BrowserContext[] = [];
/** ブラウザが出した誤り（CSP の違反を含む）と、自分のオリジンの外への要求 */
const problems: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  browser = await launch();
});

afterAll(async () => {
  await browser.close();
  await app.remove();
});

beforeEach(async () => {
  server = await startDevServer({ dist: app.dir, key: TEST_KEY });
  problems.length = 0;
});

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function open(preset: 'iPhone 15' | 'Desktop Chrome' = 'iPhone 15', url = server.url): Promise<Page> {
  const context = await browser.newContext({ ...presets[preset] });
  contexts.push(context);
  const page = await context.newPage();
  page.on('console', (m) => {
    // 401（登録していない）は、ブラウザが「読み込みに失敗」と出す。ここで確かめたい誤りではない
    if (m.type() === 'error' && !m.text().includes('401')) problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(url)) problems.push(`外への要求: ${new URL(r.url()).origin}`);
  });
  await page.goto(url);
  return page;
}

async function register(page: Page, key = TEST_KEY): Promise<void> {
  await page.getByTestId('key').fill(key);
  await page.getByTestId('register').click();
}

/** 登録した端末の一覧は、患者の一覧の下の「道具と設定」のボタンで開く */
async function showDevices(page: Page): Promise<void> {
  await page.getByTestId('home').waitFor();
  await page.getByTestId('show-devices').click();
  await page.getByTestId('device').first().waitFor();
}

async function bannerShown(page: Page): Promise<void> {
  const banner = page.getByTestId('banner');
  await banner.waitFor({ state: 'visible' });
  for (const line of BANNER_LINES) expect(await banner.textContent()).toContain(line);
}

describe('登録していない端末', () => {
  test('登録の画面だけが出る。帯は出る。記録の画面は出ない', async () => {
    const page = await open();
    await page.getByTestId('key').waitFor();
    await bannerShown(page);
    expect(await page.getByTestId('home').count()).toBe(0);
    expect(await page.getByRole('radio', { name: 'iPhone' }).isChecked()).toBe(true); // 端末の種類を、最初から選んである
    expect(problems).toEqual([]);
  });

  test('合鍵が違うと、残りの回数を知らせ、入れた合鍵を画面から消す。記録の画面には進まない', async () => {
    const page = await open();
    await register(page, `${TEST_KEY}x`);
    const error = page.getByTestId('register-error');
    await error.waitFor();
    expect(await error.textContent()).toContain(`あと ${String(MAX_FAILED_PER_DAY - 1)} 回`);
    expect(await page.getByTestId('key').inputValue()).toBe('');
    expect(await page.getByTestId('home').count()).toBe(0);
    await bannerShown(page);
  });

  test('サーバーに合鍵の設定がないと、登録の画面も出さず、そう知らせる', async () => {
    await server.close();
    server = await startDevServer({ dist: app.dir, key: undefined });
    const page = await open();
    const problem = page.getByTestId('problem');
    await problem.waitFor();
    expect(await problem.textContent()).toContain('合鍵が設定されていません');
    expect(await page.getByTestId('key').count()).toBe(0);
    await bannerShown(page);
  });

  test('合鍵がないときだけ、合鍵を作れる：この端末の中で作り、どこにも送らない。作った合鍵は、サーバーが受け付ける形', async () => {
    await server.close();
    server = await startDevServer({ dist: app.dir, key: undefined });
    const page = await open();
    await page.getByTestId('keymaker').waitFor();
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.getByTestId('make-key').click();
    const made = (await page.getByTestId('made-key').textContent()) ?? '';
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    expect(keyProblem(made)).toBeNull();
    expect(requests).toEqual([]); // 作っても、通信しない
    expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(0);

    // その合鍵をサーバーに置くと、登録できる
    await server.close();
    server = await startDevServer({ dist: app.dir, key: made });
    const next = await open('iPhone 15', server.url);
    await register(next, made);
    await next.getByTestId('home').waitFor();
    expect(await next.getByTestId('keymaker').count()).toBe(0);
  });
});

describe('登録した端末', () => {
  test('登録は1回。読み込み直しても、ログインの画面は出ない', async () => {
    const page = await open();
    await register(page);
    await showDevices(page);
    await bannerShown(page);
    const rows = page.getByTestId('device');
    expect(await rows.count()).toBe(1);
    expect(await rows.first().textContent()).toContain('iPhone');
    expect(await rows.first().textContent()).toContain('この端末');

    await page.reload();
    await page.getByTestId('home').waitFor();
    expect(await page.getByTestId('key').count()).toBe(0);
    await bannerShown(page);
    expect(problems).toEqual([]);
  });

  test('印は、画面のプログラムから読めない。端末の保存先には、何も置かない', async () => {
    const page = await open();
    await register(page);
    await page.getByTestId('home').waitFor();
    const cookies = await page.context().cookies();
    expect(cookies.map((c) => [c.name, c.httpOnly, c.sameSite])).toEqual([['carte', true, 'Strict']]);
    const seen = await page.evaluate(async () => ({
      cookie: document.cookie,
      local: window.localStorage.length,
      session: window.sessionStorage.length,
      databases: (await window.indexedDB.databases()).length,
      caches: (await window.caches.keys()).length,
      workers: (await navigator.serviceWorker.getRegistrations()).length,
    }));
    expect(seen).toEqual({ cookie: '', local: 0, session: 0, databases: 0, caches: 0, workers: 0 });
    // 合鍵が、画面のどこにも残っていない
    expect(await page.content()).not.toContain(TEST_KEY);
  });

  test('なくした端末を、別の端末から外す。外された端末は、登録の画面に戻る', async () => {
    const phone = await open('iPhone 15');
    await register(phone);
    await phone.getByTestId('home').waitFor();

    const pc = await open('Desktop Chrome');
    await register(pc);
    await showDevices(pc);
    const rows = pc.getByTestId('device');
    expect(await rows.count()).toBe(2);
    const lost = rows.filter({ hasText: 'iPhone' });
    expect(await lost.textContent()).not.toContain('この端末');
    await lost.getByTestId('remove').click();
    await lost.getByTestId('confirm-remove').click();
    await expect.poll(() => rows.count()).toBe(1);

    await phone.reload();
    await phone.getByTestId('key').waitFor();
    expect(await phone.getByTestId('home').count()).toBe(0);
  });

  test('「外す」は、確かめてから。やめられる。この端末を外すと、登録の画面に戻る', async () => {
    const page = await open('Desktop Chrome');
    await register(page);
    await showDevices(page);
    await page.getByTestId('remove').click();
    await page.getByRole('button', { name: 'やめる' }).click();
    expect(await page.getByTestId('device').count()).toBe(1);
    await page.getByTestId('remove').click();
    await page.getByTestId('confirm-remove').click();
    await page.getByTestId('key').waitFor();
    await bannerShown(page);
  });
});

describe('電話の幅', () => {
  test('横にはみ出さない（登録の画面・記録の画面）。帯が画面の上に残る', async () => {
    const page = await open('iPhone 15');
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    await page.getByTestId('key').waitFor();
    expect(await fits()).toBe(true);
    await register(page);
    await page.getByTestId('home').waitFor();
    expect(await fits()).toBe(true);
    const box = await page.getByTestId('banner').boundingBox();
    expect(box?.y ?? 999).toBeLessThan(80);
    expect(problems).toEqual([]);
  });
});
