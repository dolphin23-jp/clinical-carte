// 画面を離れて戻ったとき（CA-086）の E2E。iPhone でほかのアプリへ移ると、Safari が止まって AI を待っている通信が切れる。それを、
// 画面の見え方（visibilityState）の切り替えと、通信を途中で切る（route.abort）で再現する。時計は Playwright の clock で進める。
// - 整理の通信が切れた：サーバーが仕上げる猶予のあいだは待ち（様子を字で出す）、それでも整理されていなければ、自動で続ける。続いたら、プロブレムリストも自動で組まれる
// - サーバーが仕上げていれば、頼み直さない（AI を二重に呼ばない）
// - 相談のあいだに離れて切れた：戻ったら、同じ問いを1回だけ送り直し、答えが出る
// - 患者の一覧へ移っても、待っていた相談の答えは消えない（患者ごとのメモリ。端末には置かない）
// AI は試験の代役。文はすべて架空（synthetic）
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, type FakeOrganizer, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NOTE = '【現病歴】\n3日前の夕方から悪寒と発熱あり（架空）。\n#1 発熱\nA) 肺炎を疑う\nP) 抗菌薬を検討';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'present_illness', start: '【現病歴】', when: null },
    { label: 'problem_heading', start: '#1 発熱', when: null },
    { label: 'assessment', start: 'A) 肺炎', when: null },
    { label: 'plan', start: 'P) 抗菌薬', when: null },
  ],
  problems: [{ name: '#1 発熱', status: 'problem', activity: null }],
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
  organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, {
    problemList: () => ({ ok: true, answer: { items: [{ name: '市中肺炎疑い', certainty: 'suspected', activity: 'active', threads: ['T1'], course: [], basis: '発熱と、肺炎を疑うとの評価' }] } }),
    consult: (message) => {
      const m = JSON.parse(message) as { records: { ref: string }[] };
      return { ok: true, answer: { statements: [{ section: 'summary', text: '発熱があり、肺炎を疑って抗菌薬を検討している段階。', support: [m.records[0]?.ref ?? ''], citations: [] }], unknown: '' } };
    },
  });
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

/** 画面の見え方を、試験から切り替えられるようにする（ほかのアプリへ移った・戻った） */
const VISIBILITY = `(() => {
  let state = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
  window.__setVisibility = (next) => { state = next; document.dispatchEvent(new Event('visibilitychange')); };
})();`;
const setVisibility = (page: Page, state: 'hidden' | 'visible') =>
  page.evaluate((next) => {
    (window as unknown as { __setVisibility: (s: string) => void }).__setVisibility(next);
  }, state);
const leave = (page: Page) => setVisibility(page, 'hidden');
const back = (page: Page) => setVisibility(page, 'visible');

async function openPatient(): Promise<Page> {
  const context = await browser.newContext({ ...presets['iPhone 15'], colorScheme: 'light' });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(VISIBILITY);
  await page.clock.install();
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
  return page;
}

async function send(page: Page): Promise<void> {
  await page.getByTestId('kind-chip-admission_note').click();
  await page.getByTestId('at-day').fill('2026-11-20');
  await page.getByTestId('at-time').fill('10:30');
  await page.getByTestId('text').fill(NOTE);
  await page.getByTestId('send').click();
}

const organizedOf = (): unknown[] => (server.db.raw.prepare('SELECT organized FROM sources').all() as { organized: unknown }[]).map((r) => r.organized);

