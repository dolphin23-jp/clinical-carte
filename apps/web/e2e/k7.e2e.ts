// 申し送り・前の記載との違いの E2E（段K7。CA-067・CA-068）。
// - 申し送り：記載の画面で「申し送り」を出す（AI は試験の代役）→ 重症度は空のまま（AI の答えの重症度は出さない）→ 先生が選ぶまで保存できない →
//   選んで保存 → 回診リストに日と重症度の印、「受け持ち全員の申し送り」に1行の要約と残した申し送り（読むだけ。AI を呼ばない）
// - 前の記載との違い：記録のタブで、同じ種類の前の記載があるとき、畳んだ頭に「前回から変わった行 N」「ほぼ前回と同じ」、開くと「前の記載との違い」
// 電話の幅で横にはみ出さない。文はすべて架空（synthetic）
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, type FakeOrganizer, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const N1 = 'S) 咳あり、痰は黄色\nO) BT 37.8 SpO2 95%\n#1 市中肺炎\nA) 抗菌薬に反応あり\nP) セフトリアキソン 2g 継続\n喀痰培養の結果を確認。SpO2 90% 未満なら当直へ連絡';
const N2 = 'S) 咳あり、痰は黄色\nO) BT 36.9 SpO2 97%\n#1 市中肺炎\nA) 抗菌薬に反応あり\nP) セフトリアキソン 2g 継続\n喀痰培養の結果を確認。SpO2 90% 未満なら当直へ連絡';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'subjective', start: 'S) 咳あり', when: null },
    { label: 'objective', start: 'O) BT', when: null },
    { label: 'problem_heading', start: '#1 市中肺炎', when: null },
    { label: 'assessment', start: 'A) 抗菌薬', when: null },
    { label: 'plan', start: 'P) セフトリアキソン', when: null },
  ],
  problems: [{ name: '#1 市中肺炎', status: 'diagnosis', activity: null }],
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
    document: (message) => {
      const m = JSON.parse(message) as { document: { type: string } };
      if (m.document.type !== 'handoff') return { ok: true, answer: { sections: [] } };
      return {
        ok: true,
        answer: {
          sections: [
            // 重症度は AI に書かせない：書いても出さない
            { key: 'severity', text: '不安定', refs: [] },
            { key: 'summary', text: '重症度：不安定\n72歳 男性。#1 市中肺炎 抗菌薬に反応あり', refs: [] },
            { key: 'actions', text: '・喀痰培養の結果を確認', refs: [] },
            { key: 'contingency', text: '・SpO2 90% 未満なら当直へ連絡', refs: [] },
          ],
        },
      };
    },
  });
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function addNote(page: Page, day: string, text: string, count: number): Promise<void> {
  await page.getByTestId('kind-chip-progress_note').click();
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill('09:00');
  await page.getByTestId('text').fill(text);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(count);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

async function openWithNotes(): Promise<Page> {
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
  await page.getByTestId('start-day').fill('2026-11-17');
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
  await addNote(page, '2026-11-18', N1, 1);
  await addNote(page, '2026-11-19', N2, 2);
  await page.getByTestId('composer-close').click();
  return page;
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('申し送り（段K7。I-PASS）', () => {
  test('出す → 重症度は空（AI の重症度は出さない）→ 選ぶまで保存できない → 選んで保存 → 回診リストと「受け持ち全員の申し送り」に出る', async () => {
    const page = await openWithNotes();
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-chart').click();
    await page.getByTestId('doc-type-handoff').click();
    await page.getByTestId('doc-generate').click();
    const doc = page.getByTestId('doc');
    await doc.waitFor({ timeout: 10_000 });
    expect(await doc.locator('.doc-heading').allTextContents()).toEqual(['【重症度（先生が選ぶ）】', '【患者の要約】', '【やること】', '【起こりうることと対応】', '【受け手の確認】']);
    // AI の答えの重症度は、どこにも出ない。選ばれた重症度はない
    expect(await doc.getByTestId('doc-section-text').first().textContent()).toBe('72歳 男性。#1 市中肺炎 抗菌薬に反応あり');
    expect(await doc.getByTestId('handoff-severity').getByRole('radio', { checked: true }).count()).toBe(0);
    expect(await doc.getByTestId('doc-notes').textContent()).toContain('AI が書いた重症度の行 1 件は出していません');
    expect(await page.getByTestId('doc-save').isDisabled()).toBe(true);
    // AI に送った資料：申し送りの資料（いまの状態の行）。重症度の欄はない
    const sent = JSON.parse(organizer.documented[0] ?? '{}') as { handoff: { oneLiner: string } | null; document: { sections: { key: string }[] } };
    expect(sent.handoff?.oneLiner).toContain('72歳 男性');
    expect(sent.document.sections.map((x) => x.key)).toEqual(['summary', 'actions', 'contingency']);

    await doc.getByTestId('handoff-severity-watcher').click();
    expect(await doc.getByTestId('handoff-severity-watcher').getAttribute('aria-checked')).toBe('true');
    // 受け手の確認は、画面のメモリだけ
    await doc.getByTestId('handoff-received').check();
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await doc.screenshot({ path: `${SHOTS}/k7-handoff-doc.png` });
    await page.getByTestId('doc-save').click();
    await expect.poll(() => page.getByTestId('doc-state').textContent()).toBe('保存しました');
    await expect.poll(() => page.getByTestId('doc-saved-item').count()).toBe(1);
    expect(await page.getByTestId('doc-saved-item').textContent()).toContain('重症度：要注意');
    const rows = server.db.raw.prepare('SELECT severity, day, origin FROM handoffs').all();
    expect(rows).toEqual([{ severity: 'watcher', day: '2026-11-19', origin: 'ai' }]);
    expect(server.db.raw.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 0 });
    expect(JSON.stringify(server.db.raw.prepare('SELECT * FROM handoffs').all())).not.toContain('受け手');

    // 回診リスト：日と重症度の印。受け持ち全員の申し送り：1行の要約と、残した申し送り（読むだけ）
    const before = organizer.documented.length;
    await page.getByTestId('back').click();
    await page.getByTestId('home').waitFor();
    await expect.poll(() => page.getByTestId('round-handoff').textContent()).toContain('重症度：要注意');
    expect(await page.getByTestId('round-handoff').textContent()).toContain('申し送り 11/19');
    await page.getByTestId('handoff-all-toggle').click();
    const card = page.getByTestId('handoff-card');
    await expect.poll(() => card.count()).toBe(1);
    expect(await card.getByTestId('handoff-severity-tag').textContent()).toBe('重症度：要注意');
    expect(await card.getByTestId('handoff-oneliner').textContent()).toContain('72歳 男性');
    expect(await card.textContent()).toContain('喀痰培養の結果を確認');
    expect(await card.textContent()).toContain('SpO2 90% 未満なら当直へ連絡');
    expect(organizer.documented.length).toBe(before);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.getByTestId('handoff-all').screenshot({ path: `${SHOTS}/k7-handoff.png` });
    expect(problems).toEqual([]);
  });
});

describe('前の記載との違い（段K7）', () => {
  test('同じ種類の前の記載があれば、畳んだ頭に「前回から変わった行」「ほぼ前回と同じ」。開くと、変わった行と、前にあってこの記載にない行', async () => {
    const page = await openWithNotes();
    await page.getByTestId('tab-notes').click();
    const cards = page.getByTestId('source');
    await expect.poll(() => cards.count()).toBe(2);
    const newest = cards.first();
    expect(await newest.getByTestId('diff-count').textContent()).toBe('前回から変わった行 1');
    expect(await newest.getByTestId('diff-nearly-same').textContent()).toBe('ほぼ前回と同じ');
    // いちばん古い記載には、前の記載がない
    expect(await cards.nth(1).getByTestId('diff-count').count()).toBe(0);
    await newest.getByTestId('diff-toggle').click();
    const diff = newest.getByTestId('note-diff');
    expect(await diff.getByTestId('note-diff-added').allTextContents()).toEqual(['＋ O) BT 36.9 SpO2 97%']);
    expect(await diff.getByTestId('note-diff-same').allTextContents()).toEqual(['S：前の記載と同じ（1 行）', '#1 市中肺炎：前の記載と同じ（4 行）']);
    expect(await diff.getByTestId('note-diff-count').textContent()).toContain('前の記載と同じ行 5');
    await diff.getByTestId('note-diff-removed').locator('summary').click();
    expect(await diff.getByTestId('note-diff-removed').textContent()).toContain('− O) BT 37.8 SpO2 95%');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await newest.screenshot({ path: `${SHOTS}/k7-diff.png` });
    expect(problems).toEqual([]);
  });
});
