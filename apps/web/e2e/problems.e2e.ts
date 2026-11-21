// 問題の筋の E2E（段3a）：記載を入れると、問題が筋に束ねられ、名前の移り変わり・いちばん新しい A/P・解決と書かれたものが出る。
// 直す（移す・分ける・統合・表示の名前）と、その記録。AI は試験の代役。文はすべて架空。
import type { LinkAnswer, OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { LinkerResult } from '../../worker/src/organizer.ts';
import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const D1 = '#1 発熱\nS) 悪寒あり\nA) 感染源は検索中\nP) 血液培養を提出\n#2 低K血症\nA) 経口で補充';
const D2 = '#1 市中肺炎\nS) 咳嗽は軽減\nA) 抗菌薬に反応している\nP) 抗菌薬を継続\n#2 低K血症 解決';

const ANSWERS: Record<string, OrganizeAnswer> = {
  [D1]: {
    ...EMPTY_ORGANIZE,
    segments: [
      { label: 'problem_heading', start: '#1 発熱' },
      { label: 'subjective', start: 'S) 悪寒' },
      { label: 'assessment', start: 'A) 感染源' },
      { label: 'plan', start: 'P) 血液' },
      { label: 'problem_heading', start: '#2 低K血症' },
      { label: 'assessment', start: 'A) 経口' },
    ],
    problems: [
      { name: '#1 発熱', status: 'problem', activity: null },
      { name: '#2 低K血症', status: 'problem', activity: null },
    ],
  },
  [D2]: {
    ...EMPTY_ORGANIZE,
    segments: [
      { label: 'problem_heading', start: '#1 市中肺炎' },
      { label: 'subjective', start: 'S) 咳嗽' },
      { label: 'assessment', start: 'A) 抗菌薬に' },
      { label: 'plan', start: 'P) 抗菌薬を' },
      { label: 'problem_heading', start: '#2 低K血症 解決' },
    ],
    problems: [
      { name: '#1 市中肺炎', status: 'diagnosis', activity: null },
      { name: '#2 低K血症', status: 'problem', activity: 'resolved' },
    ],
  },
};

const D4 = '#1 市中肺炎\nO) CRP 6.8 WBC 10.1\nA) 改善傾向\nP) セフトリアキソン 2g 継続\n#2 低Na血症\nA) 経過観察\nNa 132';
ANSWERS[D4] = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 市中肺炎' },
    { label: 'objective', start: 'O) CRP' },
    { label: 'assessment', start: 'A) 改善' },
    { label: 'plan', start: 'P) セフ' },
    { label: 'problem_heading', start: '#2 低Na血症' },
    { label: 'assessment', start: 'A) 経過観察' },
  ],
  problems: [
    { name: '#1 市中肺炎', status: 'diagnosis', activity: null },
    { name: '#2 低Na血症', status: 'problem', activity: null },
  ],
  medications: [{ name: 'セフトリアキソン', dose: '2g', action: 'continue', when: null }],
  measurements: [{ quote: 'CRP 6.8 WBC 10.1', when: null }, { quote: 'Na 132', when: null }],
};

/** つなぎの代役：「市中肺炎」を「発熱」の筋につなぐ（つなげる設定のときだけ） */
let linkPneumonia = true;
const link = (message: string): LinkerResult => {
  const data = JSON.parse(message) as { problems: { ref: string; names: string[] }[]; added: { ref: string; name: string }[] };
  const fever = data.problems.find((p) => p.names.includes('#1 発熱'))?.ref;
  const pneu = data.added.find((a) => a.name === '#1 市中肺炎')?.ref;
  const links: LinkAnswer['links'] = linkPneumonia && fever !== undefined && pneu !== undefined ? [{ added: pneu, same_as: fever }] : [];
  return { ok: true, answer: { links } };
};

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
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
  linkPneumonia = true;
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer: fakeOrganizer((text) => ({ ok: true, answer: ANSWERS[text] ?? EMPTY_ORGANIZE }), link) });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openPatient(): Promise<Page> {
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
  await page.getByTestId('start-day').fill('2026-11-17');
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
  return page;
}

