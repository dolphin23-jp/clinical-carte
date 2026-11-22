// 水分の出入りと体重・受け持ちから探すの E2E（段K8。CA-069・CA-070）。
// - 水分：バイタルの記載に書いた入る量・出る量・体重を、経過の「水分」で日ごとに足す（同じ単位だけ。単位のない値は足さない）。いまに1行
// - 探す：回診リストの「受け持ちから探す」で、全角・大文字の違いをそろえて探す → 患者ごとの当たり → 押すと、その患者の記録のタブで、その記載を開く。
//   識別情報の形の字は送らない。探す字はどの表にも残らない
// 電話の幅で横にはみ出さない。AI は試験の代役。文はすべて架空（synthetic）。電話の形は実行時に組み立てる（phi-guard）
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NOTE = 'A) #1 腎盂腎炎\nP) CTRX 2g を開始。尿培養の結果を待つ。';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  medications: [{ name: 'CTRX', dose: '2g', action: 'start', when: null }],
  problems: [{ name: '#1 腎盂腎炎', status: 'diagnosis', activity: null }],
};

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
const contexts: BrowserContext[] = [];
const problems: string[] = [];
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
  problems.length = 0;
  const organizer = fakeOrganizer((text) => ({ ok: true, answer: text.includes('CTRX') ? ANSWER : EMPTY_ORGANIZE }));
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function addNote(page: Page, kind: string, day: string, text: string, count: number): Promise<void> {
  await page.getByTestId(`kind-chip-${kind}`).click();
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill('09:00');
  await page.getByTestId('text').fill(text);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(count);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

async function start(): Promise<Page> {
  const context = await browser.newContext({ ...presets['iPhone 15'], colorScheme: 'light' });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(server.url);
  await page.getByTestId('key').fill(TEST_KEY);
  await page.getByTestId('register').click();
  await page.getByTestId('home').waitFor();
  return page;
}

async function newPatient(page: Page, age: string, startDay: string): Promise<void> {
  await page.getByTestId('new-patient').click();
  await page.getByTestId('age').fill(age);
  await page.getByRole('radio', { name: '女', exact: true }).check();
  await page.getByRole('radio', { name: '入院', exact: true }).check();
  await page.getByTestId('start-day').fill(startDay);
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
}

const fits = (page: Page) =>
  page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= w) return true;
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > w + 0.5)
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.getAttribute('class'))}`)
      .join(' | ');
  });

describe('水分の出入りと体重（段K8）', () => {
  test('日ごとに、書かれた量を同じ単位だけ足す。差は入・出の両方があるときだけ。単位のない値は足さない。いまに1行', async () => {
    const page = await start();
    await newPatient(page, '78', '2026-11-17');
    await addNote(page, 'vital', '2026-11-18', '輸液量 1500 mL 飲水 300 mL 尿量 1200 mL ドレーン排液 80 mL 体重 48.6 kg', 1);
    await addNote(page, 'vital', '2026-11-19', '輸液量 1000 mL 尿量 400 体重 48.2 kg', 2);
    await page.getByTestId('composer-close').click();

    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-fluid').click();
    const days = page.getByTestId('fluid-day');
    await expect.poll(() => days.count()).toBe(2);
    const d1 = days.first();
    expect(await d1.getByTestId('fluid-in-total').textContent()).toBe('書かれた分だけの合計 1800 mL');
    expect(await d1.getByTestId('fluid-out-total').textContent()).toBe('書かれた分だけの合計 1280 mL');
    expect(await d1.getByTestId('fluid-balance').textContent()).toBe('書かれた分の差 +520 mL');
    expect(await d1.getByTestId('fluid-weight').textContent()).toContain('48.6 kg');
    // 2日目：尿量に単位がないので足さない → 出の合計も差も出さない（補わない）
    const d2 = days.nth(1);
    expect(await d2.getByTestId('fluid-skip').textContent()).toContain('単位の記載なし（足していません）');
    expect(await d2.getByTestId('fluid-balance').count()).toBe(0);
    expect(await d2.getByTestId('fluid-weight').textContent()).toContain('−0.4 kg');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.getByTestId('fluid').screenshot({ path: `${SHOTS}/k8-fluid.png` });

    // いま：値のあるいちばん新しい日の1行（書かれた分だけ）
    await page.getByTestId('tab-state').click();
    const line = page.getByTestId('fluid-line');
    expect(await line.textContent()).toContain('11/19・書かれた分だけ');
    expect(await line.textContent()).toContain('入 1000 mL');
    expect(await line.textContent()).not.toContain('出 ');
    expect(await line.textContent()).toContain('体重 48.2 kg（前回から −0.4 kg）');
    expect(problems).toEqual([]);
  });
});

describe('受け持ちから探す（段K8）', () => {
  test('全角・大文字をそろえて探す → 患者ごとの当たり → 押すと、その記載を開く。識別情報の形の字は送らない。探す字は残らない', async () => {
    const page = await start();
    await newPatient(page, '78', '2026-11-17');
    await addNote(page, 'progress_note', '2026-11-18', NOTE, 1);
    await addNote(page, 'progress_note', '2026-11-19', 'S) 発熱は改善。\nP) 抗菌薬を継続。', 2);
    await page.getByTestId('composer-close').click();
    await page.getByTestId('back').click();
    await page.getByTestId('home').waitFor();
    await newPatient(page, '64', '2026-11-19');
    await addNote(page, 'progress_note', '2026-11-20', 'S) 腰痛あり。\nP) 経過をみる。', 1);
    await page.getByTestId('composer-close').click();
    await page.getByTestId('back').click();
    await page.getByTestId('home').waitFor();

    // 識別情報の形の字は送らない（画面で止める）
    const before = JSON.stringify(server.db.raw.prepare('SELECT * FROM sources').all());
    await page.getByTestId('search-input').fill(['090', '1234', '5678'].join('-'));
    await page.getByTestId('search-send').click();
    expect(await page.getByTestId('search-message').textContent()).toContain('送っていません');

    await page.getByTestId('search-input').fill('ｃｔｒｘ');
    await page.getByTestId('search-send').click();
    const results = page.getByTestId('search-results');
    await results.waitFor();
    expect(await page.getByTestId('search-count').textContent()).toContain('1 人・1 か所');
    const patient = page.getByTestId('search-patient');
    expect(await patient.count()).toBe(1);
    expect(await patient.locator('.search-patient-head').textContent()).toContain('78歳');
    expect(await patient.getByTestId('search-match').textContent()).toBe('CTRX');
    expect(await patient.getByTestId('search-hit').textContent()).toContain('薬');

    // 2人に当たる字
    await page.getByTestId('search-input').fill('経過');
    await page.getByTestId('search-send').click();
    await expect.poll(() => page.getByTestId('search-count').textContent()).toContain('「経過」');
    expect(await fits(page)).toBe(true);
    await page.getByTestId('search-input').fill('P)');
    await page.getByTestId('search-send').click();
    await expect.poll(() => page.getByTestId('search-patient').count()).toBe(2);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.getByTestId('search').screenshot({ path: `${SHOTS}/k8-search.png` });
    // 探す字は、どの表にも残らない（記録は変わらない）
    const tables = (server.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    expect(JSON.stringify(tables.map((t) => server.db.raw.prepare(`SELECT * FROM ${t}`).all()))).not.toContain('ｃｔｒｘ');
    expect(JSON.stringify(server.db.raw.prepare('SELECT * FROM sources').all())).toBe(before);

    // 当たりを押すと、その患者の記録のタブで、その記載を開く（いちばん新しい記載ではない、前の日の記載）
    await page.getByTestId('search-input').fill('尿培養');
    await page.getByTestId('search-send').click();
    await expect.poll(() => page.getByTestId('search-count').textContent()).toContain('「尿培養」');
    await page.getByTestId('search-hit').first().click();
    await page.getByTestId('patient-page').waitFor();
    expect(await page.getByTestId('tab-notes').getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('search-found').getByTestId('search-match').textContent()).toBe('尿培養');
    const cards = page.getByTestId('source');
    await expect.poll(() => cards.count()).toBe(2);
    expect(await cards.nth(1).getByTestId('source-summary').getAttribute('aria-expanded')).toBe('true');
    expect(await cards.nth(1).getByTestId('source-text').textContent()).toContain('尿培養の結果を待つ');
    expect(await fits(page)).toBe(true);
    expect(problems).toEqual([]);
  });
});
