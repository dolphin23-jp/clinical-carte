// 選別の評価の道具（docs/03 の 5）：新しく書いた架空の文に、名前・番号・連絡先を**実行時に組み立てて**混ぜ、
// 選別 → 置き換え → 形の検査（本番と同じ流れ）を通して、落とし漏れを数える。目標は、漏れ 0。
// 実在の患者の文は、入れない。ここにある名前・施設・番号は、部品から組み立てた架空のもの。
import { applySelection, cleanText, IDENTIFIER_KINDS, type IdentifierKind, replaceShapes } from '@clinical-carte/core';
import { z } from 'zod';

import type { Selector } from '../src/selector.ts';

export const POOLS = ['fullname', 'surname', 'surname1', 'given', 'initials', 'id', 'birth', 'address', 'phone', 'email', 'clinic', 'hospital', 'care', 'company'] as const;
export type Pool = (typeof POOLS)[number];

export const EvalCase = z.strictObject({
  id: z.string().regex(/^[a-z]+-\d{2}$/),
  synthetic: z.literal(true),
  note: z.string().min(1),
  template: z.string().min(1),
  slots: z.record(z.string().regex(/^[A-Z]+\d$/), z.strictObject({ kind: z.enum(IDENTIFIER_KINDS), pool: z.enum(POOLS) })),
  /** 残っていなければならない語（指しすぎの確かめ） */
  keep: z.array(z.string().min(1)),
  /** 置き換えの範囲が、敬称まで広がってよい場合（1字の姓）。漏れと、残すべき語だけを確かめる */
  loose: z.literal(true).optional(),
});
export type EvalCase = z.infer<typeof EvalCase>;

/** 架空の文の集まりの、形を確かめる（id の重なり、文の中の {…} と slots の食い違い）。 */
export function checkCases(input: readonly unknown[]): EvalCase[] {
  const cases = input.map((c) => EvalCase.parse(c));
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) throw new Error('id が重なっている');
  for (const c of cases) {
    const used = new Set([...c.template.matchAll(/\{([A-Z]+\d)\}/g)].map((m) => m[1] ?? ''));
    const declared = new Set(Object.keys(c.slots));
    if (used.size !== declared.size || [...used].some((u) => !declared.has(u))) throw new Error(`${c.id}：文の中の {…} と slots が合わない`);
  }
  return cases;
}

/** 決まった種から、決まった並びの数を作る（同じ種なら、同じ文になる） */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// 名前などの部品。組み立ては実行時（ソースに、敬称つきの名前や番号の形を置かない）
const SURNAME_PARTS = [['佐', '藤'], ['鈴', '木'], ['高', '橋'], ['田', '中'], ['伊', '藤'], ['渡', '辺'], ['山', '本'], ['中', '村'], ['小', '林'], ['加', '藤'], ['長谷', '川'], ['五十', '嵐']];
const SURNAME1 = ['林', '森', '原', '関', '東', '南'];
const GIVEN_PARTS = [['太', '郎'], ['花', '子'], ['健', '一'], ['美', '咲'], ['正', '男'], ['和', '子'], ['翔', '太'], ['陽', '菜']];
const PLACE = ['みなと', 'さくら', 'あおば', 'ひかり', 'みどり', '若葉', '港南', '北山'];
const CITY = ['見本', '架空', '仮', '例示'];
const DIGITS = Array.from({ length: 10 }, (_, i) => String(i));
const NON_ZERO = DIGITS.slice(1);
const INITIAL_FIRST = Array.from('KMSTYH');
const INITIAL_SECOND = Array.from('ANORIE');