async function send(page: Page, text: string, day: string): Promise<void> {
  const before = await page.getByTestId('source').count();
  await page.getByTestId('kind-chip-progress_note').click();
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill('09:00');
  await page.getByTestId('text').fill(text);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(before + 1);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('問題の筋', () => {
  test('同じ問題が1つの筋に束ねられ、名前の移り変わりと、いちばん新しい A/P が出る。解決と書かれたものは分かれて出る', async () => {
    const page = await openPatient();
    await send(page, D1, '2026-11-17');
    await send(page, D2, '2026-11-18');
    await page.getByTestId('tab-problems').click();

    const current = page.getByTestId('thread-group-current');
    await current.waitFor();
    const card = current.getByTestId('problem-line');
    expect(await card.count()).toBe(1);
    expect(await card.getByTestId('thread-name').textContent()).toBe('#1 市中肺炎');
    expect(await card.getByTestId('thread-names').textContent()).toContain('#1 発熱（2026-11-17 09:00） → #1 市中肺炎（2026-11-18 09:00）');
    const note = await card.getByTestId('thread-note').first().textContent();
    expect(note).toContain('A) 抗菌薬に反応している');
    expect(note).toContain('P) 抗菌薬を継続');
    expect(note).not.toContain('S) 咳嗽'); // S・O は出さない（A・P だけ）
    expect(await card.textContent()).toContain('これまでの記載の A・P（1 件）');

    const closed = page.getByTestId('thread-group-closed');
    expect(await closed.getByTestId('thread-name').textContent()).toBe('#2 低K血症');
    expect(await closed.textContent()).toContain('解決と書かれている');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/problems-iphone.png`, fullPage: true });
  });

  test('AI がつながなかった名前の変化は、本人が「統合する」でつなげる。表示の名前を選べる。直した記録が残る', async () => {
    linkPneumonia = false;
    const page = await openPatient();
    await send(page, D1, '2026-11-17');
    await send(page, D2, '2026-11-18');
    await page.getByTestId('tab-problems').click();
    const current = page.getByTestId('thread-group-current');
    await current.waitFor();
    expect(await current.getByTestId('problem-line').count()).toBe(2);

    // 「#1 市中肺炎」を「#1 発熱」へ統合
    const pneu = current.getByTestId('problem-line').filter({ has: page.getByTestId('thread-name').filter({ hasText: '#1 市中肺炎' }) });
    await pneu.getByTestId('thread-edit').locator('summary').click();
    const target = await pneu.getByTestId('thread-merge-to').locator('option', { hasText: '#1 発熱' }).getAttribute('value');
    await pneu.getByTestId('thread-merge-to').selectOption(target ?? '');
    await pneu.getByTestId('thread-merge').click();
    await expect.poll(() => current.getByTestId('problem-line').count()).toBe(1);
    expect(await current.getByTestId('thread-name').textContent()).toBe('#1 市中肺炎');

    // 表示の名前を、書かれた名前から選ぶ
    const card = current.getByTestId('problem-line');
    await card.getByTestId('thread-edit').locator('summary').click();
    await card.getByTestId('thread-display-name').selectOption('#1 発熱');
    await expect.poll(() => current.getByTestId('thread-name').textContent()).toBe('#1 発熱');

    // 分ける：最初の記載を、新しい問題へ
    const editor = current.getByTestId('problem-line').getByTestId('thread-edit');
    if ((await editor.getAttribute('open')) === null) await editor.locator('summary').click();
    const row = editor.getByTestId('mention-row').filter({ hasText: '#1 市中肺炎' });
    await row.getByTestId('mention-move-to').selectOption('new');
    await row.getByTestId('mention-move').click();
    await expect.poll(() => current.getByTestId('problem-line').count()).toBe(2);

    const history = page.getByTestId('thread-history');
    await history.locator('summary').click();
    const text = await history.textContent();
    expect(text).toContain('直した記録（3）');
    expect(text).toContain('に統合した');
    expect(text).toContain('表示の名前を、「#1 発熱」にした');
    expect(text).toContain('記載「#1 市中肺炎」を');
    expect(await fits(page)).toBe(true);
  });
});

describe('いまの状態（段3b）', () => {
  test('最初に開くと、1行の要約・いまの問題と最後の A・P・24時間・投薬・背景が出る。字は保存した文のまま', async () => {
    const page = await openPatient();
    await send(page, D1, '2026-11-17');
    await send(page, D2, '2026-11-18');
    await page.getByTestId('tab-state').click();
    const state = page.getByTestId('state');
    await state.waitFor();
    expect(await page.getByTestId('one-liner').textContent()).toBe('72歳 男性。入院 2026-11-17〜（記録の上では 2病日まで）。いまの問題：#1 市中肺炎。');
    expect(await page.getByTestId('state-asof').textContent()).toContain('記録の上で最後：2026-11-18 09:00');
    const note = await page.getByTestId('state-note').first().textContent();
    expect(note).toContain('A) 抗菌薬に反応している');
    expect(note).toContain('P) 抗菌薬を継続');
    expect(await page.getByTestId('state-closed').textContent()).toContain('解決・非活動と書かれたもの：#2 低K血症');
    const recent = (await page.getByTestId('state-recent-item').allTextContents()).join(' ');
    expect(recent).toContain('#2 低K血症（解決と書かれている）');
    // 判定の語を出さない
    expect(await state.textContent()).not.toMatch(/異常|正常値|高値|低値|警告|悪化/u);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/state-iphone.png`, fullPage: true });
    await page.getByTestId('state-to-problems').click();
    expect(await page.getByTestId('tab-problems').getAttribute('aria-selected')).toBe('true');
  });
});

