// Casebook へ送る E2E（段K10。CA-073）。
// - 受診の「Casebook へ送る」で、記録の項目が並ぶ（問題・診断・記録の文〔病日〕）。暦日のある文は送れない（理由の種類だけ。字は出さない）
// - 実症例か架空症例かを選ぶまで作れない（既定なし）。作ると、CBH1: で始まるパケットがクリップボードに載る（読み戻すと、選んだ項目と架空の印。暦日なし）
// - 送信済みの印は「Casebook が取り込みました」を押したときだけ。押すと、その項目は送信済み（選べない）。表に文・日付は入らない
// - 症例コードを入れると、次からはその症例に足す。電話の幅で横にはみ出さない。端末の保存先に何も残らない。AI は試験の代役。文はすべて架空（synthetic）
import { decodePacket, type OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NOTE1 = '#1 腎盂腎炎\nA: 発熱は持続（架空）。\nP: 抗菌薬を継続。';
// 暦日（月/日）のある文：送れない。見本は実行時に組み立てる
const NOTE2 = ['【架空】', '11', '/', '22', ' の採血で炎症反応は低下。'].join('');
const NOTE3 = '【架空】解熱し、食事摂取良好。';
const answers = (text: string): OrganizeAnswer => {
  if (text.includes('#1 腎盂腎炎'))
    return {
      ...EMPTY_ORGANIZE,
      segments: [
        { label: 'problem_heading', start: '#1 腎盂腎炎', when: null },
        { label: 'assessment', start: 'A: 発熱は持続', when: null },
        { label: 'plan', start: 'P: 抗菌薬を継続', when: null },
      ],
      problems: [{ name: '#1 腎盂腎炎', status: 'diagnosis', activity: null }],
    };
  return EMPTY_ORGANIZE;
};

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
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
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer: fakeOrganizer((text) => ({ ok: true, answer: answers(text) })) });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openPatient(): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ ...presets['iPhone 15'], colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(server.url);
  await page.getByTestId('key').fill(TEST_KEY);
  await page.getByTestId('register').click();
  await page.getByTestId('home').waitFor();
  await page.getByTestId('new-patient').click();
  await page.getByTestId('age').fill('78');
  await page.getByRole('radio', { name: '女', exact: true }).check();
  await page.getByRole('radio', { name: '入院', exact: true }).check();
  await page.getByTestId('start-day').fill('2026-11-20');
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
  return { page, context };
}