describe('画面を離れて戻ったとき（CA-086）', () => {
  test('整理の通信が切れた：猶予のあいだは待ち、整理されていなければ自動で続ける。続いたら、プロブレムリストも組まれる', async () => {
    const page = await openPatient();
    // 整理の頼みが、サーバーに届く前に切れる（ほかのアプリへ移った）
    await page.route('**/api/sources/*/organize', async (route) => {
      await leave(page);
      await route.abort('internetdisconnected');
    });
    await send(page);
    await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => organizedOf()).toEqual([null]);
    expect(organizer.seen).toHaveLength(0);
    await page.unroute('**/api/sources/*/organize');

    // 戻る：サーバーが仕上げているかもしれないので、猶予のあいだは待つ（様子を字で出す）
    await back(page);
    const status = page.getByTestId('resume-status');
    await expect.poll(() => status.textContent(), { timeout: 10_000 }).toContain('サーバーが続けている整理を待っています（1 件）');
    if (SHOTS !== undefined) await status.screenshot({ path: `${SHOTS}/resume-waiting.png` });
    expect(organizer.seen).toHaveLength(0);

    // 猶予が明けても整理されていない → 自動で続ける → 整理され、プロブレムリストも自動で組まれる
    await page.clock.fastForward(36_000);
    await expect.poll(() => organizedOf(), { timeout: 10_000 }).toEqual(['done']);
    expect(organizer.seen).toHaveLength(1);
    await expect.poll(() => organizer.listed.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => status.count()).toBe(0);
    expect(problems).toEqual([]);
  });

  test('サーバーが仕上げていれば、頼み直さない（AI を二重に呼ばない）', async () => {
    const page = await openPatient();
    // 整理の頼みはサーバーに届き、サーバーは仕上げる。答えだけが、画面に届かない（離れているあいだに切れた）
    await page.route('**/api/sources/*/organize', async (route) => {
      await route.fetch();
      await leave(page);
      await route.abort('internetdisconnected');
    });
    await send(page);
    await expect.poll(() => organizedOf(), { timeout: 10_000 }).toEqual(['done']);
    await page.unroute('**/api/sources/*/organize');
    await back(page);
    await page.clock.fastForward(36_000);
    // 戻ったら読み直し、整理済みなので、何もしない
    await expect.poll(() => page.getByTestId('resume-status').count(), { timeout: 10_000 }).toBe(0);
    await page.clock.fastForward(36_000);
    expect(organizer.seen).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  test('相談のあいだに離れて切れた：戻ったら、同じ問いを1回だけ送り直す', async () => {
    const page = await openPatient();
    await send(page);
    await expect.poll(() => organizedOf(), { timeout: 10_000 }).toEqual(['done']);
    await page.getByTestId('composer-close').click();
    await page.getByTestId('fab-consult').click();
    const panel = page.getByTestId('consult');
    await page.route('**/api/patients/*/consult', async (route) => {
      await leave(page);
      await route.abort('internetdisconnected');
    });
    await panel.getByTestId('consult-question').fill('全体の方針をまとめて（架空の問い）');
    await panel.getByTestId('consult-send').click();
    await expect.poll(() => panel.getByTestId('consult-message').textContent(), { timeout: 10_000 }).toContain('つながりが切れました');
    expect(organizer.consulted).toHaveLength(0);
    await page.unroute('**/api/patients/*/consult');
    await back(page);
    await expect.poll(() => panel.getByTestId('consult-statement').count(), { timeout: 10_000 }).toBe(1);
    expect(organizer.consulted).toHaveLength(1);
    expect(await panel.getByTestId('consult-message').count()).toBe(0);
    expect(await panel.getByTestId('consult-asked').textContent()).toContain('全体の方針をまとめて（架空の問い）');
    expect(problems).toEqual([]);
  });

  test('患者の一覧へ移っても、待っていた相談の答えは消えない（開き直すと、窓口が開いたまま答えが見える）', async () => {
    const page = await openPatient();
    await send(page);
    await expect.poll(() => organizedOf(), { timeout: 10_000 }).toEqual(['done']);
    await page.getByTestId('composer-close').click();
    await page.getByTestId('fab-consult').click();
    const panel = page.getByTestId('consult');
    // 答えが届くのを遅らせ、そのあいだに患者の一覧へ移る
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/patients/*/consult', async (route) => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    await panel.getByTestId('consult-question').fill('次に確かめる検査は？');
    await panel.getByTestId('consult-send').click();
    await expect.poll(() => panel.getByTestId('consult-progress').count()).toBe(1);
    await page.getByTestId('back').click();
    await page.getByTestId('patient').first().waitFor();
    release();
    await expect.poll(() => organizer.consulted.length, { timeout: 10_000 }).toBe(1);
    // 開き直す：窓口が開いたまま、答えが入っている（問いも見える）
    await page.getByTestId('patient').first().click();
    await page.getByTestId('patient-page').waitFor();
    await expect.poll(() => page.getByTestId('consult').getByTestId('consult-statement').count(), { timeout: 10_000 }).toBe(1);
    expect(await page.getByTestId('consult').getByTestId('consult-asked').textContent()).toContain('次に確かめる検査は？');
    expect(problems).toEqual([]);
  });

  test('文を入れている途中で切れた：送り待ちに入り、戻ったらすぐ送る（30 秒を待たない）', async () => {
    const page = await openPatient();
    await page.route('**/api/encounters/*/sources', async (route) => {
      await leave(page);
      await route.abort('internetdisconnected');
    });
    await send(page);
    await expect.poll(() => page.getByTestId('composer').textContent(), { timeout: 10_000 }).toContain('送り待ちに入れました');
    expect(server.db.raw.prepare('SELECT count(*) AS n FROM sources').get()).toEqual({ n: 0 });
    await page.unroute('**/api/encounters/*/sources');
    await back(page);
    await expect.poll(() => organizedOf(), { timeout: 10_000 }).toEqual(['done']);
    expect(problems).toEqual([]);
  });
});