describe('問題の記載に書かれた値・薬（段3c）と、回診リスト（段3d）', () => {
  test('問題の記載の中に書かれた検査の推移と薬が、その問題に出る。ほかの問題の範囲のものは出ない', async () => {
    const page = await openPatient();
    // 先に検査結果だけの記載（CRP の推移の点を足す）
    await page.getByTestId('kind-chip-lab').click();
    await page.getByTestId('at-day').fill('2026-11-17');
    await page.getByTestId('at-time').fill('06:00');
    await page.getByTestId('text').fill('CRP 12.4 WBC 14.2 Na 130');
    const before = await page.getByTestId('source').count();
    await page.getByTestId('send').click();
    await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(before + 1);
    await send(page, D4, '2026-11-19');

    await page.getByTestId('tab-problems').click();
    const pneu = page.getByTestId('problem-line').filter({ has: page.getByTestId('thread-name').filter({ hasText: '#1 市中肺炎' }) });
    const related = pneu.getByTestId('thread-related');
    await related.locator('summary').click();
    const names = await related.getByTestId('trend').locator('.trend-name').allTextContents();
    expect(names.sort()).toEqual(['CRP', 'WBC']); // Na は #2 の範囲なので、#1 には出ない
    expect(await related.getByTestId('thread-related-meds').textContent()).toContain('セフトリアキソン');
    const hypoNa = page.getByTestId('problem-line').filter({ has: page.getByTestId('thread-name').filter({ hasText: '#2 低Na血症' }) });
    await hypoNa.getByTestId('thread-related').locator('summary').click();
    expect(await hypoNa.getByTestId('thread-related').getByTestId('trend').locator('.trend-name').allTextContents()).toEqual(['Na']);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/related-iphone.png`, fullPage: true });

    // 「いま」にも、記載に書かれた値の最新と薬
    await page.getByTestId('tab-state').click();
    const values = page.getByTestId('state-problem-values').first();
    expect(await values.textContent()).toContain('CRP 6.8');
    expect(await page.getByTestId('state-problem-meds').first().textContent()).toContain('セフトリアキソン 継続');

    // 回診リスト：いまの問題・記録の上での病日・最後の日時
    await page.getByTestId('back').click();
    const row = page.getByTestId('patient').first();
    await row.waitFor();
    expect(await row.getByTestId('round-problems').textContent()).toBe('3病日（記録の上で）#1 市中肺炎、#2 低Na血症');
    expect(await row.textContent()).toContain('記録の上で最後：2026-11-19 09:00');
    expect(await page.getByTestId('round-active').count()).toBe(1);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/rounds-iphone.png`, fullPage: true });
  });
});
