// 相談の窓口の E2E（段M。CA-081）。
// - 電話の幅：下のタブの真ん中の「相談」で、どのタブからでも開く（見方の1つとして）。よく使う問いを押して相談すると、見出しごとの答え・根拠の札・出典・
//   「（推論）」・※・答えられなかったこと・出さなかった数・検索に渡した語が出る。続けて相談すると、前のやりとりを踏まえる。
//   「この答えを残す」を押した答えだけが残る（問いは、どの表にも残らない）。残した答えは消せる。横にはみ出さない
// - 広い画面：右に並ぶ（記録を見ながら相談する）。根拠の記載の札を押すと、記録のタブでその記載が開く。窓口は開いたまま
// AI と RAG は試験の代役。文はすべて架空（synthetic）
import type { OrganizeAnswer } from '@clinical-carte/core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { devices as presets } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { BookHit, BookSearcher } from '../../worker/src/references.ts';
import { type DevServer, startDevServer } from '../../worker/test/devserver.ts';
import { EMPTY_ORGANIZE, type FakeOrganizer, fakeOrganizer, fakeSelector, TEST_KEY } from '../../worker/test/support.ts';
import { type BuiltApp, buildApp, launch } from './support.ts';

const NOTE = '【現病歴】\n3日前の夕方から悪寒と発熱あり。\nCRP 12.4 と高値。\n#1 発熱\nA) 肺炎を疑う\nP) 抗菌薬を検討';
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'present_illness', start: '【現病歴】', when: null },
    { label: 'problem_heading', start: '#1 発熱', when: null },
    { label: 'assessment', start: 'A) 肺炎', when: null },
    { label: 'plan', start: 'P) 抗菌薬', when: null },
  ],
  problems: [{ name: '#1 発熱', status: 'problem', activity: null }],
  measurements: [{ quote: 'CRP 12.4', when: null, specimen: null }],
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
  organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, {
    problemList: () => ({ ok: true, answer: { items: [{ name: '市中肺炎疑い', certainty: 'suspected', activity: 'active', threads: ['T1'], course: [], basis: '発熱と、肺炎を疑うとの評価' }] } }),
    consultTerms: () => ({ ok: true, answer: { terms: ['初期評価', 'CRP 12.4', '重症度 評価'] } }),
    research: () => ({ ok: true, hits: [{ title: '架空の学会の指針', url: 'https://example.org/guideline', citedText: '市中肺炎では、重症度を評価して治療の場を決める。' }] }),
    consult: (message) => {
      const m = JSON.parse(message) as { records: { ref: string }[]; values: { ref: string }[]; problems: { ref: string }[]; conversation: unknown[] };
      const r1 = m.records[0]?.ref ?? '';
      if (m.conversation.length > 0) {
        return { ok: true, answer: { statements: [{ section: 'other', text: '前の答えのとおり、まず胸部画像を確かめる。', support: [r1], citations: [] }], unknown: '' } };
      }
      return {
        ok: true,
        answer: {
          statements: [
            { section: 'summary', text: '発熱と CRP 12.4 の高値があり、肺炎を疑って抗菌薬を検討している段階。', support: [m.problems[0]?.ref ?? '', r1, m.values[0]?.ref ?? ''], citations: [] },
            { section: 'assessment', text: '市中肺炎が疑われるが、胸部画像の記載がなく、診断は確かめられていない。', support: [r1], citations: ['B1'] },
            { section: 'workup', text: '胸部画像で浸潤影の有無を確かめる。', support: [r1], citations: ['B1'] },
            { section: 'treatment', text: '重症度を評価して、治療の場を決める。', support: [], citations: ['W1'] },
            { section: 'treatment', text: 'セフトリアキソン 2 g/日 を始める。', support: [r1], citations: [] },
            { section: 'caution', text: '呼吸数が 30 回を超えるようなら、再評価する。', support: [], citations: ['W1'] },
          ],
          unknown: '培養の結果の記載がなく、起因菌は分からない。',
        },
      };
    },
    ask: (message) => {
      const m = JSON.parse(message) as { records: { ref: string }[] };
      return { ok: true, answer: { answer: [{ text: '3日前の夕方から、悪寒と発熱がある。', refs: [{ id: m.records[0]?.ref ?? '', quote: '3日前の夕方から悪寒と発熱あり' }] }], notFound: '' } };
    },
  });
  server = await startDevServer({ dist: app.dir, key: TEST_KEY, selector: fakeSelector(), organizer, books });
});
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  await server.close();
});