export function fill(pool: Pool, random: () => number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const digits = (n: number): string => Array.from({ length: n }, () => pick(DIGITS)).join('');
  const nonZero = (): string => pick(NON_ZERO);
  const surname = (): string => pick(SURNAME_PARTS).join('');
  const given = (): string => pick(GIVEN_PARTS).join('');
  switch (pool) {
    case 'fullname':
      return `${surname()}${pick(['', ' ', '　'])}${given()}`;
    case 'surname':
      return surname();
    case 'surname1':
      return pick(SURNAME1);
    case 'given':
      return given();
    case 'initials':
      return `${pick(INITIAL_FIRST)}.${pick(INITIAL_SECOND)}.`;
    case 'id':
      return `${nonZero()}${digits(pick([6, 7]))}`;
    case 'birth':
      return pick([`昭和${String(20 + Math.floor(random() * 40))}年${String(1 + Math.floor(random() * 12))}月${String(1 + Math.floor(random() * 28))}日`, `19${digits(1)}${digits(1)}/${String(1 + Math.floor(random() * 12))}/${String(1 + Math.floor(random() * 28))}`]);
    case 'address':
      return `${pick(CITY)}市${pick(PLACE)}町${nonZero()}-${nonZero()}${digits(1)}-${nonZero()} ${pick(PLACE)}ハイツ${nonZero()}0${nonZero()}`;
    case 'phone':
      return `${pick(['090', '080', '070'])}-${digits(4)}-${digits(4)}`;
    case 'email':
      return `${pick(['taro', 'hanako', 'ken'])}${digits(2)}@${pick(['example', 'mihon'])}.${pick(['jp', 'com'])}`;
    case 'clinic':
      return `${pick(PLACE)}${pick(['クリニック', '内科医院', '診療所', 'ファミリークリニック'])}`;
    case 'hospital':
      return `${pick(PLACE)}${pick(['総合病院', '記念病院', '市民病院', '医療センター'])}`;
    case 'care':
      return `${pick(PLACE)}${pick(['苑', 'の里', '荘'])}`;
    case 'company':
      return `${pick(PLACE)}${pick(['製作所', '運輸', '商事', '工務店'])}`;
  }
}

export interface BuiltCase {
  readonly id: string;
  readonly text: string;
  /** 混ぜた識別情報（種類と、その文字） */
  readonly planted: readonly { readonly slot: string; readonly kind: IdentifierKind; readonly value: string }[];
  readonly keep: readonly string[];
  readonly loose: boolean;
  /** 混ぜた場所を、印（\u0001）にした文。置き換えの結果と比べる */
  readonly skeleton: string;
}

export function build(c: EvalCase, seed: number): BuiltCase {
  const random = seeded(seed);
  const planted = Object.entries(c.slots).map(([slot, spec]) => ({ slot, kind: spec.kind, value: fill(spec.pool, random) }));
  let text = c.template;
  let skeleton = c.template;
  for (const p of planted) {
    text = text.split(`{${p.slot}}`).join(p.value);
    skeleton = skeleton.split(`{${p.slot}}`).join('\u0001');
  }
  return { id: c.id, text, planted, keep: c.keep, loose: c.loose === true, skeleton };
}

export interface CaseScore {
  readonly id: string;
  /** 選別が通らなかった（その文は保存されない） */
  readonly failed: string | null;
  /** 残った識別情報（どの欄か。目標は 0） */
  readonly leaked: readonly string[];
  /** 消えた、残すべき語（指しすぎ） */
  readonly lost: readonly string[];
  /** 混ぜた場所だけが置き換わったか（loose の文は、確かめない） */
  readonly exact: boolean | null;
  /** 混ぜた場所の外で、変わった部分（架空の文のひな形の字。空なら、なし）。名前など、混ぜたものは入らない */
  readonly altered: readonly string[];
}

/** 本番と同じ流れ（整え → 選別 → 置き換え → 形の検査）を通して、1つの文を採点する。 */
/** 変わった部分として出す長さの上限（字） */
const ALTERED_MAX = 16;

/**
 * 混ぜた場所の外（ひな形の、{…} のあいだの文字）が、置き換えの後の文に、そのままの順で残っているかを見る。
 * 残っていない部分を返す。混ぜた場所の中がどう置き換わったか（1つの語か、2つに分けたか、どの語か）は問わない：
 *  - 氏名・住所を2つに分けて指す → 混ぜた場所の中だけが変わる（問題ではない）
 *  - 施設を「当院」と読む → 文にもとからある「当院」と同じ語になるが、混ぜた場所の中（問題ではない）
 *  - 「様」「生」まで指す → 混ぜた場所の外の字が消える（数える）
 * 空白だけの部分（隣り合う2つの識別情報のあいだ）は見ない（2つをまとめて1つに指しても、消えるのは空白だけ）。
 */
