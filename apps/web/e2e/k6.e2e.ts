// 結果待ち・記録に聞くの E2E（段K6。CA-065・CA-066）。
// - 結果待ち：記録を入れて整理すると、いまのタブに、提出の記載があり結果の記載がまだない検査が、自動で1回並ぶ（AI の整理の印・病日・提出から何日目）。
//   押すと元の字。「結果を確かめた」で畳む（組み直しても引き継ぐ）。結果の記載があるものは畳んで、結果の字へつなぐ
// - 記録に聞く：問いを打つと、根拠の札つきの答え（押すと元の字）・※の印・出さなかった数・見つからなかったこと。問いも答えも保存しない。
//   問いに電話番号の形があれば、送らない。電話の幅で横にはみ出さない。AI は試験の代役。文はすべて架空（synthetic）
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, type FakeOrganizer, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NOTE = '【経過】\n血液培養2セット提出。\n胸部CT 撮影、読影待ち。\n尿定性を提出、亜硝酸陽性。\nK 3.0 と低値。KCl 20mEq を点滴で補正開始。\n家族に病状を説明した。';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  events: [
    { kind: 'test', title: '血液培養2セット提出', when: null },
    { kind: 'test', title: '胸部CT 撮影', when: null },
    { kind: 'test', title: '尿定性を提出', when: null },
    { kind: 'explanation', title: '家族に病状を説明', when: null },
  ],
  medications: [{ name: 'KCl', dose: '20mEq', action: 'start', when: null }],
  measurements: [{ quote: 'K 3.0', when: null, specimen: null }],
  course: [{ quote: '亜硝酸陽性', summary: '尿定性で亜硝酸陽性', category: 'finding', when: null, whenHint: null }],
};
const QUESTION = 'K をいつ、どれだけ補正した？（架空の問い）';

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
    () => ({ ok: true, answer: ANSWER }),
    undefined,
    {
      pending: (message) => {
        const m = JSON.parse(message) as { events: { ref: string; title: string }[]; course: { ref: string; summary: string }[] };
        const ref = (title: string) => m.events.find((e) => e.title === title)?.ref ?? '';
        return {
          ok: true,
          answer: {
            items: [
              { id: ref('血液培養2セット提出'), status: 'pending', results: [] },
              { id: ref('胸部CT 撮影'), status: 'pending', results: [] },
              { id: ref('尿定性を提出'), status: 'resulted', results: [m.course.find((c) => c.summary.includes('亜硝酸'))?.ref ?? ''] },
            ],
          },
        };
      },
      ask: (message) => {
        const m = JSON.parse(message) as { records: { ref: string }[]; medications: { ref: string }[] };
        const r1 = m.records[0]?.ref ?? '';
        return {
          ok: true,
          answer: {
            answer: [
              { text: '第1病日に KCl 20mEq の点滴で補正を始めた。', refs: [{ id: r1, quote: 'KCl 20mEq を点滴で補正開始' }, { id: m.medications[0]?.ref ?? '', quote: '' }] },
              { text: '補正の合計は 60mEq だった。', refs: [{ id: r1, quote: 'K 3.0 と低値' }] },
              { text: '第2病日にも補正した。', refs: [{ id: r1, quote: '第2病日に KCl を追加' }] },
            ],
            notFound: '記録に見つかりませんでした：第2病日以降の補正の記載',
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

async function openWithNote(): Promise<Page> {
  const context = await browser.newContext({ ...presets['iPhone 15'], colorScheme: 'light' });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(server.url);
  await page.getByTestId('key').fill(TEST_KEY);
  await page.getByTestId('register').click();
  await page.getByTestId('home').waitFor();
  await page.getByTestId('new-patient').click();
  await page.getByTestId('age').fill('80');
  await page.getByRole('radio', { name: '女', exact: true }).check();
  await page.getByRole('radio', { name: '入院', exact: true }).check();
  await page.getByTestId('start-day').fill('2026-11-20');
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
  await page.getByTestId('kind-chip-progress_note').click();
  await page.getByTestId('at-day').fill('2026-11-20');
  await page.getByTestId('at-time').fill('10:30');
  await page.getByTestId('text').fill(NOTE);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
  await page.getByTestId('composer-close').click();
  return page;
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('結果待ち（段K6）', () => {
  test('提出の記載があり結果の記載がないものが、自動で1回並ぶ。押すと元の字。「結果を確かめた」で畳む。結果の記載があるものは、結果の字へつなぐ', async () => {
    const page = await openWithNote();
    await page.getByTestId('tab-state').click();
    const panel = page.getByTestId('pending');
    const waiting = panel.getByTestId('pending-waiting').getByTestId('pending-item');
    await expect.poll(() => waiting.count(), { timeout: 15_000 }).toBe(2);
    expect(await panel.locator('h3').textContent()).toContain('結果待ち（提出の記載があり、結果の記載がまだないもの）');
    expect(await panel.locator('h3').textContent()).toContain('AI の整理');
    const first = waiting.first();
    expect(await first.textContent()).toContain('血液培養2セット提出');
    expect(await first.getByTestId('pending-when').textContent()).toContain('第1病日');
    expect(await first.getByTestId('pending-when').textContent()).toContain('提出から 1 日目');
    await first.locator('button').first().click();
    expect(await first.getByTestId('pending-quote').textContent()).toContain('血液培養2セット提出');

    // 結果の記載があるもの：畳んで、結果の字へつなぐ
    await panel.getByTestId('pending-resulted').locator('summary').click();
    const resulted = panel.getByTestId('pending-resulted').getByTestId('pending-item').first();
    expect(await resulted.textContent()).toContain('尿定性を提出');
    await resulted.locator('button').first().click();
    await resulted.getByTestId('pending-result').click();
    expect(await resulted.getByTestId('pending-results').getByTestId('pending-quote').textContent()).toContain('亜硝酸陽性');

    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await panel.screenshot({ path: `${SHOTS}/k6-pending.png` });

    // 結果を確かめた → 結果待ちから外れ、「確かめた・外したもの」に入る（記録に残る）。開くのは1つずつなので、開き直す
    await first.locator('button').first().click();
    await first.getByTestId('pending-mark-checked').click();
    await expect.poll(() => waiting.count()).toBe(1);
    expect(await panel.getByTestId('pending-marked').locator('summary').textContent()).toContain('（1）');
    expect(server.db.raw.prepare('SELECT before, after FROM pending_result_edits').all()).toEqual([{ before: 'none', after: 'checked' }]);
    // 同じ記録では、組み直さない
    await page.getByTestId('tab-problems').click();
    await page.getByTestId('tab-state').click();
    expect(organizer.pended).toHaveLength(1);
    expect(problems).toEqual([]);
  });
});

describe('記録に聞く（段K6）', () => {
  test('根拠の札つきの答え（押すと元の字）・※・出さなかった数・見つからなかったこと。問いも答えも保存しない', async () => {
    const page = await openWithNote();
    await page.getByTestId('tab-state').click();
    const panel = page.getByTestId('ask');
    expect(await panel.getByTestId('ask-caution').textContent()).toBe('記録だけから答えます。書かれていないことは答えません。');
    await panel.getByTestId('ask-question').fill(QUESTION);
    await panel.getByTestId('ask-send').click();
    await expect.poll(() => panel.getByTestId('ask-statement').count(), { timeout: 10_000 }).toBe(2);
    const statements = panel.getByTestId('ask-statement');
    expect(await statements.first().textContent()).toContain('KCl 20mEq の点滴で補正を始めた');
    const chips = statements.first().getByTestId('ask-ref');
    expect(await chips.count()).toBe(2);
    expect(await chips.nth(1).textContent()).toContain('薬 KCl');
    await chips.first().click();
    expect(await statements.first().getByTestId('ask-quote').textContent()).toContain('KCl 20mEq を点滴で補正開始');
    expect(await statements.first().getByTestId('ask-quote').textContent()).toContain('経過（プログレスノート）');
    // 記録に見つからない数には ※
    expect(await statements.nth(1).getByTestId('support-num-mark').allTextContents()).toEqual(['60※']);
    expect(await panel.getByTestId('ask-not-found').textContent()).toContain('記録に見つかりませんでした');
    expect(await panel.getByTestId('ask-rejected').textContent()).toContain('記録の字に見つからない引用の根拠 1 件');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await panel.screenshot({ path: `${SHOTS}/k6-ask.png` });

    // AI に送ったのは資料と問い。問いも答えも、どの表にも残らない
    expect(JSON.parse(organizer.asked[0] ?? '{}')).toMatchObject({ question: QUESTION });
    const tables = (server.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    const dump = JSON.stringify(tables.map((t) => server.db.raw.prepare(`SELECT * FROM ${t}`).all()));
    expect(dump).not.toContain('架空の問い');
    expect(dump).not.toContain('60mEq');

    // 問いに電話番号の形があれば、送らない
    await panel.getByTestId('ask-question').fill(`${['090', '1234', '5678'].join('-')} に連絡したのは？`);
    await panel.getByTestId('ask-send').click();
    expect(await panel.getByRole('alert').textContent()).toContain('電話番号');
    expect(organizer.asked).toHaveLength(1);
    expect(problems).toEqual([]);
  });
});
