// 見方と入れやすさの E2E：経過表（温度板・投薬・できごと）、検査値の推移、最新のバイタル、種類・日時・ひな形のチップ、
// 数だけ打つ欄。値はすべて架空。正常範囲・色分けの判定を出さないこと、電話の幅で横にはみ出さないことも確かめる。
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { OrganizerResult } from '../../worker/src/organizer.ts';
import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

let app: BuiltApp;
let browser: Browser;
let server: DevServer;
const contexts: BrowserContext[] = [];
let next: OrganizerResult = { ok: true, answer: EMPTY_ORGANIZE };
const problems: string[] = [];
/** スクリーンショットの置き場（環境変数があるときだけ撮る） */
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
  next = { ok: true, answer: EMPTY_ORGANIZE };
  problems.length = 0;
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer: fakeOrganizer(() => next) });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openPatient(preset: 'iPhone 15' | 'Desktop Chrome' = 'iPhone 15'): Promise<Page> {
  const context = await browser.newContext({ ...presets[preset], colorScheme: 'light' });
  contexts.push(context);
  const page = await context.newPage();
  page.on('console', (m) => {
    // 401（登録の前）は、ブラウザが「読み込みに失敗」と出す。ここで確かめたい誤りではない
    if (m.type() === 'error' && !m.text().includes('401')) problems.push(`console: ${m.text()}`);
  });
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
  return page;
}

async function when(page: Page, day: string, time: string): Promise<void> {
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill(time);
}

async function sendAndWait(page: Page): Promise<void> {
  const before = await page.getByTestId('source').count();
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(before + 1);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

/** バイタルを、数だけ打つ欄で入れる（架空の値） */
async function vitals(page: Page, day: string, time: string, v: Record<string, string>): Promise<void> {
  await page.getByTestId('kind-chip-vital').click();
  await when(page, day, time);
  for (const [name, value] of Object.entries(v)) await page.getByTestId(`quick-${name}`).fill(value);
  await page.getByTestId('quick-apply').click();
  await sendAndWait(page);
}

/** 横にはみ出す要素（なければ空） */
const fits = (page: Page) =>
  page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= w) return true;
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > w + 0.5)
      .slice(0, 5)
      .map((el) => `${el.tagName}.${String(el.getAttribute('class'))} ${String(Math.round(el.getBoundingClientRect().right))}/${String(w)}`)
      .join(' | ');
  });

