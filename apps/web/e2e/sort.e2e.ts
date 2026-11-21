// AI による振り分けの E2E（段J。CA-056・CA-057）：時系列（病歴の出来事・AI が読んだ値・おおよその日時）、AI のプロブレムリスト（いま・問題）、
// まとめて整理し直す。AI は試験の代役。文はすべて架空（synthetic）。
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, type FakeOrganizer, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const HPI = '【現病歴】\n3日前の夕方から悪寒と発熱あり、熱は38.5℃まで上昇。\n昨日、市販の解熱薬を内服したが改善せず。\n#1 発熱\nA) 肺炎を疑う';
const evening = { base: 'note' as const, days: -3, hours: null, minutes: null, time: null, part: 'evening' as const, spanDays: null };
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'present_illness', start: '【現病歴】', when: null },
    { label: 'problem_heading', start: '#1 発熱', when: null },
    { label: 'assessment', start: 'A) 肺炎', when: null },
  ],
  problems: [{ name: '#1 発熱', status: 'problem', activity: null }],
  measurements: [{ quote: '熱は38.5℃まで上昇', when: '3日前の夕方', whenHint: evening, specimen: null, values: [{ name: '体温', value: '38.5', unit: '℃', comparator: null }] }],
  course: [
    { quote: '3日前の夕方から悪寒と発熱あり', summary: '悪寒・発熱が出現', category: 'onset', when: '3日前の夕方', whenHint: evening },
    { quote: '昨日、市販の解熱薬を内服したが改善せず。', summary: '市販の解熱薬を内服（改善なし）', category: 'intake', when: '昨日', whenHint: null },
  ],
};

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
let organizer: FakeOrganizer;
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
  organizer = fakeOrganizer(
    () => ({ ok: true, answer: ANSWER }),
    undefined,
    {
      problemList: () => ({
        ok: true,
        answer: { items: [{ name: '市中肺炎疑い（右下葉）', certainty: 'suspected', activity: 'active', threads: ['T1'], course: ['C1', 'C2'], basis: '3日前からの発熱と、肺炎を疑うとの評価から' }] },
      }),
    },
  );
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openWithHpi(): Promise<Page> {
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
  await page.getByTestId('start-day').fill('2026-11-20');
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
  await page.getByTestId('kind-chip-admission_note').click();
  await page.getByTestId('at-day').fill('2026-11-20');
  await page.getByTestId('at-time').fill('10:30');
  await page.getByTestId('text').fill(HPI);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
  await page.getByTestId('composer-close').click();
  return page;
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('AI による振り分け（段J）', () => {
  test('時系列：病歴の出来事・AI が読んだ値が、日ごと・時刻の順に並ぶ。おおよその印・AI の印。押すと元の字', async () => {
    const page = await openWithHpi();
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-events').click();
    const list = page.getByTestId('timeline-list');
    await list.waitFor();
    const days = await list.getByTestId('timeline-day').allTextContents();
    expect(days.slice(0, 2)).toEqual(['11/17（来院・入院の3日前）', '11/19（来院・入院の1日前）']);
    const rows = await list.getByTestId('timeline-row').allTextContents();
    expect(rows[0]).toContain('17:00');
    expect(rows[0]).toContain('夕方ごろ');
    expect(rows[0]).toContain('悪寒・発熱が出現');
    expect(rows.join(' ')).toContain('体温');
    expect(rows.join(' ')).toContain('市販の解熱薬を内服（改善なし）');
    await list.getByTestId('timeline-row').first().locator('button').click();
    expect(await page.getByTestId('timeline-quote').textContent()).toContain('3日前の夕方から悪寒と発熱あり');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/timeline-iphone.png`, fullPage: true });
  });

  test('プロブレムリスト：記録が入ると自動で組まれ、いまと問題のタブの主な見方になる。名前は AI が整え、書かれた名前も出る。直せる', async () => {
    const page = await openWithHpi();
    await page.getByTestId('tab-state').click();
    await expect.poll(() => page.getByTestId('state-plist-item').count(), { timeout: 10_000 }).toBe(1);
    expect(await page.getByTestId('state-plist-item').textContent()).toContain('#1 市中肺炎疑い（右下葉）');
    await page.getByTestId('tab-problems').click();
    const item = page.getByTestId('plist-item').first();
    await item.getByTestId('plist-item-head').click();
    expect(await item.textContent()).toContain('記録に書かれた名前：#1 発熱');
    expect(await item.textContent()).toContain('悪寒・発熱が出現');
    await item.getByTestId('plist-name').click();
    await item.getByTestId('plist-name-input').fill('市中肺炎（右下葉）');
    await item.getByTestId('plist-name-save').click();
    await expect.poll(() => page.getByTestId('plist-item').first().textContent()).toContain('#1 市中肺炎（右下葉）');
    await page.getByTestId('plist-item').first().getByTestId('plist-hide').click();
    await expect.poll(() => page.getByTestId('plist-hidden').count()).toBe(1);
    expect(organizer.listed.length).toBe(1); // 同じ記録では、組み直さない
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/plist-iphone.png`, fullPage: true });
  });

  test('まとめて整理し直す：記載を1件ずつ整理し直し、終わると記録を読み直す', async () => {
    const page = await openWithHpi();
    await page.getByTestId('tab-notes').click();
    const before = organizer.seen.length;
    await page.getByTestId('sources-reorganize').click();
    await expect.poll(() => page.getByTestId('sources-reorganize').textContent()).toBe('まとめて整理し直す');
    expect(organizer.seen.length).toBe(before + 1);
  });
});
