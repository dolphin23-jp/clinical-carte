// AI の仕事を、通信から切り離す（段N2。CA-087）と、保存しない答えを受け取るまで預かる（CA-088）の E2E。
// - 相談の答えを受け取れないまま、ページを読み込み直しても（電話がページを捨てた）、預かった答えが、その患者の相談の窓口に出る。
//   問いの字は、どの表にも残らない。受け取ったら、預かった答えは消える
// - 出した記載も、読み込み直したあとに、その受診の記載の下書きとして開く（まだ保存していない）
// - 画面を離れて様子を聞けなくなっても、相談は送り直さずに（AI を二重に呼ばずに）答えが届く（仕事はサーバーで続いている）
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
    consult: (message) => {
      const m = JSON.parse(message) as { records: { ref: string }[] };
      return { ok: true, answer: { statements: [{ section: 'summary', text: '発熱があり、肺炎を疑って抗菌薬を検討している段階。', support: [m.records[0]?.ref ?? ''], citations: [] }], unknown: '' } };
    },
    document: () => ({ ok: true, answer: { sections: [{ key: 's', text: '悪寒と発熱あり（架空・預かった記載）', refs: ['R1'] }] } }),
  });
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

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

async function openWithNote(): Promise<Page> {
  const context = await browser.newContext({ ...presets['iPhone 15'], colorScheme: 'light' });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(VISIBILITY);
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
  await page.getByTestId('text').fill(NOTE);
  await page.getByTestId('send').click();
  await expect.poll(() => (server.db.raw.prepare('SELECT organized FROM sources').all() as { organized: unknown }[]).map((r) => r.organized), { timeout: 10_000 }).toEqual(['done']);
  await page.getByTestId('composer-close').click();
  return page;
}

const held = (): { kind: string }[] => server.db.raw.prepare('SELECT kind FROM job_results').all() as { kind: string }[];
const dump = (): string => {
  const tables = (server.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  return JSON.stringify(tables.map((t) => server.db.raw.prepare(`SELECT * FROM ${t}`).all()));
};

/** 読み込み直して（電話がページを捨てた）、つながりを戻し、患者を開き直す（読み込み直す前の画面には、答えを受け取らせない） */
async function reloadAndOpen(page: Page): Promise<void> {
  await page.reload();
  await page.unroute('**/api/jobs/*');
  await page.getByTestId('patient').first().click();
  await page.getByTestId('patient-page').waitFor();
}

describe('仕事を通信から切り離す（CA-087）・答えを受け取るまで預かる（CA-088）', () => {
  test('相談の答えを受け取れないまま読み込み直しても、預かった答えが相談の窓口に出る。問いの字は残らない。受け取ったら消える', async () => {
    const page = await openWithNote();
    await page.getByTestId('fab-consult').click();
    // 様子を聞く通信を切る（答えを受け取れない）。仕事はサーバーで続き、答えは預けられる
    await page.route('**/api/jobs/*', (route) => route.abort('internetdisconnected'));
    await page.getByTestId('consult').getByTestId('consult-question').fill('全体の方針をまとめて（架空の問い・照合用）');
    await page.getByTestId('consult').getByTestId('consult-send').click();
    await expect.poll(() => held().map((r) => r.kind), { timeout: 10_000 }).toContain('consult');
    expect(organizer.consulted).toHaveLength(1);
    // 預かっているのは答えだけ（問いの字は、どの表にもない）
    expect(dump()).not.toContain('照合用');
    expect(dump()).toContain('肺炎を疑って抗菌薬を検討している段階');

    await reloadAndOpen(page);
    // 拾った答えで、相談の窓口が開く（問いの字は出さない）
    const panel = page.getByTestId('consult');
    await expect.poll(() => panel.getByTestId('consult-statement').count(), { timeout: 10_000 }).toBe(1);
    expect(await panel.getByTestId('consult-asked').textContent()).toContain('問いの字は残していません');
    expect(await panel.getByTestId('consult-message').textContent()).toContain('読み込み直す前に送った問いの答えを、受け取りました');
    if (SHOTS !== undefined) await panel.screenshot({ path: `${SHOTS}/jobs-picked-consult.png` });
    // 受け取ったので、預かった答えは消える。AI は、もう呼んでいない
    await expect.poll(() => held().filter((r) => r.kind === 'consult').length, { timeout: 10_000 }).toBe(0);
    expect(organizer.consulted).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  test('出した記載も、読み込み直したあとに、その受診の記載の下書きとして開く（まだ保存していない）', async () => {
    const page = await openWithNote();
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-chart').click();
    await page.getByTestId('doc-view').first().waitFor();
    await page.route('**/api/jobs/*', (route) => route.abort('internetdisconnected'));
    await page.getByTestId('doc-generate').click();
    await expect.poll(() => held().map((r) => r.kind), { timeout: 10_000 }).toContain('document');

    await reloadAndOpen(page);
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-chart').click();
    await expect.poll(() => page.getByTestId('doc-section-text').first().textContent(), { timeout: 10_000 }).toContain('預かった記載');
    expect(await page.getByTestId('doc-state').textContent()).toBe('まだ保存していません');
    expect(await page.getByTestId('doc-message').textContent()).toContain('読み込み直す前に頼んだ記載を、受け取って開きました');
    await expect.poll(() => held().filter((r) => r.kind === 'document').length, { timeout: 10_000 }).toBe(0);
    expect(server.db.raw.prepare('SELECT count(*) AS n FROM documents').get()).toEqual({ n: 0 });
    expect(problems).toEqual([]);
  });

  test('画面を離れて様子を聞けなくなっても、相談は送り直さずに（AI を二重に呼ばずに）答えが届く', async () => {
    const page = await openWithNote();
    await page.getByTestId('fab-consult').click();
    const panel = page.getByTestId('consult');
    let cut = true;
    await page.route('**/api/jobs/*', async (route) => {
      if (cut) await route.abort('internetdisconnected');
      else await route.continue();
    });
    await setVisibility(page, 'hidden');
    await panel.getByTestId('consult-question').fill('次に確かめる検査は？');
    await panel.getByTestId('consult-send').click();
    await expect.poll(() => held().map((r) => r.kind), { timeout: 10_000 }).toContain('consult');
    // 戻る：つながりが戻ると、様子を聞き直して、預かった答えを受け取る
    cut = false;
    await setVisibility(page, 'visible');
    await expect.poll(() => panel.getByTestId('consult-statement').count(), { timeout: 20_000 }).toBe(1);
    expect(organizer.consulted).toHaveLength(1);
    expect(await panel.getByTestId('consult-asked').textContent()).toContain('次に確かめる検査は？');
    await expect.poll(() => held().length, { timeout: 10_000 }).toBe(0);
    expect(problems).toEqual([]);
  });
});