describe('経過表', () => {
  test('バイタルが、同じ時間の軸の段に並び、最新の値が見出しに出る。タップで、その時刻の値が下に出る', async () => {
    const page = await openPatient();
    expect(await page.getByTestId('tab-state').getAttribute('aria-selected')).toBe('true'); // 最初に開くのは「いま」（段3b）
    expect(await page.getByTestId('timeline').count()).toBe(0);

    await vitals(page, '2026-11-17', '10:00', { BT: '38.6', HR: '104', SBP: '132', DBP: '78', RR: '22', SpO2: '93' });
    await vitals(page, '2026-11-18', '06:00', { BT: '38.1', HR: '96', SBP: '124', DBP: '72', SpO2: '95' });
    await vitals(page, '2026-11-19', '06:00', { BT: '37.4', HR: '88', SBP: '118', DBP: '70', RR: '18', SpO2: '96' });
    await vitals(page, '2026-11-20', '06:00', { BT: '36.9', HR: '80', SBP: '120', DBP: '74', RR: '16', SpO2: '97' });

    // 保存のあとは、記録のタブで、入れた文が見える
    expect(await page.getByTestId('tab-notes').getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('source').first().textContent()).toContain('BT 36.9 HR 80 BP 120/74 RR 16 SpO2 97%');

    // 最新の値（段H：見出しから「いま」へ移した）
    await page.getByTestId('tab-state').click();
    const latest = page.getByTestId('latest-item');
    expect(await latest.allTextContents()).toEqual([
      expect.stringContaining('36.9'),
      expect.stringContaining('80'),
      expect.stringContaining('120/74'),
      expect.stringContaining('16'),
      expect.stringContaining('97'),
    ]);

    await page.getByTestId('tab-course').click();

    await page.getByTestId('tab-overview').click();
    for (const id of ['bt', 'hr', 'bp', 'rr', 'spo2']) await page.getByTestId(`panel-${id}`).waitFor();
    expect(await page.getByTestId('panel-bp').locator('.range').count()).toBe(12); // 4回 × 縦の線と上下の印
    // 既定の範囲は、最後の記録までの3日（段H）。全期間にすると、入院の日（1病日）から
    expect(await page.getByTestId('range-3d').getAttribute('aria-pressed')).toBe('true');
    await page.getByTestId('range-all').click();
    expect(await page.getByTestId('timeline').textContent()).toContain('1病日');
    // 判定の語・色を出さない
    expect(await page.getByTestId('timeline').textContent()).not.toMatch(/異常|正常値|高値|低値|警告/u);

    // 左の端（最初の時刻）をタップ → その時刻の値
    await page.getByTestId('timeline-hit').click({ position: { x: 2, y: 80 } });
    const readout = page.getByTestId('timeline-readout');
    await expect.poll(() => readout.textContent()).toContain('11/17 10:00');
    expect(await readout.textContent()).toContain('38.6 ℃');
    expect(await readout.textContent()).toContain('132/78');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/overview-iphone.png`, fullPage: true });
    expect(problems).toEqual([]);
  });

  test('投薬は薬ごとの段に、動きの形の印と、記録のあいだの帯で出る。できごとも同じ軸に出る', async () => {
    const page = await openPatient();
    await vitals(page, '2026-11-17', '10:00', { BT: '38.4', HR: '100' });
    next = {
      ok: true,
      answer: {
        ...EMPTY_ORGANIZE,
        medications: [
          { name: 'セフトリアキソン', dose: '2g 24時間毎', action: 'start', when: '11/17 11:00' },
          { name: 'セフトリアキソン', dose: null, action: 'stop', when: '11/20' },
          { name: 'アモキシシリン', dose: null, action: 'start', when: '11/20' },
        ],
        events: [{ kind: 'test', title: '血液培養を提出', when: '11/17 10:30' }],
      },
    };
    await page.getByTestId('kind-chip-progress_note').click();
    await when(page, '2026-11-20', '09:00');
    await page.getByTestId('text').fill('11/17 11:00 セフトリアキソン 2g 24時間毎 開始。11/17 10:30 血液培養を提出。11/20 セフトリアキソン 中止、アモキシシリン 開始。');
    await sendAndWait(page);
    next = { ok: true, answer: EMPTY_ORGANIZE }; // 後の文には、薬の答えを返さない
    await vitals(page, '2026-11-20', '06:00', { BT: '36.8', HR: '78' });

    await page.getByTestId('tab-course').click();

    await page.getByTestId('tab-overview').click();
    const meds = page.getByTestId('timeline-medications');
    await meds.waitFor();
    expect(await meds.textContent()).toContain('セフトリアキソン');
    expect(await meds.textContent()).toContain('アモキシシリン');
    expect(await meds.locator('.med-span').count()).toBe(1); // 開始〜中止のあいだだけ。アモキシシリンは1回の記録で、先へ伸ばさない
    // 既定の範囲（最後の記録までの3日）の外のできごとは段にせず、1行で知らせる。全期間にすると段に出る
    expect(await page.getByTestId('timeline-outside').textContent()).toContain('この範囲に、できごとの記録はありません');
    await page.getByTestId('range-all').click();
    expect(await page.getByTestId('timeline-events').textContent()).toContain('できごと');
    expect(await page.getByTestId('timeline').textContent()).toContain('最後の記録より先は');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/medications-iphone.png`, fullPage: true });
  });
});

