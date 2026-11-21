// 記録の E2E（段1）：患者を作る → 文を入れる（AI の選別の代役 → 決定論の置き換え）→ 記録と、検査の表に出る。
// 氏名などの見本は、実行時に組み立てる（架空）。AI は、試験の代役（apps/worker/test/support.ts の fakeSelector）。
import { BANNER_LINES, IDENTIFIER_TOKENS } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { SelectorResult } from '../../worker/src/selector.ts';
import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NAME = ['架空', '太郎'].join('');
const PHONE = ['090', '1234', '5678'].join('-');

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
const contexts: BrowserContext[] = [];
const problems: string[] = [];
/** 次の選別の答えを、試験が差し替える（null なら、NAME を指す代役） */
let nextAnswer: SelectorResult | null = null;

beforeAll(async () => {
  app = await buildApp();
  browser = await launch();
});

afterAll(async () => {
  await browser.close();
  await app.remove();
});

beforeEach(async () => {
  nextAnswer = null;
  const known = fakeSelector([{ kind: 'person', quote: NAME }]);
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: { select: (text) => (nextAnswer === null ? known.select(text) : Promise.resolve(nextAnswer)) } });
  problems.length = 0;
});

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function open(preset: 'iPhone 15' | 'Desktop Chrome' = 'iPhone 15'): Promise<Page> {
  const context = await browser.newContext({ ...presets[preset] });
  contexts.push(context);
  const page = await context.newPage();
  page.on('console', (m) => {
    // 4xx・5xx の答えは、ブラウザが「読み込みに失敗」と出す。ここで確かめたい誤りではない
    if (m.type() === 'error' && !/status of (401|422|502)/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith(server.url)) problems.push(`外への要求: ${new URL(r.url()).origin}`);
  });
  await page.goto(server.url);
  await page.getByTestId('key').fill(TEST_KEY);
  await page.getByTestId('register').click();
  await page.getByTestId('home').waitFor();
  return page;
}

async function newPatient(page: Page, age = '72', sex = '男', kind = '入院', day = '2026-11-18'): Promise<void> {
  await page.getByTestId('new-patient').click();
  await page.getByTestId('age').fill(age);
  await page.getByRole('radio', { name: sex, exact: true }).check();
  await page.getByRole('radio', { name: kind, exact: true }).check();
  await page.getByTestId('start-day').fill(day);
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
}

async function send(page: Page, text: string, kind?: string): Promise<void> {
  if (kind !== undefined) await page.getByTestId('kind').selectOption({ label: kind });
  await page.getByTestId('at-day').fill('2026-11-20');
  await page.getByTestId('at-time').fill('09:00');
  await page.getByTestId('text').fill(text);
  await page.getByTestId('send').click();
}

