// 整理の E2E（段2）：文を入れると、続けて整理され、見出しの区切り・投薬・問題・できごとが出る。AI は、試験の代役。
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { OrganizerResult } from '../../worker/src/organizer.ts';
import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NOTE = '#1 市中肺炎\nS) 咳嗽は軽減。\nO) BT 37.2。昨日 BT 38.4。\nP) メロペネム 1g 8時間毎 を継続。11/19 胸部X線を撮影。K 3.5 を目標に補正。';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'subjective', start: 'S)', when: null },
    { label: 'objective', start: 'O)', when: null },
    { label: 'plan', start: 'P)', when: null },
  ],
  medications: [
    { name: 'メロペネム', dose: '1g 8時間毎', action: 'continue', when: null },
    { name: 'バンコマイシン', dose: null, action: 'start', when: null },
  ],
  events: [{ kind: 'test', title: '胸部X線を撮影', when: '11/19' }],
  problems: [{ name: '#1 市中肺炎', status: 'problem', activity: null }],
  measurements: [
    { quote: 'BT 37.2', when: null, specimen: null },
    { quote: 'BT 38.4', when: '昨日', specimen: null },
  ],
};

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
const contexts: BrowserContext[] = [];
let next: OrganizerResult = { ok: true, answer: ANSWER };