describe('経過（段H。CA-053）', () => {
  test('日の帯で日を選ぶと、経過表はその日の0〜24時になり、記載もその日になる。範囲のボタン・前後・縮小図で範囲を動かせる', async () => {
    const page = await openPatient();
    await vitals(page, '2026-11-17', '10:00', { BT: '38.6', HR: '104' });
    await vitals(page, '2026-11-19', '06:00', { BT: '37.4', HR: '88' });
    await vitals(page, '2026-11-19', '18:00', { BT: '37.0', HR: '84' });
    await page.getByTestId('tab-course').click();
    const cells = page.getByTestId('day-cell');
    // 受診の始まりの日から、最後の記録の日まで（記録のない日も並ぶ）
    expect(await cells.allTextContents()).toEqual([expect.stringContaining('11/17'), expect.stringContaining('11/18'), expect.stringContaining('11/19')]);
    expect(await cells.nth(1).getAttribute('class')).toContain('empty');
    const label = page.getByTestId('range-label');
    await cells.nth(2).click();
    await expect.poll(() => label.textContent()).toBe('11/19 00:00 〜 11/20 00:00');
    expect(await page.getByTestId('day-selected').textContent()).toContain('11/19 を見ています');
    // 前の日へ
    await page.getByTestId('day-prev').click();
    await expect.poll(() => label.textContent()).toBe('11/18 00:00 〜 11/19 00:00');
    // 日を外すと、既定（最後の記録までの3日）
    await page.getByTestId('day-clear').click();
    expect(await page.getByTestId('range-3d').getAttribute('aria-pressed')).toBe('true');
    await page.getByTestId('range-24h').click();
    const day = await label.textContent();
    await page.getByTestId('range-prev').click();
    await expect.poll(() => label.textContent()).not.toBe(day);
    // 縮小図の左の端を押すと、範囲が最初の記録のほうへ動く
    await page.getByTestId('minimap-hit').click({ position: { x: 2, y: 10 } });
    await expect.poll(() => label.textContent()).toContain('11/17');
    // 投薬・できごとの一覧は、選んだ日の分だけ
    await cells.nth(2).click();
    await page.getByTestId('tab-chart').click();
    await page.getByTestId('doc-view').waitFor();
    expect(await page.getByTestId('doc-day').inputValue()).toBe('2026-11-19');
    expect(await fits(page)).toBe(true);
    expect(problems).toEqual([]);
  });

  test('PC の幅では、経過表の右に、その日の記載が並ぶ（2列）', async () => {
    const page = await openPatient('Desktop Chrome');
    await vitals(page, '2026-11-19', '06:00', { BT: '37.4', HR: '88' });
    await page.getByTestId('tab-course').click();
    await page.getByTestId('timeline').waitFor();
    const side = page.locator('.course-side');
    expect(await side.count()).toBe(1);
    expect(await side.getByTestId('doc-view').count()).toBe(1);
    expect(await fits(page)).toBe(true);
  });
});