/** 受診の切り替え・直す操作は、畳んだ欄の中（段H）。開いていなければ開く */
async function encounterMenu(page: Page): Promise<void> {
  const d = page.getByTestId('encounter-details');
  if (!(await d.evaluate((el) => (el as HTMLDetailsElement).open))) await d.locator(':scope > summary').click();
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('患者', () => {
  test('年齢・性別・受診で作る。見出しは自動（氏名・ID・病室の欄は、画面にない）', async () => {
    const page = await open();
    await page.getByTestId('new-patient').click();
    const form = page.getByTestId('new-patient-form');
    expect(await form.locator('input').count()).toBe(1 + 3 + 3 + 2); // 年齢、性別3つ、受診3つ、日と時刻
    expect(await form.textContent()).not.toMatch(/病室|ベッド|呼び名/);
    await page.getByTestId('age').fill('72');
    await page.getByRole('radio', { name: '男', exact: true }).check();
    await page.getByTestId('start-day').fill('2026-11-18');
    await page.getByTestId('create-patient').click();
    await page.getByTestId('patient-page').waitFor();
    expect(await page.getByTestId('headline').textContent()).toBe('72歳 男 ｜ 入院 2026-11-18〜');
    // 帯は、患者の画面でも出る
    for (const line of BANNER_LINES) expect(await page.getByTestId('banner').textContent()).toContain(line);

    await page.getByTestId('back').click();
    const rows = page.getByTestId('patient');
    await rows.first().waitFor();
    expect(await rows.count()).toBe(1);
    expect(await rows.first().textContent()).toContain('72歳 男 ｜ 入院 2026-11-18〜');
    expect(await rows.first().textContent()).toContain('記録 0 件');
    expect(problems).toEqual([]);
  });
});

describe('文を入れる', () => {
  test('入れる先の患者が、送るボタンのすぐ上に出る。保存した文は、氏名が置き換わっている。打った氏名は、画面のどこにも残らない', async () => {
    const page = await open();
    await newPatient(page);
    expect(await page.getByTestId('target').textContent()).toContain('72歳 男');
    expect(await page.getByTestId('target').textContent()).toContain('入院 2026-11-18');

    await send(page, `${NAME}、発熱 3 日目。解熱傾向。`, '経過（プログレスノート）');
    const done = page.getByTestId('composer-done');
    await done.waitFor();
    expect(await done.textContent()).toContain('置き換えた場所：氏名 1');
    const text = page.getByTestId('source-text').first();
    await text.waitFor();
    expect(await text.textContent()).toBe(`${IDENTIFIER_TOKENS.person}、発熱 3 日目。解熱傾向。`);
    expect(await page.getByTestId('text').inputValue()).toBe('');
    expect(await page.content()).not.toContain(NAME);
    const card = page.getByTestId('source').first();
    expect(await card.textContent()).toContain('2026-11-20 09:00');
    expect(await card.textContent()).toContain('第3病日');
    expect(await card.textContent()).toContain('経過（プログレスノート）・自分');
    expect(problems).toEqual([]);
  });

  test('選別が通らなかったとき：保存されず、打った文は欄に残る（もう一度送れる）', async () => {
    const page = await open();
    await newPatient(page);
    nextAnswer = { ok: true, answer: { identifiers: [{ kind: 'person', quote: 'いない人', facility: null }] } };
    await send(page, '解熱傾向。食事摂取良好。');
    const error = page.getByTestId('composer-error');
    await error.waitFor();
    expect(await error.textContent()).toContain('文は保存していません');
    expect(await page.getByTestId('text').inputValue()).toBe('解熱傾向。食事摂取良好。');
    expect(await page.getByTestId('source').count()).toBe(0);
    expect(server.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });

    nextAnswer = null;
    await page.getByTestId('send').click();
    await page.getByTestId('source-text').first().waitFor();
    expect(await page.getByTestId('source').count()).toBe(1);
  });

  test('AI につながらないとき：そう知らせ、保存しない', async () => {
    const page = await open();
    await newPatient(page);
    nextAnswer = { ok: false, reason: 'unavailable' };
    await send(page, '解熱傾向。');
    await page.getByTestId('composer-error').waitFor();
    expect(await page.getByTestId('composer-error').textContent()).toContain('AI につながりませんでした');
    expect(await page.getByTestId('text').inputValue()).toBe('解熱傾向。');
  });

  test('最後の網：電話番号の形は、保存の前に置き換わり、件数だけが出る', async () => {
    const page = await open();
    await newPatient(page);
    await send(page, `家族の連絡先 ${PHONE}。`);
    await page.getByTestId('composer-done').waitFor();
    expect(await page.getByTestId('composer-done').textContent()).toContain('電話番号の形 1');
    expect(await page.content()).not.toContain(PHONE);
  });
});

describe('続きを足す（CA-050）', () => {
  test('保存した記載の末尾に文を足せる。足す文も選別を通り、氏名は置き換わる。前の文はそのまま', async () => {
    const page = await open();
    await newPatient(page);
    await send(page, '午前の回診。解熱傾向。', '経過（プログレスノート）');
    await page.getByTestId('composer-done').waitFor();
    const card = page.getByTestId('source').first();
    await card.getByTestId('append').locator(':scope > summary').click();
    await card.getByTestId('append-text').fill(`夕方、${NAME}さんの家族に説明。`);
    await card.getByTestId('append-save').click();
    await expect.poll(() => page.getByTestId('source-text').first().textContent()).toBe(`午前の回診。解熱傾向。\n夕方、${IDENTIFIER_TOKENS.person}さんの家族に説明。`);
    expect(await page.content()).not.toContain(NAME);
    expect(problems).toEqual([]);
  });
});

