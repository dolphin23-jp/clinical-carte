// AI の臨床支援の E2E（段K5。CA-059・CA-064）：記録が入り、プロブレムリストが組まれると、いまのタブに臨床支援が自動で1回組まれる。
// 問題ごとに、疑う疾患（根拠・足りない情報）・確かめる検査の候補・照合の状態（字と色）・出典（書籍の題と頁・ネットの題と URL）・※の印・（推論）・
// 出さなかった数が出る。書籍とネットの検索に渡すのは問題の名前だけ。電話の幅で横にはみ出さない。AI と RAG は試験の代役。文はすべて架空（synthetic）。
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { BookHit, BookSearcher } from '../../worker/src/references.ts';
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

class FakeBooks implements BookSearcher {
  readonly asked: (readonly string[])[] = [];
  search(queries: readonly string[]): Promise<readonly BookHit[]> {
    this.asked.push(queries);
    return Promise.resolve([{ title: '架空の内科学', path: '呼吸器 > 肺炎', page: '120', snippet: '市中肺炎の診断では、胸部画像で浸潤影を確かめる。' }]);
  }
  check(): Promise<'ok'> {
    return Promise.resolve('ok');
  }
}

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
let organizer: FakeOrganizer;
let books: FakeBooks;
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
  books = new FakeBooks();
  organizer = fakeOrganizer(
    () => ({ ok: true, answer: ANSWER }),
    undefined,
    {
      problemList: () => ({
        ok: true,
        answer: { items: [{ name: '市中肺炎疑い（右下葉）', certainty: 'suspected', activity: 'active', threads: ['T1'], course: ['C1', 'C2'], basis: '3日前からの発熱と、肺炎を疑うとの評価から' }] },
      }),
      research: () => ({ ok: true, hits: [{ title: '架空の学会の肺炎の指針', url: 'https://example.org/pneumonia', citedText: '市中肺炎では、重症度を評価して治療の場を決める。' }] }),
      support: () => ({
        ok: true,
        answer: {
          problems: [
            {
              problem: 'P1',
              differentials: [
                { name: '市中肺炎', reasoning: '悪寒・発熱の出現と 38.5℃ の発熱、肺炎を疑うとの評価', support: ['C1', 'V1', 'T1'], against: [], missing: '胸部画像・呼吸数の記載がない', citations: ['B1'], inference: false },
                { name: '尿路感染症', reasoning: '発熱の原因として残る', support: ['C1'], against: ['T1'], missing: '尿所見の記載がない', citations: [], inference: true },
              ],
              tests: [
                { name: '胸部X線', why: '浸潤影の有無を確かめる', support: ['T1'], citations: ['B1'], inference: false },
                { name: '尿検査', why: '尿路の評価', support: [], citations: [], inference: true },
              ],
              guideline: [
                { statement: '重症度の評価の記載が見当たらない', status: 'gap', support: ['T1'], citations: ['W1'], inference: false },
                { statement: '発熱が 39.2 まで上がったかは記録にない', status: 'unclear', support: ['V1'], citations: [], inference: true },
                { statement: 'セフトリアキソン 2 g/日 を始める', status: 'gap', support: ['T1'], citations: [], inference: true },
              ],
              criteria: [],
              notes: '',
            },
          ],
        },
      }),
    },
  );
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer, books });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openWithHpi(): Promise<Page> {
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

describe('AI の臨床支援（段K5）', () => {
  test('プロブレムリストが組まれると、臨床支援が自動で1回組まれ、問題ごとに疑う疾患・検査・照合・出典・印が出る', async () => {
    const page = await openWithHpi();
    await page.getByTestId('tab-state').click();
    const panel = page.getByTestId('support');
    await expect.poll(() => panel.getByTestId('support-problem').count(), { timeout: 15_000 }).toBe(1);
    expect(await panel.textContent()).toContain('臨床支援の草案です。最終判断は先生です。');
    expect(await panel.locator('h3').textContent()).toContain('臨床支援');
    expect(await panel.locator('h3').textContent()).toContain('AI');
    const problem = panel.getByTestId('support-problem').first();
    expect(await problem.locator('summary').textContent()).toContain('#1 市中肺炎疑い（右下葉）');
    await problem.locator('summary').click();

    const diffs = await problem.getByTestId('support-differential').allTextContents();
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toContain('市中肺炎');
    expect(diffs[0]).toContain('足りない情報：胸部画像・呼吸数の記載がない');
    expect(diffs[0]).toContain('根拠：経過');
    expect(diffs[0]).toContain('出典：書籍 架空の内科学 120');
    expect(diffs[0]).not.toContain('（推論）');
    expect(diffs[1]).toContain('（推論）');
    expect(diffs[1]).toContain('合わない点：記録の問題「#1 発熱」');
    expect(await problem.getByTestId('support-test').allTextContents()).toEqual([expect.stringContaining('胸部X線'), expect.stringContaining('尿検査')]);
    expect(await problem.getByTestId('support-status').allTextContents()).toEqual(['差がある', '分からない']);
    expect(await problem.getByTestId('support-guideline').textContent()).toContain('ネット 架空の学会の肺炎の指針（https://example.org/pneumonia）');
    // 記録・出典に見つからない数には ※
    expect(await problem.getByTestId('support-num-mark').allTextContents()).toEqual(['39.2※']);
    // 出さなかったもの（資料にない用量・出典なし）は、理由と数で出す
    expect(await panel.getByTestId('support-rejected').textContent()).toContain('用量・閾値・目標値らしい数');
    expect(await panel.getByTestId('support-state').textContent()).toContain('書籍 1 件・ネット 1 件');

    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/support-iphone.png`, fullPage: true });

    // 外の検索に渡すのは問題の名前だけ
    expect(books.asked).toEqual([['市中肺炎疑い（右下葉）']]);
    expect(organizer.researched).toEqual([JSON.stringify({ problems: ['市中肺炎疑い（右下葉）'] })]);
    // 同じ記録では、組み直さない
    await page.getByTestId('tab-problems').click();
    await page.getByTestId('tab-state').click();
    expect(organizer.supported).toHaveLength(1);
    expect(await fits(page)).toBe(true);
    expect(problems).toEqual([]);
  });

  test('押して組み直せる（ネットを外すと、書籍だけ）', async () => {
    const page = await openWithHpi();
    await page.getByTestId('tab-state').click();
    await expect.poll(() => page.getByTestId('support-problem').count(), { timeout: 15_000 }).toBe(1);
    await page.getByTestId('support-web').uncheck();
    await page.getByTestId('support-build').click();
    await expect.poll(() => organizer.supported.length).toBe(2);
    await expect.poll(() => page.getByTestId('support-build').textContent()).toBe('AI で組み直す');
    expect(organizer.researched).toHaveLength(1);
    expect(await page.getByTestId('support-state').textContent()).toContain('ネット 0 件');
  });
});
