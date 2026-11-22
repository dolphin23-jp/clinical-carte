// 予定と実施・電波のないときの入力の E2E（段K9。CA-071・CA-072）。
// - 予定と実施：A/P の予定の行が、いまのタブに自動で1回並ぶ（AI の整理の印・病日・種類・状態の札〔実施の記載あり・予定の日を過ぎて記載なし〕）。
//   押すと元の字。実施の記載へつなぐ。先生の印（中止・不要）で畳み、記録に残る
// - 電波のないとき：つながらないと送り待ちの札とヘッダーの帯が出て、欄が空く。電波が戻ると送られ、記録に入る。
//   サーバーが断ったら、もう送らずに誤りを出し、欄に戻して直せる。読み込み直すと送り待ちは消え、端末の保存先には何も残らない。
//   電話の幅で横にはみ出さない。AI は試験の代役。文はすべて架空（synthetic）
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, type FakeOrganizer, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NOTE1 = '#1 腎盂腎炎\nA: 発熱は持続。\nP: 明日 胸部CT。\n明朝採血。\n抗菌薬は継続。';
const NOTE2 = '胸部CT 施行、肺炎像なし。';
const NOTE3 = '解熱傾向。食事摂取良好。';
const NONE = { base: 'none', days: 0, hours: 0, minutes: 0, time: '', part: 'none', spanDays: 0 } as const;
const answers = (text: string): OrganizeAnswer => {
  if (text.includes('明日 胸部CT'))
    return {
      ...EMPTY_ORGANIZE,
      segments: [
        { label: 'problem_heading', start: '#1 腎盂腎炎', when: null },
        { label: 'assessment', start: 'A: 発熱は持続', when: null },
        { label: 'plan', start: 'P: 明日 胸部CT', when: null },
      ],
    };
  if (text.includes('胸部CT 施行')) return { ...EMPTY_ORGANIZE, events: [{ kind: 'test', title: '胸部CT 施行', when: null }] };
  return EMPTY_ORGANIZE;
};

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
    (text) => ({ ok: true, answer: answers(text) }),
    undefined,
    {
      plans: (message) => {
        const m = JSON.parse(message) as { plans: { ref: string; text: string }[]; events: { ref: string; title: string }[] };
        const p = (t: string) => m.plans.find((x) => x.text.includes(t))?.ref ?? '';
        return {
          ok: true,
          answer: {
            items: [
              { id: p('明日 胸部CT'), kind: 'test', due: { ...NONE, base: 'note', days: 1 }, done: [m.events.find((e) => e.title === '胸部CT 施行')?.ref ?? ''] },
              { id: p('明朝採血'), kind: 'test', due: { ...NONE, base: 'note', days: 1, part: 'morning' }, done: [] },
              { id: p('抗菌薬は継続'), kind: 'not_a_plan', due: NONE, done: [] },
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

async function openPatient(): Promise<{ page: Page; context: BrowserContext }> {
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
  return { page, context };
}

async function write(page: Page, text: string, day: string, time: string): Promise<void> {
  await page.getByTestId('kind-chip-progress_note').click();
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill(time);
  await page.getByTestId('text').fill(text);
  await page.getByTestId('send').click();
}

async function note(page: Page, text: string, day: string, time: string, count: number): Promise<void> {
  await write(page, text, day, time);
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(count);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const sourceCount = (): number => (server.db.raw.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n;

describe('予定と実施（段K9）', () => {
  test('A/P の予定の行が自動で1回並ぶ。状態の札（字と色）・種類・病日。押すと元の字、実施の記載へつなぐ。印で畳み、記録に残る', async () => {
    const { page } = await openPatient();
    await note(page, NOTE1, '2026-11-20', '10:30', 1);
    await note(page, NOTE2, '2026-11-21', '14:00', 2);
    await note(page, NOTE3, '2026-11-22', '09:00', 3);
    await page.getByTestId('composer-close').click();
    await page.getByTestId('tab-state').click();
    const panel = page.getByTestId('plans');
    const open = panel.getByTestId('plans-open').getByTestId('plan-item');
    await expect.poll(() => open.count(), { timeout: 15_000 }).toBe(1);
    expect(await panel.locator('h3').textContent()).toContain('予定と実施（A/P に書いた予定と、その後の記録）');
    expect(await panel.locator('h3').textContent()).toContain('AI の整理');
    const first = open.first();
    expect(await first.getByTestId('plan-text').textContent()).toBe('明朝採血。');
    expect(await first.getByTestId('plan-status').textContent()).toBe('予定の日（11/21）を過ぎて、その後の記載に見つからない');
    expect(await first.getByTestId('plan-status').getAttribute('class')).toContain('plan-past_due');
    expect(await first.getByTestId('plan-when').textContent()).toContain('第1病日');
    expect(await first.textContent()).toContain('検査');
    // 判定の語は使わない
    expect(await panel.textContent()).not.toMatch(/遅れ|漏れ|未実施/u);
    await first.locator('button').first().click();
    expect(await first.getByTestId('plan-quote').textContent()).toContain('明朝採血。');
    expect(await first.textContent()).toContain('#1 腎盂腎炎');

    // 実施の記載が見つかった予定：畳んで、実施の字へつなぐ
    await panel.getByTestId('plans-done').locator('summary').click();
    const done = panel.getByTestId('plans-done').getByTestId('plan-item').first();
    expect(await done.getByTestId('plan-status').textContent()).toBe('実施の記載あり（11/21）');
    await done.locator('button').first().click();
    await done.getByTestId('plan-done-link').click();
    expect(await done.getByTestId('plan-done').getByTestId('plan-quote').textContent()).toContain('胸部CT 施行');
    expect(await panel.getByTestId('plans-counts').textContent()).toContain('予定ではないと整理した 1 行');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await panel.screenshot({ path: `${SHOTS}/k9-plans.png` });

    // 先生の印（中止・不要）で畳む。記録に残る（印の前後だけ）。同じ記録では組み直さない
    await first.locator('button').first().click();
    await first.getByTestId('plan-mark-cancelled').click();
    await expect.poll(() => open.count()).toBe(0);
    expect(await panel.getByTestId('plans-marked').locator('summary').textContent()).toContain('（1）');
    expect(server.db.raw.prepare('SELECT before, after FROM plan_check_edits').all()).toEqual([{ before: 'none', after: 'cancelled' }]);
    const calls = organizer.planned.length;
    await page.getByTestId('tab-problems').click();
    await page.getByTestId('tab-state').click();
    expect(organizer.planned).toHaveLength(calls);
    expect(problems).toEqual([]);
  });
});

describe('電波のないときの入力（段K9）', () => {
  test('つながらないと送り待ち（札と帯）・欄が空く。電波が戻ると、入れた順に送られて記録に入る', async () => {
    const { page, context } = await openPatient();
    await context.setOffline(true);
    await write(page, '【架空】1つ目の経過。解熱傾向。', '2026-11-20', '10:00');
    const cards = page.getByTestId('queue-card');
    await expect.poll(() => cards.count(), { timeout: 10_000 }).toBe(1);
    expect(await page.getByTestId('text').inputValue()).toBe('');
    expect(await cards.first().getByTestId('queue-state').textContent()).toContain('送り待ち（電波が戻ったら送ります。この画面を閉じる・読み込み直すと消えます）');
    expect(await page.getByTestId('composer-done').textContent()).toContain('まだ保存していません');
    // 続けて入れた文は、前の文の後ろに入る（順を守る）
    await write(page, '【架空】2つ目の経過。食事再開。', '2026-11-20', '11:00');
    await expect.poll(() => cards.count()).toBe(2);
    expect(await cards.nth(1).getByTestId('queue-state').textContent()).toContain('前の文が送れていないので、その後に送ります');
    expect(await page.getByTestId('queue-banner').textContent()).toContain('送り待ち 2 件');
    expect(await page.getByTestId('queue-banner').textContent()).toContain('この画面を閉じる・読み込み直すと消えます');
    expect(sourceCount()).toBe(0);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/k9-offline.png`, fullPage: false });
    if (SHOTS !== undefined) await page.getByTestId('queue').screenshot({ path: `${SHOTS}/k9-offline-cards.png` });

    // 電波が戻る → 送られる（いつもの選別を通って保存）→ 記録に入る。帯が消える
    await context.setOffline(false);
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBe(0);
    expect(await page.getByTestId('queue-banner').count()).toBe(0);
    expect(await page.getByTestId('queue-delivered').textContent()).toContain('2 件、保存しました');
    const texts = (server.db.raw.prepare('SELECT text FROM sources ORDER BY id').all() as { text: string }[]).map((r) => r.text);
    expect(texts).toEqual(['【架空】1つ目の経過。解熱傾向。', '【架空】2つ目の経過。食事再開。']);
    expect(server.db.raw.prepare('SELECT COUNT(DISTINCT send_key) AS n FROM sources').get()).toEqual({ n: 2 });
    await page.getByTestId('tab-notes').click();
    await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(2);
    expect(problems).toEqual([]);
  });

  test('サーバーが断ったら、もう送らずに誤りを出し、欄に戻して直せる。読み込み直すと送り待ちは消え、端末の保存先には何も残らない', async () => {
    const { page } = await openPatient();
    // 文を入れる要求だけ、つながらない形にする（ほかの要求は通る）
    let mode: 'abort' | 'reject' = 'abort';
    await page.route('**/api/encounters/*/sources', async (route) => {
      if (mode === 'abort') await route.abort('internetdisconnected');
      else await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'selection_failed', problems: [] }) });
    });
    const typed = '【架空】送り待ちの文。尿量低下。';
    await write(page, typed, '2026-11-20', '10:00');
    const card = page.getByTestId('queue-card');
    await expect.poll(() => card.count(), { timeout: 10_000 }).toBe(1);
    // 「いま送る」：まだつながらない → 待ちに戻る（回数）
    await card.getByTestId('queue-send').click();
    await expect.poll(() => card.getByTestId('queue-state').textContent()).toContain('つながらなかった回数 1');
    // サーバーが断った → もう送らない（誤りの文・帯に数）
    mode = 'reject';
    await card.getByTestId('queue-send').click();
    await expect.poll(() => card.getAttribute('data-state')).toBe('rejected');
    expect(await card.getByTestId('queue-state').textContent()).toContain('識別情報の場所を確かめられませんでした');
    expect(await page.getByTestId('queue-banner').textContent()).toContain('うち送れなかった 1 件');
    expect(await card.getByTestId('queue-send').count()).toBe(0);
    // 欄に戻して直す
    await card.getByTestId('queue-takeback').click();
    expect(await page.getByTestId('text').inputValue()).toBe(typed);
    expect(await page.getByTestId('at-time').inputValue()).toBe('10:00');
    expect(await card.count()).toBe(0);
    expect(await page.getByTestId('queue-banner').count()).toBe(0);

    // もう一度、送り待ちにしてから読み込み直す：閉じる前の確かめ（ブラウザの決まり）が出て、送り待ちは消える
    mode = 'abort';
    await page.getByTestId('send').click();
    await expect.poll(() => card.count(), { timeout: 10_000 }).toBe(1);
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.type());
      void d.accept();
    });
    await page.reload();
    await page.getByTestId('home').waitFor();
    expect(dialogs).toEqual(['beforeunload']);
    expect(await page.getByTestId('queue-banner').count()).toBe(0);
    const stored = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      idb: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
      cookie: document.cookie,
    }));
    expect(stored).toEqual({ local: 0, session: 0, idb: 0, caches: 0, cookie: '' });
    // サーバーにも、送り待ちだった文はない（保存はサーバーが受け付けたときだけ）
    expect(sourceCount()).toBe(0);
    expect(problems).toEqual([]);
  });
});