describe('検査値の推移', () => {
  test('検査値を欄で入れると、項目ごとの小さなグラフが並ぶ。表も残る', async () => {
    const page = await openPatient();
    for (const [day, crp, wbc] of [
      ['2026-11-17', '12.4', '14.2'],
      ['2026-11-19', '6.8', '10.1'],
      ['2026-11-21', '2.1', '7.6'],
    ] as const) {
      await page.getByTestId('kind-chip-lab').click();
      await when(page, day, '06:00');
      if ((await page.getByTestId('quick-open').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('quick-open').click();
      await page.getByTestId('labset-0').click();
      await page.getByTestId('quick-WBC').fill(wbc);
      await page.getByTestId('labset-1').click();
      await page.getByTestId('quick-CRP').fill(crp);
      await page.getByTestId('quick-apply').click();
      expect(await page.getByTestId('text').inputValue()).toBe(`CRP ${crp}`); // 組を替えると、前の組の欄は空になる
      await page.getByTestId('labset-0').click();
      await page.getByTestId('quick-WBC').fill(wbc);
      await page.getByTestId('quick-apply').click();
      expect(await page.getByTestId('text').inputValue()).toBe(`CRP ${crp} WBC ${wbc}`);
      await sendAndWait(page);
    }
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-values').click();
    const trends = page.getByTestId('trend');
    await expect.poll(() => trends.count()).toBe(2);
    const text = (await trends.allTextContents()).join(' ');
    expect(text).toContain('CRP');
    expect(text).toContain('2.1');
    expect(text).toContain('7.6');
    await page.getByTestId('lab-table').waitFor();
    // 押すと大きく見る（値の一覧つき）
    await trends.first().getByTestId('trend-expand').click();
    expect(await trends.first().getByTestId('trend-values').locator('li').count()).toBeGreaterThan(0);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/trends-iphone.png`, fullPage: true });
    expect(problems).toEqual([]);
  });
});

describe('単位の「同じ目盛り」（CA-051）', () => {
  test('同じ項目で単位の書き方が違う推移は別に並び、先生が「同じ目盛り」と決めるとつながる。分けると戻る', async () => {
    const page = await openPatient();
    await page.getByTestId('kind-chip-lab').click();
    await when(page, '2026-11-17', '06:00');
    await page.getByTestId('text').fill('WBC 12300');
    await sendAndWait(page);
    await page.getByTestId('kind-chip-lab').click();
    await when(page, '2026-11-18', '06:00');
    await page.getByTestId('text').fill('WBC 9800 /μL');
    await sendAndWait(page);
    await page.getByTestId('tab-course').click();
    await page.getByTestId('tab-values').click();
    const trends = page.getByTestId('trend');
    await expect.poll(() => trends.count()).toBe(2);
    expect(await page.getByTestId('scale-candidate').textContent()).toContain('WBC：単位の記載なし と /μL');
    await page.getByTestId('scale-join').click();
    await expect.poll(() => trends.count()).toBe(1);
    expect(await page.getByTestId('trend-joined').textContent()).toContain('単位の記載なし・/μL：先生が同じ目盛りと決めた');
    await page.getByTestId('scale-split').click();
    await expect.poll(() => trends.count()).toBe(2);
    expect(problems).toEqual([]);
  });
});

describe('入れやすさ', () => {
  test('種類・著者・日時のチップと、ひな形の挿入。数で読めない欄は、文に入れない', async () => {
    const page = await openPatient();
    await page.getByTestId('fab-compose').click();
    expect(await page.getByTestId('kind-chip-progress_note').getAttribute('aria-checked')).toBe('true'); // 既定は経過
    await page.getByTestId('template-0').click();
    expect(await page.getByTestId('text').inputValue()).toBe('S) \nO) \nA) \nP) \n');

    await page.getByTestId('when-yesterday').click();
    expect(await page.getByTestId('at-time').inputValue()).toBe('');
    expect(await page.getByTestId('at-day').inputValue()).not.toBe('');
    await page.getByTestId('when-unknown').click();
    expect(await page.getByTestId('at-day').isDisabled()).toBe(true);
    await page.getByTestId('when-now').click();
    expect(await page.getByTestId('at-day').isDisabled()).toBe(false);
    expect(await page.getByTestId('at-time').inputValue()).not.toBe('');

    await page.getByTestId('kind-chip-vital').click();
    await page.getByTestId('quick-BT').fill('３７．５');
    await page.getByTestId('quick-HR').fill('はやい');
    await page.getByTestId('quick-apply').click();
    expect(await page.getByRole('alert').textContent()).toContain('心拍数');
    await page.getByTestId('quick-HR').fill('');
    await page.getByTestId('quick-apply').click();
    expect(await page.getByTestId('text').inputValue()).toContain('BT 37.5');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/composer-iphone.png`, fullPage: true });
  });

  test('日時：はじめと保存のあとは時刻なし。文に書かれた日時をチップで選べる。℃ と括弧つきの血圧も読む', async () => {
    const page = await openPatient();
    await page.getByTestId('fab-compose').click();
    expect(await page.getByTestId('at-time').inputValue()).toBe(''); // 画面を開いた時刻を、既定にしない
    await page.getByTestId('when-day-only').waitFor();
    await page.getByTestId('kind-chip-vital').click();
    await page.getByTestId('text').fill('【初期評価 2026-11-18 10:38】\nBT 39.0℃、BP 84/40（MAP 約55）');
    expect(await page.getByTestId('when-candidates').textContent()).toContain('2026-11-18 10:38');
    if (SHOTS !== undefined) await page.getByTestId('composer').screenshot({ path: `${SHOTS}/composer-when-iphone.png` });
    await page.getByTestId('when-candidate-0').click();
    expect([await page.getByTestId('at-day').inputValue(), await page.getByTestId('at-time').inputValue()]).toEqual(['2026-11-18', '10:38']);
    expect(await page.getByTestId('when-day-only').count()).toBe(0);
    await sendAndWait(page);
    expect(await page.getByTestId('composer-done').textContent()).toContain('読んだ値 3 件');
    // 保存のあと：時刻は空に戻る（前の記載の時刻を、次の記載に黙って使わない）。日は残る
    expect([await page.getByTestId('at-day').inputValue(), await page.getByTestId('at-time').inputValue()]).toEqual(['2026-11-18', '']);

    // 文に時刻が書かれていて、時刻を空のまま送るときは、確かめずに送る。整理のときに AI が文の時刻を読み取る、と案内する
    await page.getByTestId('text').fill('【再評価 2026-11-18 11:50】\nBT 38.4');
    expect(await page.getByTestId('when-day-only').textContent()).toContain('11:50');
    if (SHOTS !== undefined) await page.getByTestId('composer').screenshot({ path: `${SHOTS}/composer-auto-time-iphone.png` });
    await sendAndWait(page);
    // 時刻の書かれていない文は、日だけで入ると案内する
    await page.getByTestId('text').fill('BT 37.9');
    expect(await page.getByTestId('when-day-only').textContent()).toContain('時刻なし（日だけ）で入れます');
    await sendAndWait(page);
    expect(problems).toEqual([]);
  });
});