beforeAll(async () => {
  app = await buildApp();
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
  await app.remove();
});
beforeEach(async () => {
  next = { ok: true, answer: ANSWER };
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer: fakeOrganizer(() => next) });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openPatient(preset: 'iPhone 15' | 'Desktop Chrome' = 'iPhone 15'): Promise<Page> {
  const context = await browser.newContext({ ...presets[preset] });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByTestId('key').fill(TEST_KEY);
  await page.getByTestId('register').click();
  await page.getByTestId('home').waitFor();
  await page.getByTestId('new-patient').click();
  await page.getByTestId('age').fill('72');
  await page.getByRole('radio', { name: '男', exact: true }).check();
  await page.getByTestId('start-day').fill('2026-11-18');
  await page.getByTestId('create-patient').click();
  await page.getByTestId('patient-page').waitFor();
  return page;
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('kind').selectOption({ label: '経過（プログレスノート）' });
  await page.getByTestId('at-day').fill('2026-11-20');
  await page.getByTestId('at-time').fill('09:00');
  await page.getByTestId('text').fill(text);
  await page.getByTestId('send').click();
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

describe('整理', () => {
  test('文を入れると、続けて整理され、見出しで区切って出る。確かめられなかったものは、件数だけが出る', async () => {
    const page = await openPatient();
    await send(page, NOTE);
    const status = page.getByTestId('composer-organizing');
    await expect.poll(() => status.textContent()).toContain('整理しました');
    expect(await status.textContent()).toContain('投薬：引用が文になかった 1');
    await expect.poll(() => page.getByTestId('segment-label').allTextContents()).toEqual(['S', 'O', 'P（方針）']);
    // 文そのものは、1字も変わらない（区切りの見出しを除いて、同じ字が並ぶ）
    const shown = (await page.getByTestId('source-text').first().locator('.source-text').allTextContents()).join('\n');
    expect(shown).toBe(NOTE);
    expect(await page.getByTestId('organize-source').first().textContent()).toBe('整理し直す');
  });

  test('投薬・問題・できごと・検査のタブに、整理した事実が出る（文にない薬は出ない）', async () => {
    const page = await openPatient();
    await send(page, NOTE);
    await expect.poll(() => page.getByTestId('segment-label').count()).toBe(3);

    await page.getByTestId('tab-course').click();

    await page.getByTestId('tab-medications').click();
    const meds = page.getByTestId('medication-line');
    await meds.first().waitFor();
    expect(await meds.count()).toBe(1);
    expect(await meds.first().textContent()).toContain('メロペネム');
    expect(await meds.first().textContent()).toContain('継続1g 8時間毎');
    expect(await page.getByTestId('medications').textContent()).not.toContain('バンコマイシン');

    await page.getByTestId('tab-problems').click();
    expect(await page.getByTestId('problem-line').first().textContent()).toContain('#1 市中肺炎');

    await page.getByTestId('tab-course').click();

    await page.getByTestId('tab-events').click();
    expect(await page.getByTestId('event-line').first().textContent()).toContain('2026-11-19');
    expect(await page.getByTestId('event-line').first().textContent()).toContain('胸部X線を撮影');

    await page.getByTestId('tab-course').click();

    await page.getByTestId('tab-values').click();
    const table = page.getByTestId('lab-table');
    await table.waitFor();
    expect(await table.locator('tbody tr').allTextContents()).toEqual(['体温38.437.2']);
    expect(await fits(page)).toBe(true);
  });

  test('振り分けられなかった字（段K1）：どの見方にも出ていない字を、記載の札の数と、開いた字で出す', async () => {
    const page = await openPatient();
    await send(page, NOTE);
    await expect.poll(() => page.getByTestId('segment-label').count()).toBe(3);
    // S の「咳嗽は軽減」は、どの事実にも入らず、S の区切りは引用で出す種類ではない
    const left = page.getByTestId('leftovers').first();
    await left.waitFor();
    expect(await page.getByTestId('leftover-count').first().textContent()).toBe('振り分けられなかった字 1');
    await left.locator('summary').click();
    expect(await left.locator('li').allTextContents()).toEqual(['「咳嗽は軽減」']);
    expect(await fits(page)).toBe(true);
  });

  test('いまの投薬に開始から何日目、デバイスに入れてから何日目（段K1）', async () => {
    next = {
      ok: true,
      answer: {
        ...EMPTY_ORGANIZE,
        medications: [{ name: 'セフトリアキソン', dose: '2g', action: 'start', when: '11/18' }],
        events: [
          { kind: 'procedure', title: 'CV 挿入', when: '11/18' },
          { kind: 'procedure', title: '尿道カテーテル留置', when: '11/18' },
          { kind: 'procedure', title: '尿道カテーテル抜去', when: '11/19' },
        ],
      },
    };
    const page = await openPatient('Desktop Chrome');
    await send(page, '11/18 セフトリアキソン 2g 開始。11/18 CV 挿入。11/18 尿道カテーテル留置。11/19 尿道カテーテル抜去。');
    await expect.poll(() => page.getByTestId('organize-source').first().textContent()).toBe('整理し直す');
    await page.getByTestId('tab-state').click();
    const meds = page.getByTestId('state-medications');
    await meds.locator('summary').click();
    expect(await page.getByTestId('state-med-day').allTextContents()).toEqual(['開始から 3 日目']);
    const devices = page.getByTestId('state-devices');
    expect(await devices.locator('summary').textContent()).toContain('CV・3 日目');
    await devices.locator('summary').click();
    expect(await page.getByTestId('state-device').allTextContents()).toEqual([expect.stringContaining('CV・3 日目抜去の記載なし'), expect.stringContaining('尿道カテーテル・2 日間抜去')]);
    expect(await fits(page)).toBe(true);
  });

  test('整理に失敗しても、文は保存されている。「整理する」で、あとから整理できる', async () => {
    const page = await openPatient();
    next = { ok: false, reason: 'unavailable' };
    await send(page, NOTE);
    const status = page.getByTestId('composer-organizing');
    await expect.poll(() => status.textContent()).toContain('整理できませんでした');
    expect(await status.textContent()).toContain('文は保存してあります');
    await page.getByTestId('source').first().waitFor();
    expect(await page.getByTestId('source').first().textContent()).toContain('整理できませんでした');
    expect(await page.getByTestId('segment-label').count()).toBe(0);

    next = { ok: true, answer: ANSWER };
    await page.getByTestId('organize-source').first().click();
    await expect.poll(() => page.getByTestId('segment-label').count()).toBe(3);
  });

  test('整理していない記載があると、投薬などのタブで知らせる', async () => {
    const page = await openPatient('Desktop Chrome');
    next = { ok: false, reason: 'unavailable' };
    await send(page, NOTE);
    await expect.poll(() => page.getByTestId('composer-organizing').textContent()).toContain('整理できませんでした');
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-medications').click();
    expect(await page.getByTestId('medications').textContent()).toContain('まだ整理していない記載が 1 件');
  });
});