async function note(page: Page, text: string, day: string, time: string, count: number): Promise<void> {
  await page.getByTestId('kind-chip-progress_note').click();
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill(time);
  await page.getByTestId('text').fill(text);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(count);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const links = () => server.db.raw.prepare('SELECT * FROM casebook_links').all() as Record<string, unknown>[];

describe('Casebook へ送る（段K10）', () => {
  test('項目が並び、暦日の文は送れない。実症例か架空症例かを選ぶまで作れない。コピーすると CBH1 のパケット。取り込みましたで印が付く', async () => {
    const { page } = await openPatient();
    await note(page, NOTE1, '2026-11-21', '09:30', 1);
    await note(page, NOTE2, '2026-11-22', '10:00', 2);
    await note(page, NOTE3, '2026-11-23', '09:00', 3);
    await page.getByTestId('composer-close').click();

    await page.getByTestId('encounter-details').locator('summary').click();
    await page.getByTestId('open-casebook').click();
    const panel = page.getByTestId('casebook');
    await panel.waitFor();
    expect(await panel.textContent()).toContain('クリップボードにコピーするだけ');
    expect(await panel.getByTestId('casebook-dates').textContent()).toContain('入院 2026-11-20');
    // 印（種）が、この受診に1つできる（Casebook へは何も送らない）
    await expect.poll(() => links().length).toBe(1);

    const items = panel.getByTestId('casebook-item');
    await expect.poll(() => items.count()).toBeGreaterThanOrEqual(4);
    // 問題と、記録に書かれた確からしさの診断（初めは選ばない）
    const problem = panel.getByTestId('casebook-group-problems').getByTestId('casebook-item').first();
    expect(await problem.textContent()).toContain('#1 腎盂腎炎');
    expect(await problem.getByTestId('casebook-check').isChecked()).toBe(true);
    const dx = panel.getByTestId('casebook-group-problems').getByTestId('casebook-item').nth(1);
    expect(await dx.textContent()).toContain('記録に書かれた確からしさ');
    expect(await dx.getByTestId('casebook-check').isChecked()).toBe(false);
    // 記録の文：病日。暦日のある文は送れない（理由の種類だけ。文の字は出さない）
    const notes = panel.getByTestId('casebook-group-notes').getByTestId('casebook-item');
    expect(await notes.count()).toBe(3);
    expect(await notes.nth(0).textContent()).toContain('第2病日');
    const blocked = panel.locator('[data-testid="casebook-item"][data-state="blocked"]');
    expect(await blocked.count()).toBe(1);
    expect(await blocked.getByTestId('casebook-why').textContent()).toContain('暦日（月/日）');
    expect(await blocked.textContent()).not.toContain('炎症反応は低下');
    expect(await blocked.getByTestId('casebook-check').isDisabled()).toBe(true);

    // 実症例か架空症例かを選ぶまで作れない
    await panel.getByTestId('casebook-copy').click();
    expect(await panel.getByTestId('casebook-errors').textContent()).toContain('実症例か架空症例かを選んでください');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('');

    await panel.getByTestId('casebook-fake').check();
    await panel.getByTestId('casebook-copy').click();
    await expect.poll(() => panel.getByTestId('casebook-message').textContent()).toContain('コピーしました');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.startsWith('CBH1:')).toBe(true);
    const decoded = decodePacket(text);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect([decoded.value.invalid.length, decoded.value.unknownKind.length]).toEqual([0, 0]);
    const packet = decoded.value.packet;
    expect(packet.target).toEqual({ mode: 'new' });
    expect(packet.synthetic).toBe(true);
    expect(packet.patient).toEqual({ ageYears: 78, sex: 'F', setting: 'inpatient' });
    expect(packet.items.map((i) => [i.body.kind, i.day])).toEqual([
      ['problem', 2],
      ['course', 2],
      ['course', 4],
    ]);
    expect(JSON.stringify(packet)).not.toMatch(/\d{4}-\d{2}-\d{2}|炎症反応は低下/u);
    // コピーしただけでは、印を付けない
    expect(links()[0]?.['sent']).toBe('{}');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await panel.screenshot({ path: `${SHOTS}/k10-casebook.png` });

    // Casebook が取り込んだ → 印。その項目は送信済みで選べない。表に文・日付は入らない
    await panel.getByTestId('casebook-taken-button').click();
    await expect.poll(() => panel.locator('[data-testid="casebook-item"][data-state="sent"]').count()).toBe(3);
    const row = links()[0] ?? {};
    expect(Object.keys(JSON.parse(String(row['sent'])) as object)).toHaveLength(3);
    expect(row['packets']).toBe(1);
    expect(JSON.stringify(row)).not.toMatch(/腎盂腎炎|\d{4}-\d{2}-\d{2}/u);

    // 症例コードを入れると、次からはその症例に足す（架空の印は付けない）
    await panel.getByTestId('casebook-code').fill('abc234');
    await panel.getByTestId('casebook-code-save').click();
    await expect.poll(() => panel.getByTestId('casebook-code-shown').textContent()).toBe('ABC234');
    await dx.getByTestId('casebook-check').check();
    await panel.getByTestId('casebook-copy').click();
    await expect.poll(() => panel.getByTestId('casebook-message').textContent()).toContain('（1 項目）をコピーしました');
    const again = decodePacket(await page.evaluate(() => navigator.clipboard.readText()));
    expect(again.ok && again.value.packet.target).toEqual({ mode: 'append', caseCode: 'ABC234' });
    expect(again.ok && again.value.packet.synthetic).toBeUndefined();
    expect(again.ok && again.value.packet.items.map((i) => i.body)).toEqual([{ kind: 'diagnosis', text: '#1 腎盂腎炎', status: 'confirmed' }]);
    expect(await fits(page)).toBe(true);

    // 端末の保存先には何も残らない
    const stored = await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, idb: (await indexedDB.databases()).length, cookie: document.cookie }));
    expect(stored).toEqual({ local: 0, session: 0, idb: 0, cookie: '' });
    expect(problems).toEqual([]);
  });
});