async function openWithNote(wide: boolean): Promise<Page> {
  const context = await browser.newContext(wide ? { viewport: { width: 1440, height: 900 }, colorScheme: 'light' } : { ...presets['iPhone 15'], colorScheme: 'light' });
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
  await page.getByTestId('text').fill(NOTE);
  await page.getByTestId('send').click();
  await expect.poll(() => page.getByTestId('source').count(), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => page.getByTestId('composer-organizing').textContent()).not.toContain('整理しています');
  await page.getByTestId('composer-close').click();
  // プロブレムリストが組まれるのを待つ（相談の資料に入る）
  await expect.poll(() => organizer.listed.length, { timeout: 15_000 }).toBeGreaterThan(0);
  return page;
}

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const dump = (): string => {
  const tables = (server.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  return JSON.stringify(tables.map((t) => server.db.raw.prepare(`SELECT * FROM ${t}`).all()));
};

describe('相談の窓口（段M）：電話の幅', () => {
  test('どのタブからでも開く。見出しごとの答え・根拠・出典・（推論）・※・検索に渡した語。続けて相談できる。残すのは、押した答えだけ', async () => {
    const page = await openWithNote(false);
    // 経過のタブから開く：見方の1つとして、タブの中身の代わりに出る（下のタブは、どれも選ばれていない）
    await page.getByTestId('tab-course').click();
    await page.getByTestId('fab-consult').click();
    const panel = page.getByTestId('consult');
    await panel.waitFor();
    expect(await page.getByTestId('fab-consult').getAttribute('aria-pressed')).toBe('true');
    expect(await page.getByTestId('tab-course').getAttribute('aria-selected')).toBe('false');
    expect(await panel.getByTestId('consult-caution').textContent()).toContain('臨床支援の草案です。最終判断は先生です。');
    expect(await page.getByTestId('banner').isVisible()).toBe(true);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/consult-phone-empty.png` });

    // よく使う問いは、欄に入るだけ（送るのは、押したとき）
    await panel.getByTestId('consult-quick').first().click();
    expect(await panel.getByTestId('consult-question').inputValue()).toBe('全体の方針をまとめて');
    expect(organizer.consulted).toHaveLength(0);
    await panel.getByTestId('consult-question').fill('全体の方針をまとめて（架空の問い・照合用）');
    await panel.getByTestId('consult-send').click();
    const statements = panel.getByTestId('consult-statement');
    await expect.poll(() => statements.count(), { timeout: 10_000 }).toBe(5);

    // 見出しの順。用量のある出典なしの文は出さない（数で出す）
    expect(await panel.locator('.consult-section-title').allTextContents()).toEqual(['要点', 'アセスメント', '確かめる検査・情報', '治療・方針', '注意すること']);
    expect(await panel.getByTestId('consult-answer').textContent()).not.toContain('セフトリアキソン');
    expect(await panel.getByTestId('consult-rejected').textContent()).toContain('資料と出典にない用量・閾値・目標値のあった文 1 件');
    // 出典のない文には「（推論）」。出典のある文には、題・頁・URL
    expect(await statements.first().textContent()).toContain('（推論）');
    expect(await statements.first().getByTestId('consult-ref').allTextContents()).toEqual(['プロブレム #1 市中肺炎疑い', expect.stringContaining('CRP') as string]);
    expect(await statements.nth(1).getByTestId('consult-cite').textContent()).toBe('書籍 架空の内科学 120（呼吸器 > 肺炎）');
    expect(await statements.nth(3).getByTestId('consult-cite').textContent()).toContain('https://example.org/guideline');
    // 資料・出典に見つからない数には ※
    expect(await statements.nth(4).getByTestId('support-num-mark').allTextContents()).toEqual(['30※']);
    expect(await panel.getByTestId('consult-unknown').textContent()).toContain('培養');
    // 何を外へ出したかを、いつも出す：問題の名前と、確かめた語だけ（数字のある語は渡していない）
    expect(await panel.getByTestId('consult-research').textContent()).toBe('資料にした出典：書籍 1 件・ネット 1 件。検索に渡した語：市中肺炎疑い・初期評価・重症度 評価');
    // （その前の検索は、自動で組まれる臨床支援のもの：問題の名前だけ）
    expect(books.asked.at(-1)).toEqual(['初期評価', '重症度 評価', '市中肺炎疑い']);
    expect(organizer.researched.at(-1)).toBe(JSON.stringify({ problems: ['市中肺炎疑い'], topics: ['初期評価', '重症度 評価'] }));
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/consult-phone-answer.png`, fullPage: true });

    // ほかのタブを見て、戻っても、やりとりは残っている（この患者の画面のメモリ）
    await page.getByTestId('tab-state').click();
    expect(await page.getByTestId('consult').count()).toBe(0);
    expect(await page.getByTestId('fab-consult').getAttribute('aria-pressed')).toBe('false');
    await page.getByTestId('open-consult').click();
    expect(await panel.getByTestId('consult-statement').count()).toBe(5);

    // 続けて相談する：前のやりとりを踏まえる
    await panel.getByTestId('consult-question').fill('まず何から？');
    await panel.getByTestId('consult-send').click();
    await expect.poll(() => panel.getByTestId('consult-asked').textContent(), { timeout: 10_000 }).toContain('まず何から？');
    const second = JSON.parse(organizer.consulted[1] ?? '{}') as { conversation: { question: string; answer: string }[] };
    expect(second.conversation).toHaveLength(1);
    expect(second.conversation[0]?.question).toContain('全体の方針をまとめて');
    expect(second.conversation[0]?.answer).toContain('【要点】');
    expect(await panel.getByTestId('consult-older').locator('summary').textContent()).toContain('全体の方針をまとめて');

    // ここまで、問い・答えの字は、どの表にも残っていない
    expect(dump()).not.toContain('照合用');
    expect(dump()).not.toContain('胸部画像で浸潤影の有無');
    expect(server.db.raw.prepare('SELECT count(*) AS n FROM consult_notes').get()).toEqual({ n: 0 });

    // 前のやりとりの答えを残す：押した答えだけが残る（問いは残らない）
    await panel.getByTestId('consult-older').locator('summary').click();
    await panel.getByTestId('consult-older').getByTestId('consult-keep').click();
    const kept = panel.getByTestId('consult-kept');
    await expect.poll(() => kept.count(), { timeout: 10_000 }).toBe(1);
    expect(await panel.getByTestId('consult-older').getByTestId('consult-kept-done').textContent()).toContain('残しました');
    await kept.locator('summary').click();
    const text = (await kept.getByTestId('consult-kept-text').textContent()) ?? '';
    expect(text).toContain('【要点】');
    expect(text).toContain('（推論）');
    expect(text).toContain('30※');
    expect(await kept.textContent()).toContain('AI の相談');
    expect(await kept.textContent()).toContain('書籍 架空の内科学 120');
    const rows = server.db.raw.prepare('SELECT mode, text FROM consult_notes').all() as { mode: string; text: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mode).toBe('consult');
    expect(dump()).not.toContain('照合用');
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await kept.screenshot({ path: `${SHOTS}/consult-phone-kept.png` });

    // いまのタブの入口に、残した数が出る。残した答えは、消せる
    await page.getByTestId('tab-state').click();
    expect(await page.getByTestId('consult-entrance').textContent()).toContain('残した答え 1 件');
    if (SHOTS !== undefined) await page.getByTestId('consult-entrance').screenshot({ path: `${SHOTS}/consult-entrance.png` });
    await page.getByTestId('fab-consult').click();
    await kept.locator('summary').click();
    await kept.getByTestId('consult-kept-delete').click();
    await kept.getByTestId('consult-kept-delete-confirm').click();
    await expect.poll(() => kept.count()).toBe(0);
    expect(server.db.raw.prepare('SELECT count(*) AS n FROM consult_notes').get()).toEqual({ n: 0 });

    // 新しい相談にする：このやりとりを消す
    await panel.getByTestId('consult-reset').click();
    expect(await panel.getByTestId('consult-entry').count()).toBe(0);

    // 問いに電話番号の形があれば、送らない
    await panel.getByTestId('consult-question').fill(`${['090', '1234', '5678'].join('-')} に連絡する？`);
    await panel.getByTestId('consult-send').click();
    expect(await panel.getByTestId('consult-message').textContent()).toContain('電話番号');
    expect(organizer.consulted).toHaveLength(2);
    expect(problems).toEqual([]);
  });

  test('「記録だけから答える」に切り替えると、記録に聞く（CA-066）のとおりに答える。この答えも、押せば残せる', async () => {
    const page = await openWithNote(false);
    await page.getByTestId('tab-state').click();
    await page.getByTestId('open-ask').click();
    const panel = page.getByTestId('consult');
    expect(await panel.getByTestId('consult-mode-record').getAttribute('aria-pressed')).toBe('true');
    expect(await panel.getByTestId('ask-caution').textContent()).toBe('記録だけから答えます。書かれていないことは答えません。');
    expect(await panel.getByTestId('consult-web').count()).toBe(0);
    // 自動で組まれる臨床支援が済むのを待つ（書籍の検索の数を、相談の前後で比べるため）
    await expect.poll(() => organizer.supported.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const searched = books.asked.length;
    await panel.getByTestId('consult-question').fill('いつから熱がある？');
    await panel.getByTestId('consult-send').click();
    await expect.poll(() => panel.getByTestId('ask-statement').count(), { timeout: 10_000 }).toBe(1);
    await panel.getByTestId('ask-ref').first().click();
    expect(await panel.getByTestId('ask-quote').textContent()).toContain('3日前の夕方から悪寒と発熱あり');
    // 記録だけから：外を探さない（語も取り出さない）
    expect(organizer.asked).toHaveLength(1);
    expect(organizer.consulted).toHaveLength(0);
    expect(organizer.termed).toHaveLength(0);
    expect(books.asked).toHaveLength(searched);

    await panel.getByTestId('consult-keep').click();
    await expect.poll(() => panel.getByTestId('consult-kept').count(), { timeout: 10_000 }).toBe(1);
    expect(await panel.getByTestId('consult-kept').textContent()).toContain('AI が記録から答えた');
    expect(server.db.raw.prepare('SELECT mode FROM consult_notes').all()).toEqual([{ mode: 'record' }]);
    expect(await fits(page)).toBe(true);
    expect(problems).toEqual([]);
  });
});