export function alteredParts(final: string, skeleton: string): string[] {
  const parts = skeleton.split('\u0001');
  const altered: string[] = [];
  let cursor = 0;
  parts.forEach((part, index) => {
    if (part.trim() === '') return;
    const at = final.indexOf(part, cursor);
    const first = index === 0;
    const last = index === parts.length - 1;
    if (at < 0 || (first && at !== 0) || (last && at + part.length !== final.length)) {
      altered.push(part.trim().slice(0, ALTERED_MAX));
      return;
    }
    cursor = at + part.length;
  });
  return altered;
}

/** 本番と同じ流れ（整え → 選別 → 置き換え → 形の検査）を通して、1つの文を採点する。 */
export async function score(built: BuiltCase, selector: Selector): Promise<CaseScore> {
  const clean = cleanText(built.text);
  const selected = await selector.select(clean);
  if (!selected.ok) return { id: built.id, failed: `ai:${selected.reason}`, leaked: [], lost: [], exact: null, altered: [] };
  const applied = applySelection(clean, selected.answer);
  if (!applied.ok) return { id: built.id, failed: `selection:${applied.problems.join(',')}`, leaked: [], lost: [], exact: null, altered: [] };
  const final = replaceShapes(applied.text).text;
  const leaked = built.planted.filter((p) => final.includes(p.value)).map((p) => p.slot);
  const lost = built.keep.filter((k) => !final.includes(k));
  // loose の文（1字の姓は、敬称と合わせて指す決まり）は、混ぜた場所の外の字が消えてよいので、確かめない
  const altered = built.loose ? [] : alteredParts(final, built.skeleton);
  return { id: built.id, failed: null, leaked, lost, exact: built.loose ? null : altered.length === 0, altered };
}

export interface Summary {
  readonly cases: number;
  readonly failed: number;
  readonly leakedCases: number;
  readonly leakedSlots: number;
  readonly lostCases: number;
  readonly inexact: number;
}

export function summarize(scores: readonly CaseScore[]): Summary {
  return {
    cases: scores.length,
    failed: scores.filter((s) => s.failed !== null).length,
    leakedCases: scores.filter((s) => s.leaked.length > 0).length,
    leakedSlots: scores.reduce((n, s) => n + s.leaked.length, 0),
    lostCases: scores.filter((s) => s.lost.length > 0).length,
    inexact: scores.filter((s) => s.exact === false).length,
  };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 答えを知っている代役（道具そのものの確かめ用）：文のひな形から、混ぜた場所を見つけて、そのまま指す。
 * どの種（名前の組み立て）で作った文でも、答えられる。
 */
export function oracleSelector(cases: readonly EvalCase[]): Selector {
  const patterns = cases.map((c) => {
    const slots: string[] = [];
    const source = c.template
      .split(/(\{[A-Z]+\d\})/)
      .map((part) => {
        const m = /^\{([A-Z]+\d)\}$/.exec(part);
        if (m === null) return escapeRegExp(part);
        slots.push(m[1] ?? '');
        return '(.+?)';
      })
      .join('');
    return { c, slots, re: new RegExp(`^${source}$`, 'su') };
  });
  return {
    select: (text) => {
      for (const { c, slots, re } of patterns) {
        const m = re.exec(text);
        if (m === null) continue;
        const seen = new Set<string>();
        const identifiers = slots
          .map((slot, i) => ({ kind: c.slots[slot]?.kind ?? ('person' as const), value: m[i + 1] ?? '' }))
          .filter((p) => (seen.has(p.value) ? false : (seen.add(p.value), true)))
          // 1字の名前は、すぐ後ろの敬称と合わせて指す
          .map((p) => ({ kind: p.kind, quote: p.value.length >= 2 ? p.value : `${p.value}さん`, facility: null }));
        return Promise.resolve({ ok: true, answer: { identifiers } });
      }
      return Promise.resolve({ ok: true, answer: { identifiers: [] } });
    },
  };
}