describe('日をまたいだ記載（CA-047）', () => {
  test('時刻が大きくさかのぼると、入れる前に1回だけ確かめる。答えるまで入れられず、答えは記録の札に出る', async () => {
    const page = await open();
    await newPatient(page);
    await page.getByTestId('kind').selectOption({ label: '看護記録' });
    await page.getByTestId('at-day').fill('2026-11-20');
    await page.getByTestId('text').fill('23:30 不穏あり。');
    expect(await page.getByTestId('composer').getByTestId('next-day').count()).toBe(0);
    await page.getByTestId('text').fill('23:30 不穏あり。\n0:15 報告。\n3:00 BT 37.4');
    const ask = page.getByTestId('composer').getByTestId('next-day');
    await ask.waitFor();
    expect(await ask.textContent()).toContain('23:30 のあとに 00:15');
    expect(await page.getByTestId('send').isDisabled()).toBe(true);
    expect(await page.getByTestId('next-day-yes').textContent()).toBe('翌日（11/21）');
    await page.getByTestId('next-day-yes').click();
    expect(await page.getByTestId('send').isDisabled()).toBe(false);
    await page.getByTestId('send').click();
    await page.getByTestId('composer-done').waitFor();
    // 保存のあと、欄は空になり、確かめも消える
    expect(await page.getByTestId('composer').getByTestId('next-day').count()).toBe(0);
    expect(await page.getByTestId('source').first().textContent()).toContain('0:15 からあとの、日の書かれていない時刻は翌日として読んでいます');
    expect(problems).toEqual([]);
  });

  test('「同じ日」を選ぶと、札は出ない', async () => {
    const page = await open();
    await newPatient(page);
    await page.getByTestId('at-day').fill('2026-11-20');
    await page.getByTestId('text').fill('22:00 発熱。\n6:00 解熱。');
    await page.getByTestId('next-day-no').click();
    await page.getByTestId('send').click();
    await page.getByTestId('composer-done').waitFor();
    expect(await page.getByTestId('source').first().textContent()).not.toContain('翌日として読んでいます');
    expect(problems).toEqual([]);
  });
});

describe('検査・バイタル', () => {
  test('ずらりと打つと、値が表に並ぶ。読めなかった部分は、理由つきで出る。色・矢印は付かない', async () => {
    const page = await open();
    await newPatient(page);
    await send(page, 'WBC 12.3 CRP <0.1 尿潜血 (-) BP 78/40 昨日より改善', '検査結果');
    await page.getByTestId('composer-done').waitFor();
    expect(await page.getByTestId('composer-done').textContent()).toContain('読んだ値 5 件、読めなかった部分 1 か所');
    const unread = page.getByTestId('unread').first();
    expect(await unread.textContent()).toContain('「昨日より改善」');

    await page.getByTestId('tab-course').click();

    await page.getByTestId('tab-values').click();
    const table = page.getByTestId('lab-table');
    await table.waitFor();
    const rows = await table.locator('tbody tr').allTextContents();
    // バイタルが先
    expect(rows).toEqual(['収縮期血圧78', '拡張期血圧40', 'WBC12.3', 'CRP<0.1', '尿潜血(-)']);
    expect(await table.locator('thead').textContent()).toContain('2026-11-20'); // 列は日ごと（段H）
    // 判定を示すもの（色のクラス・矢印）がない
    const html = await table.innerHTML();
    expect(html).not.toMatch(/↑|↓|high|low|abnormal|alert|warn/i);
    expect(problems).toEqual([]);
  });

  test('日を変えて入れると、列が増える（古い順）', async () => {
    const page = await open('Desktop Chrome');
    await newPatient(page);
    await send(page, 'WBC 12.3 CRP 8.5', '検査結果');
    await page.getByTestId('composer-done').waitFor();
    await page.getByTestId('at-day').fill('2026-11-19');
    await page.getByTestId('at-time').fill('06:30');
    await page.getByTestId('text').fill('WBC 15.1');
    await page.getByTestId('send').click();
    await expect.poll(() => page.getByTestId('source').count()).toBe(2);
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-values').click();
    const table = page.getByTestId('lab-table');
    expect(await table.locator('thead th').allTextContents()).toEqual(['項目', '2026-11-19', '2026-11-20']); // 列は日ごと（段H）
    expect(await table.locator('tbody tr').allTextContents()).toEqual(['WBC15.112.3', 'CRP8.5']);
  });
});

