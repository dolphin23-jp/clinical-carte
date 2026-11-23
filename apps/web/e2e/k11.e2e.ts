// 指示簿の E2E（段K11。CA-074〜CA-079）。
// - 写す：指示の書かれた架空の記載から、AI（代役）が欄に分ける。案は先生が1つずつ入れるまで保存しない。字は記録の字のまま。
//   点滴に開始・予定の終わりを入れると、経過表に「点滴の予定」の帯（記録の投薬と別）。検査に予定の日時を入れると、予定の印。
//   後の記載の結果が、結果待ちの1回（AI の代役）で検査の予定に結びつき、指示簿の項目の下に出る
// - 組み立てる：テンプレ（空の欄から先生が作る。数は試験用の仮の数）・体重からの流量の計算（式）・AI の案を1つだけ採用（※が残る）・いまのタブの要約
// - 電話の幅で横にはみ出さない。コピーのボタンはない。端末の保存先を使わない。AI は試験の代役。文はすべて架空（synthetic）
import type { OrganizeAnswer, ProposeAnswer, TranscribeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, type FakeOrganizer, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const ORDERS_NOTE = ['【架空】経過', '#1 架空の呼吸不全', 'P:', 'NPPV IPAP 10 / EPAP 5 で継続。', '不穏時 頓用薬Aを1回投与。', '収縮期血圧 90 未満で医師コール。', '輸液A 500 mL を 40 mL/h で持続。', '明朝 採血（血算・生化学）。'].join('\n');
const RESULT_NOTE = '【架空】採血結果：白血球 9800。';
const PLAIN_NOTE = '【架空】経過。解熱傾向。食事は半量。';
const blank = { condition: '', drug: '', dose: '', rate: '', interval: '', duration: '', action: 'none' as const };

const organize = (text: string): OrganizeAnswer =>
  text.includes('採血結果') ? { ...EMPTY_ORGANIZE, course: [{ quote: '採血結果：白血球 9800', summary: '採血結果', category: 'test', when: null, whenHint: null }] } : EMPTY_ORGANIZE;

const transcribe = (): TranscribeAnswer => ({
  items: [
    { category: 'respiratory', quote: 'NPPV IPAP 10 / EPAP 5 で継続。', ...blank, action: 'continue' },
    { category: 'prn', quote: '不穏時 頓用薬Aを1回投与。', ...blank, condition: '不穏時', drug: '頓用薬A', dose: '1回' },
    { category: 'call', quote: '収縮期血圧 90 未満で医師コール。', ...blank, condition: '収縮期血圧 90 未満' },
    { category: 'infusion', quote: '輸液A 500 mL を 40 mL/h で持続。', ...blank, drug: '輸液A', dose: '500 mL', rate: '40 mL/h' },
    { category: 'test', quote: '明朝 採血（血算・生化学）。', ...blank },
    { category: 'not_an_order', quote: '#1 架空の呼吸不全', ...blank },
  ],
});

const propose = (): ProposeAnswer => ({
  items: [
    { category: 'diet', text: '架空の食事 1日 1600 kcal', ...blank, template: '', basis: ['X1'] },
    { category: 'monitor', text: 'SpO2 を連続で測る', ...blank, template: '', basis: ['X1'] },
  ],
});

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
let organizer: FakeOrganizer;
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
  organizer = fakeOrganizer(
    (text) => ({ ok: true, answer: organize(text) }),
    undefined,
    {
      orderTranscribe: () => ({ ok: true, answer: transcribe() }),
      orderPropose: () => ({ ok: true, answer: propose() }),
      pending: (message) => {
        const m = JSON.parse(message) as { orders?: { ref: string }[]; course: { ref: string; summary: string }[]; submitted: string[] };
        const result = m.course.find((c) => c.summary === '採血結果')?.ref;
        return {
          ok: true,
          answer: {
            items: [
              ...(m.orders ?? []).map((o) => (result === undefined ? { id: o.ref, status: 'pending' as const, results: [] } : { id: o.ref, status: 'resulted' as const, results: [result] })),
              ...m.submitted.map((id) => ({ id, status: 'not_a_submission' as const, results: [] })),
            ],
          },
        };
      },
    },
  );
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer });
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
  await page.getByTestId('age').fill('70');
  await page.getByRole('radio', { name: '男', exact: true }).check();
  await page.getByRole('radio', { name: '入院', exact: true }).check();
  await page.getByTestId('start-day').fill('2026-11-20');
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
  return page;
}