describe('相談の窓口（段M）：広い画面', () => {
  test('右に並ぶ（記録を見ながら相談する）。タブを切り替えても開いたまま。根拠の記載の札を押すと、記録のタブでその記載が開く', async () => {
    const page = await openWithNote(true);
    await page.getByTestId('tab-state').click();
    await page.getByTestId('fab-consult').click();
    const dock = page.getByTestId('consult-dock');
    await dock.waitFor();
    // いまのタブの中身は、出たまま（窓口は、その右）
    expect(await page.getByTestId('tab-state').getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('consult-entrance').isVisible()).toBe(true);
    const box = await dock.boundingBox();
    const card = await page.getByTestId('consult-entrance').boundingBox();
    expect((card?.x ?? 0) + (card?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + 1);
    // 「入れる」「相談」のボタンは、窓口に重ならない
    const fab = await page.getByTestId('fab-consult').boundingBox();
    expect((fab?.x ?? 0) + (fab?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + 1);

    await dock.getByTestId('consult-question').fill('全体の方針をまとめて');
    await dock.getByTestId('consult-send').click();
    await expect.poll(() => dock.getByTestId('consult-statement').count(), { timeout: 10_000 }).toBe(5);
    expect(await fits(page)).toBe(true);
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/consult-wide.png` });

    // タブを切り替えても、窓口は開いたまま
    await page.getByTestId('tab-course').click();
    expect(await dock.getByTestId('consult-statement').count()).toBe(5);
    // 根拠の記載の札 → 記録のタブで、その記載が開く
    await dock.getByTestId('consult-ref-open').first().click();
    expect(await page.getByTestId('tab-notes').getAttribute('aria-selected')).toBe('true');
    expect(await page.getByTestId('source').first().textContent()).toContain('3日前の夕方から悪寒と発熱あり');
    expect(await dock.isVisible()).toBe(true);

    // 閉じると、中身は元の幅に戻る
    await dock.getByTestId('consult-close').click();
    expect(await page.getByTestId('consult-dock').count()).toBe(0);
    expect(problems).toEqual([]);
  });
});