describe('受診', () => {
  test('終わり（退院）を入れると、見出しに出る。受診を足すと、切り替えられる', async () => {
    const page = await open();
    await newPatient(page);
    await encounterMenu(page);
    await page.getByTestId('set-end').click();
    await page.getByTestId('end-day').fill('2026-12-01');
    await page.getByTestId('save-end').click();
    await expect.poll(() => page.getByTestId('headline').textContent()).toBe('72歳 男 ｜ 入院 2026-11-18〜2026-12-01');

    await encounterMenu(page);
    await page.getByTestId('add-encounter').click();
    await page.getByTestId('encounter-form').locator('input[type=date]').fill('2026-12-15');
    await page.getByTestId('create-encounter').click();
    await expect.poll(() => page.getByTestId('headline').textContent()).toBe('72歳 男 ｜ 外来 2026-12-15');
    expect(await page.getByTestId('encounters').locator('button').allTextContents()).toEqual(['入院 2026-11-18〜2026-12-01', '外来 2026-12-15']);
    expect(await page.getByTestId('target').textContent()).toContain('外来 2026-12-15');
  });

  test('救急で受けた受診を、同じ受診のまま入院にする（開始の日はそのまま。見出しと受診のチップが入院になる）', async () => {
    const page = await open();
    await newPatient(page, '62', '男', '救急', '2026-11-21');
    expect(await page.getByTestId('headline').textContent()).toContain('救急 2026-11-21');
    await encounterMenu(page);
    await page.getByTestId('set-kind').click();
    expect(await page.getByTestId('kind-inpatient').getAttribute('aria-checked')).toBe('true');
    await page.getByTestId('save-kind').click();
    await expect.poll(() => page.getByTestId('headline').textContent()).toBe('62歳 男 ｜ 入院 2026-11-21〜');
    expect(await page.getByTestId('encounters').locator('button').allTextContents()).toEqual(['入院 2026-11-21〜']);
    expect(await page.getByTestId('set-kind').textContent()).toBe('種類を変える');
  });

  test('終わりを、始まりより前にはできない', async () => {
    const page = await open();
    await newPatient(page);
    await encounterMenu(page);
    await page.getByTestId('set-end').click();
    await page.getByTestId('end-day').fill('2026-11-01');
    await page.getByTestId('save-end').click();
    await page.getByTestId('end-form').getByRole('alert').waitFor();
    expect(await page.getByTestId('end-form').getByRole('alert').textContent()).toContain('始まりの日より前にできません');
  });
});

describe('消す', () => {
  test('文は、確かめてから消す。患者を消すと、一覧からなくなる', async () => {
    const page = await open();
    await newPatient(page);
    await send(page, 'Na 128 K 3.1', '検査結果');
    await page.getByTestId('source').first().waitFor();
    await page.getByTestId('delete-source').click();
    await page.getByTestId('confirm-delete-source').click();
    await expect.poll(() => page.getByTestId('source').count()).toBe(0);
    expect(server.db.raw.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });

    await encounterMenu(page); // 患者を消すは、受診の欄の中（段H）
    await page.getByTestId('delete-patient').click();
    await page.getByTestId('confirm-delete-patient').click();
    await page.getByTestId('home').waitFor();
    expect(await page.getByTestId('patient').count()).toBe(0);
    expect(server.db.raw.prepare('SELECT COUNT(*) AS n FROM patients').get()).toEqual({ n: 0 });
  });
});

describe('電話の幅と、端末の保存先', () => {
  test('患者の画面・検査の表で、横にはみ出さない（表は、表の中で横に動く）。端末には、何も保存しない', async () => {
    const page = await open('iPhone 15');
    await newPatient(page);
    expect(await fits(page)).toBe(true);
    for (const day of ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']) {
      await page.getByTestId('kind').selectOption({ label: '検査結果' });
      await page.getByTestId('at-day').fill(day);
      await page.getByTestId('text').fill('WBC 12300 Hb 8.2 Plt 8.5 CRP 12.34 Na 128 K 3.1 Cr 1.82 BP 120/80');
      await page.getByTestId('send').click();
      await page.getByTestId('composer-done').waitFor();
      await expect.poll(() => page.getByTestId('text').inputValue()).toBe('');
    }
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-values').click();
    await page.getByTestId('lab-table').waitFor();
    expect(await fits(page)).toBe(true);
    await page.getByTestId('tab-notes').click();
    expect(await fits(page)).toBe(true);
    const seen = await page.evaluate(async () => ({
      cookie: document.cookie,
      local: window.localStorage.length,
      session: window.sessionStorage.length,
      databases: (await window.indexedDB.databases()).length,
      caches: (await window.caches.keys()).length,
    }));
    expect(seen).toEqual({ cookie: '', local: 0, session: 0, databases: 0, caches: 0 });
    expect(problems).toEqual([]);
  });
});