async function note(page: Page, text: string, day: string, time: string, count: number): Promise<void> {
  if ((await page.getByTestId('text').count()) === 0) {
    await page.getByTestId('fab-compose').click();
  }
  await page.getByTestId('kind-chip-progress_note').click();
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill(time);
  await page.getByTestId('text').fill(text);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(count);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

async function openOrders(page: Page): Promise<void> {
  await page.getByTestId('tab-course').click();
  await page.getByTestId('tab-orders').click();
  await page.getByTestId('orders').waitFor();
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const sheet = (): { category: string; text: string; origin: string; start: string | null; end: string | null; unseen: string[]; scale: { weightKg: number | null; step: number | null } | null }[] => {
  const row = server.db.raw.prepare('SELECT items FROM order_sheets').get() as { items: string } | undefined;
  return row === undefined ? [] : (JSON.parse(row.items) as ReturnType<typeof sheet>);
};

describe('指示簿を写す（段K11）', () => {
  test('記載の指示を欄に分けて案にし、1つずつ入れる。点滴の予定の帯・検査の予定の印。後の記載の結果が検査の予定に結びつく', async () => {
    const page = await openPatient();
    await note(page, ORDERS_NOTE, '2026-11-20', '10:30', 1);
    await page.getByTestId('composer-close').click();
    await openOrders(page);
    // コピーのボタンはない（病院のカルテへは打ち直す）
    expect(await page.getByTestId('orders').getByRole('button', { name: /コピー/u }).count()).toBe(0);
    await page.getByTestId('orders-transcribe-open').click();
    await page.getByTestId('orders-transcribe').click();
    const cards = page.getByTestId('order-proposal');
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBe(5);
    expect(await cards.first().getByTestId('proposal-text').textContent()).toBe('NPPV IPAP 10 / EPAP 5 で継続。');
    expect(await page.getByTestId('proposal-counts').textContent()).toContain('指示ではないと分けた字 1 件');
    // まだ保存していない
    expect(sheet()).toEqual([]);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.getByTestId('order-proposals').screenshot({ path: `${SHOTS}/k11-transcribe.png` });

    // 1つずつ入れる（字は記録の字のまま）
    await cards.first().getByTestId('proposal-adopt').click();
    await expect.poll(() => cards.count()).toBe(4);
    await cards.first().getByTestId('proposal-adopt').click();
    await expect.poll(() => cards.count()).toBe(3);
    await cards.first().getByTestId('proposal-adopt').click();
    await expect.poll(() => cards.count()).toBe(2);
    // 点滴：開始と予定の終わりを入れてから入れる
    await cards.first().getByTestId('proposal-edit').click();
    const form = cards.first().getByTestId('order-form');
    await form.getByTestId('order-start-day').fill('2026-11-20');
    await form.getByTestId('order-start-time').fill('12:00');
    await form.getByTestId('order-end-day').fill('2026-11-21');
    await form.getByTestId('order-end-time').fill('12:00');
    await form.getByTestId('order-submit').click();
    await expect.poll(() => cards.count()).toBe(1);
    // 検査：予定の日時
    await cards.first().getByTestId('proposal-edit').click();
    await cards.first().getByTestId('order-start-day').fill('2026-11-21');
    await cards.first().getByTestId('order-start-time').fill('06:00');
    await cards.first().getByTestId('order-submit').click();
    // すべて入れ終えたら、案の欄は閉じる
    await expect.poll(() => page.getByTestId('order-proposals').count()).toBe(0);
    await expect.poll(() => sheet().length).toBe(5);
    expect(sheet().map((i) => [i.category, i.origin])).toEqual([
      ['respiratory', 'transcribed'],
      ['prn', 'transcribed'],
      ['call', 'transcribed'],
      ['infusion', 'transcribed'],
      ['test', 'transcribed'],
    ]);
    expect(sheet().find((i) => i.category === 'infusion')).toMatchObject({ text: '輸液A 500 mL を 40 mL/h で持続。', start: '2026-11-20T12:00', end: '2026-11-21T12:00' });
    const orders = page.getByTestId('orders');
    expect(await orders.getByTestId('order-section-respiratory').getByTestId('order-origin').textContent()).toContain('記録の文から写した');
    expect(await orders.getByTestId('order-infusions').getByTestId('order-item').count()).toBe(1);
    expect(await orders.getByTestId('order-section-test').getByTestId('order-no-result').count()).toBe(1);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await orders.screenshot({ path: `${SHOTS}/k11-sheet.png` });

    // 経過表：点滴の予定の帯（記録の投薬と別）と、検査の予定の印
    await page.getByTestId('tab-overview').click();
    await page.getByTestId('range-all').click();
    await expect.poll(() => page.getByTestId('timeline-planned-infusion').count()).toBe(1);
    expect(await page.getByTestId('timeline-planned-test').count()).toBe(1);
    expect(await page.getByTestId('timeline-medications').count()).toBe(0);
    expect(await page.getByTestId('timeline-plan-note').textContent()).toContain('指示簿に入れた予定で、記録の投薬・できごととは別です');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.getByTestId('timeline').screenshot({ path: `${SHOTS}/k11-board.png` });

    // 後の記載の結果 → 結果待ちの1回（自動）で、検査の予定に結びつく → 指示簿の項目の下に出る
    await note(page, RESULT_NOTE, '2026-11-21', '09:00', 2);
    await page.getByTestId('composer-close').click();
    await expect.poll(() => (server.db.raw.prepare('SELECT body FROM pending_results').get() as { body: string } | undefined)?.body ?? '', { timeout: 15_000 }).toContain('"state":"resulted"');
    await openOrders(page);
    const testItem = page.getByTestId('order-section-test').getByTestId('order-item');
    await expect.poll(() => testItem.getByTestId('order-results').count(), { timeout: 10_000 }).toBe(1);
    await testItem.getByTestId('pending-result').click();
    expect(await testItem.getByTestId('pending-quote').textContent()).toContain('採血結果：白血球 9800');
    await page.getByTestId('tab-overview').click();
    await page.getByTestId('range-all').click();
    expect(await page.getByTestId('timeline-planned-test').getAttribute('class')).toContain('resulted');
    expect(problems).toEqual([]);
  });
});

describe('指示簿を組み立てる（段K11）', () => {
  test('テンプレを空の欄から作り、体重で流量を計算する（式）。テンプレから点滴に入れる。AI の案は1つだけ採用し、※が残る。いまのタブの要約', async () => {
    const page = await openPatient();
    await note(page, PLAIN_NOTE, '2026-11-20', '10:30', 1);
    await page.getByTestId('composer-close').click();
    await openOrders(page);

    // テンプレ（空の欄から。数は試験用の仮の数）
    await page.getByTestId('orders-templates-open').click();
    const editor = page.getByTestId('template-editor');
    expect(await editor.getByTestId('template-amount').inputValue()).toBe('');
    await editor.getByTestId('template-name').fill('試験用スケール');
    await editor.getByTestId('template-drug').fill('架空の薬B');
    await editor.getByTestId('template-amount').fill('2');
    await editor.getByTestId('template-volume').fill('50');
    await editor.getByTestId('template-step-label-0').fill('段1');
    await editor.getByTestId('template-step-dose-0').fill('0.05');
    await editor.getByTestId('template-step-add').click();
    await editor.getByTestId('template-step-label-1').fill('段2');
    await editor.getByTestId('template-step-dose-1').fill('0.1');
    await editor.getByTestId('template-preview-weight').fill('60');
    expect(await editor.getByTestId('scale-rate').allTextContents()).toEqual(['→ 4.5 mL/h', '→ 9 mL/h']);
    await editor.getByTestId('scale-formula').first().locator('summary').click();
    expect(await editor.getByTestId('scale-formula').first().textContent()).toContain('0.05 μg/kg/min × 60 kg × 60 min/h ÷ 40 μg/mL = 4.5 mL/h');
    if (SHOTS !== undefined) await editor.screenshot({ path: `${SHOTS}/k11-template.png` });
    await editor.getByTestId('template-save').click();
    await expect.poll(() => page.getByTestId('template-item').count()).toBe(1);
    const tpl = server.db.raw.prepare('SELECT * FROM order_templates').get() as Record<string, unknown>;
    expect(Object.keys(tpl).sort()).toEqual(['body', 'created_at', 'id', 'removed_at', 'updated_at']);

    // テンプレから点滴に入れる → 体重といまの段 → 流量
    await page.getByTestId('orders-template-open').click();
    await page.getByTestId('orders-template-day').fill('2026-11-20');
    await page.getByTestId('orders-template-time').fill('13:00');
    await page.getByTestId('orders-template-insert').click();
    const block = page.getByTestId('order-infusions').getByTestId('scale-block');
    await block.waitFor();
    await block.getByTestId('scale-weight').fill('60');
    await block.getByTestId('scale-save').click();
    await expect.poll(() => sheet()[0]?.scale?.weightKg).toBe(60);
    await page.getByTestId('order-infusions').getByTestId('scale-step').selectOption('0');
    await expect.poll(() => sheet()[0]?.scale?.step).toBe(0);
    const rates = page.getByTestId('order-infusions').getByTestId('scale-rate');
    expect(await rates.allTextContents()).toEqual(['→ 4.5 mL/h', '→ 9 mL/h']);
    expect(await page.getByTestId('order-infusions').textContent()).toContain('いまの段');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.getByTestId('order-infusions').screenshot({ path: `${SHOTS}/k11-scale.png` });

    // AI の案：1つだけ採用。資料にない数には※。採用しない案は保存しない
    await page.getByTestId('orders-propose-open').click();
    await page.getByTestId('orders-propose').click();
    const cards = page.getByTestId('order-proposal');
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBe(2);
    expect(await cards.first().getByTestId('support-num-mark').allTextContents()).toEqual(['1600※']);
    expect(await cards.first().getByTestId('proposal-unseen').count()).toBe(1);
    expect(organizer.proposed[0]).toContain('試験用スケール');
    if (SHOTS !== undefined) await page.getByTestId('order-proposals').screenshot({ path: `${SHOTS}/k11-propose.png` });
    await cards.first().getByTestId('proposal-adopt').click();
    await expect.poll(() => sheet().length).toBe(2);
    expect(sheet()[1]).toMatchObject({ category: 'diet', origin: 'ai', unseen: ['1600'] });
    await expect.poll(() => cards.count()).toBe(1);
    const diet = page.getByTestId('order-section-diet').getByTestId('order-item');
    expect(await diet.getByTestId('order-origin').textContent()).toContain('AI の案');
    expect(await diet.getByTestId('support-num-mark').count()).toBe(1);

    // いまのタブの要約（指示中の項目を欄ごと）
    await page.getByTestId('tab-state').click();
    const summary = page.getByTestId('orders-summary');
    await summary.waitFor();
    expect(await summary.getByTestId('orders-summary-row').allTextContents()).toEqual(['食事 架空の食事 1日 1600 kcal（AI の案）', '点滴 架空の薬B']);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await summary.screenshot({ path: `${SHOTS}/k11-state.png` });

    // 端末の保存先に何も残さない
    const stored = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, idb: (await indexedDB.databases()).length, cookie: document.cookie }));
    expect(stored).toEqual({ local: 0, session: 0, idb: 0, cookie: '' });
    expect(problems).toEqual([]);
  });
});
