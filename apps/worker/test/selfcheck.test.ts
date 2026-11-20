// 選別の評価を、サーバーで動かす（/api/selfcheck）。本物の AI は呼ばない（代役）。
import { describe, expect, test } from 'vitest';

import { CASES } from '../eval/cases.ts';
import { build, checkCases, oracleSelector } from '../eval/lib.ts';
import { SELECT_PROMPT_VERSION } from '../src/prompt.ts';
import { fakeSelector, registered, world } from './support.ts';

const cases = checkCases(CASES);
const nothing = fakeSelector();

async function setup(overrides: Parameters<typeof world>[0] = {}) {
  const w = world({ selector: oracleSelector(cases), ...overrides });
  const { cookie } = await registered(w);
  return { w, cookie };
}

describe('評価の一覧', () => {
  test('文の id・説明・混ぜる数と、指示の版・モデルを返す（文そのものは返さない）', async () => {
    const { w, cookie } = await setup();
    const r = await w.call('GET', '/api/selfcheck', { cookie });
    const text = await r.clone().text();
    const body = (await r.json()) as { cases: { id: string; note: string; planted: number }[]; promptVersion: string; model: string; ready: boolean };
    expect(body.cases.map((c) => c.id)).toEqual(cases.map((c) => c.id));
    expect(body.promptVersion).toBe(SELECT_PROMPT_VERSION);
    expect(body.model).toBe('test-model');
    expect(body.ready).toBe(true);
    expect(text).not.toContain('template');
    expect(text).not.toContain('{P1}');
  });

  test('AI の鍵がないときは、動かせないと分かる', async () => {
    const { w, cookie } = await setup({ selector: null });
    expect(((await (await w.call('GET', '/api/selfcheck', { cookie })).json()) as { ready: boolean }).ready).toBe(false);
    const r = await w.call('POST', '/api/selfcheck', { cookie, body: { id: 'er-01', seed: 1 } });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'no_ai' });
  });

  test('登録していない端末には、答えない', async () => {
    const { w } = await setup();
    expect((await w.call('GET', '/api/selfcheck')).status).toBe(401);
    expect((await w.call('POST', '/api/selfcheck', { body: { id: 'er-01', seed: 1 } })).status).toBe(401);
  });
});

describe('1つの文を採点する', () => {
  test('答えを知っている代役なら、漏れ 0。返すのは数だけ（混ぜた名前・文を返さない）', async () => {
    const { w, cookie } = await setup();
    for (const c of cases) {
      const r = await w.call('POST', '/api/selfcheck', { cookie, body: { id: c.id, seed: 4242 } });
      const text = await r.clone().text();
      expect(await r.json(), c.id).toEqual({ result: { id: c.id, failed: null, leaked: 0, lost: 0, exact: c.loose === true ? null : true, altered: [] } });
      for (const p of build(c, 4242).planted) expect(text, c.id).not.toContain(p.value);
    }
  });

  test('何も指さない AI なら、漏れを数える', async () => {
    const { w, cookie } = await setup({ selector: nothing });
    const r = await w.call('POST', '/api/selfcheck', { cookie, body: { id: 'er-01', seed: 7 } });
    const body = (await r.json()) as { result: { leaked: number; failed: string | null } };
    expect(body.result.failed).toBeNull();
    expect(body.result.leaked).toBeGreaterThan(0);
  });

  test('AI が失敗したら、「通らなかった」として返す', async () => {
    const { w, cookie } = await setup({ selector: fakeSelector([], () => ({ ok: false, reason: 'unavailable' })) });
    const r = await w.call('POST', '/api/selfcheck', { cookie, body: { id: 'er-01', seed: 7 } });
    expect(await r.json()).toEqual({ result: { id: 'er-01', failed: 'ai:unavailable', leaked: 0, lost: 0, exact: null, altered: [] } });
  });

  test('ない id は 404。形の違う要求は 400', async () => {
    const { w, cookie } = await setup();
    expect((await w.call('POST', '/api/selfcheck', { cookie, body: { id: 'zz-99', seed: 1 } })).status).toBe(404);
    for (const body of [{ id: 'er-01' }, { id: 'er-01', seed: 0 }, { id: 'er-01', seed: 1.5 }, { id: 'er-01', seed: 1, text: 'x' }, { seed: 1 }]) {
      expect((await w.call('POST', '/api/selfcheck', { cookie, body })).status).toBe(400);
    }
  });

  test('架空の文を、記録に保存しない。数えるのは、AI を呼んだ回数だけ。1日の上限に含める', async () => {
    const { w, cookie } = await setup({ dailyAiLimit: 2 });
    const post = () => w.call('POST', '/api/selfcheck', { cookie, body: { id: 'er-01', seed: 1 } });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
    expect(w.db.raw.prepare('SELECT * FROM usage_daily').all()).toEqual([{ day: '2026-11-20', calls: 2 }]);
    for (const table of ['patients', 'encounters', 'sources', 'observations']) expect(w.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
  });
});
