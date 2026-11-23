// 画面の見直しの E2E（段L。CA-080）：絵と図（最新バイタルの小さな推移の線・記録の地図・24時間の数の札・問題ごとの書かれた日の点・日の帯の絵の印・
// 時系列の縦の線）と、骨組み（細い帯・電話では下のタブ）。AI は試験の代役。文と値はすべて架空（synthetic）。
// 足した図が、値で色・大きさを変えないこと・判定の語を出さないこと、問題の点を線で結ばないこと（期間の帯はボードだけ）、電話の幅ではみ出さないことを確かめる。
import type { LinkAnswer, OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { LinkerResult } from '../../worker/src/organizer.ts';
import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const ADMISSION = '【現病歴】\n3日前の夕方から悪寒と発熱あり、熱は38.5℃まで上昇。\n昨日、市販の解熱薬を内服したが改善せず。\n【経過】\n11:00 血液培養2セット採取\n11:30 セフトリアキソン 2g 開始\n#1 発熱\nA) 肺炎を疑う\nP) 抗菌薬を開始\n#2 低Na血症\nA) 経過観察';
const DAY2 = '#1 市中肺炎\nS) 咳嗽は軽減\nA) 抗菌薬に反応している\nP) セフトリアキソン 2g 継続\n#2 低Na血症\nA) 改善傾向';
const DAY4 = '#1 市中肺炎\nA) 解熱し、改善\nP) セフトリアキソン 2g 中止\n#2 低Na血症 解決';
const evening = { base: 'note' as const, days: -3, hours: null, minutes: null, time: null, part: 'evening' as const, spanDays: null };

const ANSWERS: Record<string, OrganizeAnswer> = {
  [ADMISSION]: {
    ...EMPTY_ORGANIZE,
    segments: [
      { label: 'present_illness', start: '【現病歴】', when: null },
      { label: 'problem_heading', start: '#1 発熱', when: null },
      { label: 'assessment', start: 'A) 肺炎', when: null },
      { label: 'plan', start: 'P) 抗菌薬を開始', when: null },
      { label: 'problem_heading', start: '#2 低Na血症', when: null },
      { label: 'assessment', start: 'A) 経過観察', when: null },
    ],
    problems: [
      { name: '#1 発熱', status: 'problem', activity: null },
      { name: '#2 低Na血症', status: 'problem', activity: null },
    ],
    medications: [{ name: 'セフトリアキソン', dose: '2g', action: 'start', when: '11:30' }],
    events: [{ kind: 'test', title: '血液培養2セット採取', when: '11:00' }],
    measurements: [{ quote: '熱は38.5℃まで上昇', when: '3日前の夕方', whenHint: evening, specimen: null, values: [{ name: '体温', value: '38.5', unit: '℃', comparator: null }] }],
    course: [
      { quote: '3日前の夕方から悪寒と発熱あり', summary: '悪寒・発熱が出現', category: 'onset', when: '3日前の夕方', whenHint: evening },
      { quote: '昨日、市販の解熱薬を内服したが改善せず。', summary: '市販の解熱薬を内服（改善なし）', category: 'intake', when: '昨日', whenHint: null },
    ],
  },
  [DAY2]: {
    ...EMPTY_ORGANIZE,
    segments: [
      { label: 'problem_heading', start: '#1 市中肺炎', when: null },
      { label: 'subjective', start: 'S) 咳嗽', when: null },
      { label: 'assessment', start: 'A) 抗菌薬に', when: null },
      { label: 'plan', start: 'P) セフ', when: null },
      { label: 'problem_heading', start: '#2 低Na血症', when: null },
      { label: 'assessment', start: 'A) 改善傾向', when: null },
    ],
    problems: [
      { name: '#1 市中肺炎', status: 'diagnosis', activity: null },
      { name: '#2 低Na血症', status: 'problem', activity: null },
    ],
    medications: [{ name: 'セフトリアキソン', dose: '2g', action: 'continue', when: null }],
  },
  [DAY4]: {
    ...EMPTY_ORGANIZE,
    segments: [
      { label: 'problem_heading', start: '#1 市中肺炎', when: null },
      { label: 'assessment', start: 'A) 解熱', when: null },
      { label: 'plan', start: 'P) セフ', when: null },
      { label: 'problem_heading', start: '#2 低Na血症 解決', when: null },
    ],
    problems: [
      { name: '#1 市中肺炎', status: 'diagnosis', activity: null },
      { name: '#2 低Na血症', status: 'problem', activity: 'resolved' },
    ],
    medications: [{ name: 'セフトリアキソン', dose: '2g', action: 'stop', when: null }],
  },
};

/** つなぎの代役：「市中肺炎」を「発熱」の筋につなぐ */
const link = (message: string): LinkerResult => {
  const data = JSON.parse(message) as { problems: { ref: string; names: string[] }[]; added: { ref: string; name: string }[] };
  const fever = data.problems.find((p) => p.names.includes('#1 発熱'))?.ref;
  const pneumonia = data.added.find((a) => a.name === '#1 市中肺炎')?.ref;
  const links: LinkAnswer['links'] = fever !== undefined && pneumonia !== undefined ? [{ added: pneumonia, same_as: fever }] : [];
  return { ok: true, answer: { links } };
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
  const organizer = fakeOrganizer((text) => ({ ok: true, answer: ANSWERS[text] ?? EMPTY_ORGANIZE }), link, {
    problemList: (message) => {
      const data = JSON.parse(message) as { threads: { ref: string; name: string }[]; course: { ref: string }[] };
      const ref = (word: string): string[] => data.threads.filter((t) => t.name.includes(word)).map((t) => t.ref);
      const main = [...ref('市中肺炎'), ...ref('発熱')];
      return {
        ok: true,
        answer: {
          items: [
            ...(main.length === 0 ? [] : [{ name: '市中肺炎（右下葉）', certainty: 'diagnosis' as const, activity: 'active' as const, threads: main, course: data.course.map((c) => c.ref), basis: '3日前からの発熱と、肺炎の評価から' }]),
            ...(ref('低Na').length === 0 ? [] : [{ name: '低Na血症', certainty: 'problem' as const, activity: 'resolved' as const, threads: ref('低Na'), course: [], basis: '解決と書かれている' }]),
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

type Preset = 'iPhone 15' | 'Desktop Chrome';

async function sendAndWait(page: Page): Promise<void> {
  const before = await page.getByTestId('source').count();
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(before + 1);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
}

async function note(page: Page, kind: string, day: string, time: string, text: string): Promise<void> {
  await page.getByTestId(`kind-chip-${kind}`).click();
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill(time);
  await page.getByTestId('text').fill(text);
  await sendAndWait(page);
}

async function vitals(page: Page, day: string, time: string, v: Record<string, string>): Promise<void> {
  await page.getByTestId('kind-chip-vital').click();
  await page.getByTestId('at-day').fill(day);
  await page.getByTestId('at-time').fill(time);
  for (const [name, value] of Object.entries(v)) await page.getByTestId(`quick-${name}`).fill(value);
  await page.getByTestId('quick-apply').click();
  await sendAndWait(page);
}

/** 架空症例（入院 11/17〜。11/19 は、何も入れていない日）を、画面から入れる */
async function openCase(preset: Preset = 'iPhone 15', colorScheme: 'light' | 'dark' = 'light'): Promise<Page> {
  const context = await browser.newContext({ ...presets[preset], colorScheme });
  contexts.push(context);
  const page = await context.newPage();
  page.on('console', (m) => {
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
  await note(page, 'admission_note', '2026-11-17', '10:30', ADMISSION);
  await vitals(page, '2026-11-17', '10:00', { BT: '38.6', HR: '104', SBP: '132', DBP: '78', RR: '22', SpO2: '93' });
  await vitals(page, '2026-11-17', '18:00', { BT: '38.9', HR: '108', SBP: '126', DBP: '74', SpO2: '94' });
  await note(page, 'lab', '2026-11-17', '10:00', 'WBC 14.2 CRP 12.4 Na 128');
  await vitals(page, '2026-11-18', '06:00', { BT: '38.1', HR: '96', SBP: '124', DBP: '72', RR: '20', SpO2: '95' });
  await note(page, 'progress_note', '2026-11-18', '09:00', DAY2);
  await vitals(page, '2026-11-20', '06:00', { BT: '36.9', HR: '80', SBP: '120', DBP: '74', RR: '16', SpO2: '97' });
  await note(page, 'lab', '2026-11-20', '06:00', 'WBC 7.6 CRP 2.1 Na 136');
  await note(page, 'progress_note', '2026-11-20', '09:00', DAY4);
  await page.getByTestId('composer-close').click();
  return page;
}

/** 横にはみ出す要素（なければ true） */
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
const shot = async (page: Page, name: string, fullPage = false): Promise<void> => {
  if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
};
/** 画面の上へ（撮るため） */
const toTop = (page: Page) => page.evaluate(() => { window.scrollTo(0, 0); });

describe('画面の見直し（段L）', () => {
  test('いま：最新バイタルの札に小さな推移の線。記録の地図は「入っているか」だけ。24時間の数の札。判定の語・値による色分けを出さない', async () => {
    const page = await openCase();
    await page.getByTestId('tab-state').click();
    await expect.poll(() => page.getByTestId('state-plist-item').count(), { timeout: 10_000 }).toBe(1);

    // 最新のバイタル：数・いつの値か（これまでどおり）と、2点以上ある項目の小さな線
    const tiles = page.getByTestId('latest-item');
    expect(await tiles.count()).toBe(5);
    expect(await tiles.first().textContent()).toContain('36.9');
    expect(await page.getByTestId('spark').count()).toBe(5);
    // 線は、項目の色（経過表と同じ）。値で色を変えない：最新の点と線は、同じ項目の色の組
    expect(await tiles.first().locator('.spark-line.series-bt').count()).toBe(1);
    expect(await tiles.nth(2).locator('.spark-range').count()).toBe(4); // 血圧は、上と下を結ぶ縦の線（4回）

    // 記録の地図：11/17〜11/20 の4日。11/19 は何も入れていない
    const map = page.getByTestId('record-map');
    expect(await map.getByTestId('map-row-sources').locator('.map-dot').count()).toBe(3);
    expect(await map.getByTestId('map-row-vitals').locator('.map-dot').count()).toBe(3);
    expect(await map.getByTestId('map-row-labs').locator('.map-dot').count()).toBe(2);
    expect(await map.getByTestId('map-row-medications').locator('.map-dot').count()).toBe(3);
    expect(await map.getByTestId('map-row-events').locator('.map-dot').count()).toBe(1);
    // 点の大きさは、どれも同じ（数・値で変えない）
    const radii = await map.locator('circle.map-dot').evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('r')))]);
    expect(radii).toHaveLength(1);
    // 日を押すと、その日の内わけ。そこから、経過のその日へ
    const hit = page.getByTestId('record-map-hit');
    const box = await hit.boundingBox();
    if (box === null) throw new Error('地図がない');
    await hit.click({ position: { x: (box.width / 4) * 2.5, y: 40 } });
    expect(await page.getByTestId('record-map-readout').textContent()).toContain('11/19');
    expect(await page.getByTestId('record-map-readout').textContent()).toContain('記録 0・バイタル 0・検査 0・できごと 0・投薬 0');
    await hit.click({ position: { x: (box.width / 4) * 3.5, y: 40 } });
    expect(await page.getByTestId('record-map-readout').textContent()).toContain('11/20');

    // 24時間の数の札（種類ごとの数だけ）
    expect(await page.getByTestId('state-recent-tiles').textContent()).toMatch(/\d+問題\d+投薬の動き\d+できごと\d+検査の項目/u);
    // 足した図は、判定の語を出さない（基準範囲の印・スコアは、これまでの場所だけ。CA-059）
    for (const id of ['latest', 'record-map', 'state-recent-tiles']) expect(await page.getByTestId(id).textContent()).not.toMatch(/異常|正常|高値|低値|警告|悪化|上昇|低下/u);
    expect(await fits(page)).toBe(true);
    await toTop(page);
    await shot(page, 'k-state-iphone');
    await shot(page, 'k-state-iphone-full', true);

    await page.getByTestId('record-map-open').click();
    expect(await page.getByTestId('tab-course').getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('day-selected').textContent()).toContain('11/20 を見ています');
    expect(problems).toEqual([]);
  });

  test('問題ごとの、書かれた日の点：書かれた日時に点だけ。線で結ばない（期間の帯は、経過表のボードだけ）。活動中でないものは、状態の字', async () => {
    const page = await openCase();
    await page.getByTestId('tab-problems').click();
    await expect.poll(() => page.getByTestId('plist-item').count(), { timeout: 10_000 }).toBe(2);
    const lanes = page.getByTestId('problem-lane');
    await expect.poll(() => lanes.count()).toBe(2);
    expect(await lanes.nth(0).textContent()).toContain('#1 市中肺炎（右下葉）');
    expect(await lanes.nth(1).textContent()).toContain('#2 低Na血症');
    expect(await lanes.nth(1).textContent()).toContain('解決');
    // 来院前の出来事（3日前・前日）と、3回の記載。点は、書かれた日時の数だけ
    expect(await lanes.nth(0).locator('.written-mark').count()).toBe(5);
    expect(await lanes.nth(1).locator('.written-mark').count()).toBe(3);
    // 線で結ばない（期間を、ボードの「問題の帯」と別の決まりで描かない）
    expect(await page.getByTestId('problem-lanes').locator('.problem-span').count()).toBe(0);
    expect(await lanes.nth(0).getAttribute('class')).not.toContain('closed');
    expect(await lanes.nth(1).getAttribute('class')).toContain('closed');
    await lanes.nth(1).getByTestId('problem-lane-hit').click();
    const readout = page.getByTestId('problem-lanes-readout');
    expect(await readout.textContent()).toContain('#2 低Na血症（解決）');
    expect(await readout.textContent()).toContain('11/17 10:30・11/18 09:00・11/20 09:00');
    expect(await page.getByTestId('problem-lanes').textContent()).not.toMatch(/異常|正常値|警告|悪化/u);
    expect(await fits(page)).toBe(true);
    await toTop(page);
    await shot(page, 'k-problems-iphone');
    await shot(page, 'k-problems-iphone-full', true);
    expect(problems).toEqual([]);
  });

  test('経過：日の帯の印は絵で「あるか」だけ。時系列は、種類の絵と縦の線。経過表に日の縞', async () => {
    const page = await openCase();
    await page.getByTestId('tab-course').click();
    const cells = page.getByTestId('day-cell');
    expect(await cells.count()).toBe(4);
    // 11/17：記録・値・薬・できごと。11/19：何もない
    expect(await cells.nth(0).locator('.day-mark.has').count()).toBe(4);
    expect(await cells.nth(2).locator('.day-mark.has').count()).toBe(0);
    expect(await cells.nth(2).getAttribute('class')).toContain('empty');
    await page.getByTestId('timeline').waitFor();
    await page.getByTestId('range-all').click();
    expect(await page.getByTestId('timeline').locator('.day-band').count()).toBeGreaterThan(0);
    expect(await fits(page)).toBe(true);
    await toTop(page);
    await shot(page, 'k-course-iphone');
    await shot(page, 'k-course-iphone-full', true);

    await page.getByTestId('tab-events').click();
    const list = page.getByTestId('timeline-list');
    await list.waitFor();
    const rows = list.getByTestId('timeline-row');
    expect(await list.locator('.tl-node').count()).toBe(await rows.count());
    // 来院より前の日の見出しは、形で分ける
    expect(await list.locator('.tl-day.before').count()).toBe(2);
    expect(await fits(page)).toBe(true);
    await toTop(page);
    await shot(page, 'k-timeline-iphone', true);

    await page.getByTestId('tab-values').click();
    await page.getByTestId('trends').waitFor();
    await toTop(page);
    await shot(page, 'k-values-iphone', true);
    await page.getByTestId('tab-notes').click();
    await toTop(page);
    await shot(page, 'k-notes-iphone-view');
    await shot(page, 'k-notes-iphone', true);
    expect(problems).toEqual([]);
  });

  test('骨組み：帯は細く、いつも上に。電話ではタブが画面の下、広い画面では帯の下。回診リストは札つき', async () => {
    const page = await openCase();
    const view = page.viewportSize();
    if (view === null) throw new Error('画面の大きさがない');
    const banner = await page.getByTestId('banner').boundingBox();
    expect(banner?.y ?? 999).toBeLessThan(20);
    expect(banner?.height ?? 999).toBeLessThan(48);
    // 下へ送っても、帯とタブは見えたまま
    await page.evaluate(() => { window.scrollTo(0, 600); });
    expect((await page.getByTestId('banner').boundingBox())?.y ?? 999).toBeLessThan(20);
    const tab = await page.getByTestId('tab-state').boundingBox();
    expect(tab?.y ?? 0).toBeGreaterThan(view.height - 80);
    // 「入れる」は、下のタブの真ん中（経過と問題のあいだ）。タブにも、中身にも重ならない
    const fab = await page.getByTestId('fab-compose').boundingBox();
    const left = await page.getByTestId('tab-course').boundingBox();
    const right = await page.getByTestId('tab-problems').boundingBox();
    if (fab === null || left === null || right === null) throw new Error('タブ・入れるがない');
    expect(fab.x).toBeGreaterThanOrEqual(left.x + left.width);
    expect(fab.x + fab.width).toBeLessThanOrEqual(right.x);
    expect(fab.y + fab.height).toBeGreaterThan(view.height - 80);
    await page.getByTestId('fab-compose').click();
    await page.getByTestId('composer').waitFor();
    await shot(page, 'k-composer-iphone', true);

    await page.getByTestId('back').click();
    const row = page.getByTestId('patient').first();
    await row.waitFor();
    expect(await row.locator('.patient-badge').textContent()).toBe('72男');
    expect(await row.getByTestId('round-day').textContent()).toBe('4病日（記録の上で）');
    await expect.poll(() => row.getByTestId('round-problem').allTextContents()).toEqual(['#1 市中肺炎（右下葉）']);
    expect(await page.getByTestId('round-counts').textContent()).toBe('1受け持ち中0受診が終わった9記録（件）');
    expect(await fits(page)).toBe(true);
    await shot(page, 'k-rounds-iphone', true);
    expect(problems).toEqual([]);
  });

  test('広い画面・暗い画面でも崩れない', async () => {
    const page = await openCase('Desktop Chrome', 'dark');
    await page.getByTestId('tab-state').click();
    await expect.poll(() => page.getByTestId('state-plist-item').count(), { timeout: 10_000 }).toBe(1);
    const tab = await page.getByTestId('tab-state').boundingBox();
    expect(tab?.y ?? 999).toBeLessThan(400);
    expect(await fits(page)).toBe(true);
    await toTop(page);
    await shot(page, 'k-state-pc-dark', true);
    await page.getByTestId('tab-course').click();
    await page.getByTestId('timeline').waitFor();
    await toTop(page);
    await shot(page, 'k-course-pc-dark', true);
    await page.getByTestId('tab-problems').click();
    await page.getByTestId('problem-lanes').waitFor();
    await toTop(page);
    await shot(page, 'k-problems-pc-dark', true);
    expect(problems).toEqual([]);
  });

  test('広い画面・明るい画面', async () => {
    const page = await openCase('Desktop Chrome');
    await page.getByTestId('tab-state').click();
    await expect.poll(() => page.getByTestId('state-plist-item').count(), { timeout: 10_000 }).toBe(1);
    expect(await fits(page)).toBe(true);
    await toTop(page);
    await shot(page, 'k-state-pc', true);
    await page.getByTestId('tab-course').click();
    await page.getByTestId('timeline').waitFor();
    await toTop(page);
    await shot(page, 'k-course-pc', true);
    await page.getByTestId('back').click();
    await page.getByTestId('patient').first().waitFor();
    await shot(page, 'k-rounds-pc', true);
    expect(problems).toEqual([]);
  });
});
