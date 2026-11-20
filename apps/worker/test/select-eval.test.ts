// 選別の評価の道具（eval/）そのものの確かめ。本物の AI は呼ばない。
import { findShapes } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { CASES } from '../eval/cases.ts';
import { alteredParts, build, checkCases, fill, oracleSelector, POOLS, score, seeded, summarize } from '../eval/lib.ts';
import type { Selector } from '../src/selector.ts';

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

describe('混ぜた場所のほかも置き換えたか（2026-11-21 の本番の評価で、害のない答え方まで数えていたのを直した）', () => {
  type Planted = ReturnType<typeof build>['planted'][number];
  type Quote = { kind: Planted['kind']; quote: string; facility: 'own' | 'local' | 'previous' | 'other' | null };
  const plain = (p: Planted): Quote => ({ kind: p.kind, quote: p.value, facility: null });
  const answering = (f: (planted: readonly Planted[]) => Quote[]) => (b: ReturnType<typeof build>): Selector => ({
    select: () => Promise.resolve({ ok: true, answer: { identifiers: f(b.planted) } }),
  });
  const caseOf = (id: string) => {
    const c = cases.find((x) => x.id === id);
    if (c === undefined) throw new Error(id);
    return c;
  };

  test.each<[string, string, (planted: readonly Planted[]) => Quote[]]>([
    ['施設を「当院」と読む（文にもとからある「当院」と同じ語になる）', 'ref-01', (ps) => ps.map((p) => (p.slot === 'F2' ? { ...plain(p), facility: 'own' } : plain(p)))],
    ['住所を2つに分けて指す', 'adm-01', (ps) => ps.flatMap((p) => (p.slot === 'A1' ? p.value.split(' ').map((quote) => ({ ...plain(p), quote })) : [plain(p)]))],
    ['氏名の姓と名を別々に指す', 'adm-01', (ps) => ps.flatMap((p) => (p.slot === 'P1' ? p.value.split(/[ \u3000]/).filter((q) => q !== '').map((quote) => ({ ...plain(p), quote })) : [plain(p)]))],
    ['隣り合う施設と医療者を、まとめて1つに指す', 'ref-01', (ps) => {
      const f1 = ps.find((p) => p.slot === 'F1');
      const s1 = ps.find((p) => p.slot === 'S1');
      if (f1 === undefined || s1 === undefined) throw new Error('slot');
      return [{ kind: 'facility', quote: `${f1.value} ${s1.value}`, facility: null }, ...ps.filter((p) => p !== f1 && p !== s1).map(plain)];
    }],
  ])('害のない答え方は、数えない：%s', async (_name, id, f) => {
    for (const seed of [1, 2, 3, 5, 8]) {
      const b = build(caseOf(id), seed);
      const s = await score(b, answering(f)(b));
      expect([seed, s.leaked, s.exact, s.altered]).toEqual([seed, [], true, []]);
    }
  });

  test.each<[string, string, (planted: readonly Planted[]) => Quote[], string]>([
    ['敬称「様」まで置き換えた', 'adm-01', (ps) => ps.map((p) => (p.slot === 'P1' ? { ...plain(p), quote: `${p.value} 様` } : plain(p))), '様（'],
    ['「生」まで置き換えた', 'adm-01', (ps) => ps.map((p) => (p.slot === 'B1' ? { ...plain(p), quote: `${p.value}生` } : plain(p))), '生）'],
  ])('本当に余計な字まで置き換えたときは、数え、変わった部分を出す：%s', async (_name, id, f, part) => {
    const b = build(caseOf(id), 3);
    const s = await score(b, answering(f)(b));
    expect(s.exact).toBe(false);
    expect(s.altered).toHaveLength(1);
    expect(s.altered[0]).toContain(part);
    // 出すのは、ひな形の字だけ（混ぜた架空の名前は入らない）
    for (const p of b.planted) expect(s.altered.join('')).not.toContain(p.value);
  });

  test('文の頭・終わりの字が消えたときも、数える', () => {
    expect(alteredParts('〔氏名〕です', '【見出し】\u0001です')).toEqual(['【見出し】']);
    expect(alteredParts('【見出し】〔氏名〕', '【見出し】\u0001です')).toEqual(['です']);
    expect(alteredParts('【見出し】〔氏名〕〔氏名〕です', '【見出し】\u0001です')).toEqual([]);
  });
});
