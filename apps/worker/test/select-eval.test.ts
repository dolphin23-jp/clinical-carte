// 選別の評価の道具（eval/）そのものの確かめ。本物の AI は呼ばない。
import { findShapes } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { CASES } from '../eval/cases.ts';
import { build, checkCases, fill, oracleSelector, POOLS, score, seeded, summarize } from '../eval/lib.ts';

const cases = checkCases(CASES);
const raw = JSON.stringify(CASES);

describe('架空の文', () => {
  test('どの文も synthetic: true。文の中の {…} と slots が合う（checkCases が確かめる）', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of CASES) expect(c).toMatchObject({ synthetic: true });
    expect(() => checkCases([...CASES, CASES[0]])).toThrow('id が重なっている');
  });

  test('ファイルそのものには、識別情報の形がない（名前・番号は、実行時に組み立てる）', () => {
    expect(findShapes(raw)).toEqual([]);
    expect(raw).not.toMatch(/\d{7,}/);
  });

  test('残すべき語は、もとの文にある', () => {
    for (const c of cases) for (const k of c.keep) expect(c.template, `${c.id}: ${k}`).toContain(k);
  });

  test('識別情報のない文（日付・検査値・人名に由来する語だけ）が入っている', () => {
    expect(cases.filter((c) => Object.keys(c.slots).length === 0).length).toBeGreaterThanOrEqual(2);
  });
});

describe('組み立て', () => {
  test('同じ種からは、同じ文', () => {
    const c = cases[0];
    if (c === undefined) throw new Error('文がない');
    expect(build(c, 7)).toEqual(build(c, 7));
    expect(build(c, 7).text).not.toBe(build(c, 8).text);
  });

  test('どの部品も、2字以上の文字を作る（1字の姓だけは、敬称と合わせて指す）', () => {
    const random = seeded(1);
    for (const pool of POOLS) for (let i = 0; i < 20; i++) expect(fill(pool, random).length, pool).toBeGreaterThanOrEqual(pool === 'surname1' ? 1 : 2);
  });
});

describe('採点', () => {
  const built = cases.map((c, i) => build(c, 100 + i));

  test('答えを知っている代役なら、漏れ 0・指しすぎ 0・混ぜた場所だけが置き換わる', async () => {
    const selector = oracleSelector(cases);
    const scores = [];
    for (const b of built) scores.push(await score(b, selector));
    expect(scores.filter((s) => s.failed !== null || s.leaked.length > 0 || s.lost.length > 0 || s.exact === false)).toEqual([]);
    expect(summarize(scores)).toEqual({ cases: built.length, failed: 0, leakedCases: 0, leakedSlots: 0, lostCases: 0, inexact: 0 });
  });

  test('答えを知っている代役は、どの種で作った文でも答えられる', async () => {
    const selector = oracleSelector(cases);
    for (const seed of [1, 77, 4242]) {
      for (const c of cases) {
        const s = await score(build(c, seed), selector);
        expect([s.id, s.failed, s.leaked, s.lost, s.exact]).toEqual([c.id, null, [], [], c.loose === true ? null : true]);
      }
    }
  });

  test('何も指さない AI なら、漏れを数える（形で分かる電話・メールだけは、最後の網が落とす）', async () => {
    const nothing = { select: () => Promise.resolve({ ok: true as const, answer: { identifiers: [] } }) };
    const scores = [];
    for (const b of built) scores.push(await score(b, nothing));
    const s = summarize(scores);
    expect(s.leakedSlots).toBeGreaterThan(10);
    const adm = scores.find((x) => x.id === 'adm-01');
    expect(adm?.leaked).not.toContain('T1'); // 電話
    expect(adm?.leaked).toContain('P1'); // 氏名
  });

  test('指しすぎる AI（残すべき語まで指す）なら、指しすぎを数える', async () => {
    const tooMuch = { select: () => Promise.resolve({ ok: true as const, answer: { identifiers: [{ kind: 'person' as const, quote: 'パーキンソン病', facility: null }] } }) };
    const adm = built.find((b) => b.id === 'adm-01');
    if (adm === undefined) throw new Error('文がない');
    const s = await score(adm, tooMuch);
    expect(s.lost).toEqual(['パーキンソン病']);
  });

  test('AI が失敗したら、「通らなかった」に数える（漏れには数えない：その文は保存されない）', async () => {
    const down = { select: () => Promise.resolve({ ok: false as const, reason: 'unavailable' as const }) };
    const first = built[0];
    if (first === undefined) throw new Error('文がない');
    expect(await score(first, down)).toMatchObject({ failed: 'ai:unavailable', leaked: [] });
  });
});
