// 選別の評価を、配ってあるサーバーで動かす（docs/03 の 3）：本番と同じ鍵・同じ指示・同じモデルで、架空の文だけを AI に送り、漏れを数える。
// 本人が、carte の画面から動かす（コマンドを打たない）。使うのは、eval/ の架空の文と採点（手元の道具と同じもの）。
// 保存するのは、AI を呼んだ回数だけ。文・AI の答え・結果は、保存もログもしない。
import { z } from 'zod';

import { CASES } from '../eval/cases.ts';
import { build, checkCases, type EvalCase, score } from '../eval/lib.ts';
import { ORGANIZE_CASES } from '../eval/organize-cases.ts';
import { checkOrganizeCases, type OrganizeCase, type OrganizeScore, scoreOrganize } from '../eval/organize-lib.ts';
import type { Organizer } from './organizer.ts';
import type { Selector } from './selector.ts';

const cases: readonly EvalCase[] = checkCases(CASES);

export const SelfCheckRequest = z.strictObject({
  id: z.string().min(1).max(20),
  /** 架空の名前・番号を組み立てる種。同じ種なら、同じ文になる */
  seed: z.number().int().min(1).max(1_000_000_000),
});

export interface SelfCheckCase {
  readonly id: string;
  readonly note: string;
  /** 混ぜる識別情報の数 */
  readonly planted: number;
}

export function selfCheckCases(): SelfCheckCase[] {
  return cases.map((c) => ({ id: c.id, note: c.note, planted: Object.keys(c.slots).length }));
}

export interface SelfCheckResult {
  readonly id: string;
  /** 選別が通らなかった理由（通ったなら null）。その文は、保存されない扱い */
  readonly failed: string | null;
  /** 残った識別情報の数（目標は 0） */
  readonly leaked: number;
  /** 消えた、残すべき語の数（指しすぎ） */
  readonly lost: number;
  /** 混ぜた場所だけが置き換わったか（確かめない文は null） */
  readonly exact: boolean | null;
  /** 混ぜた場所の外で、変わった部分（架空の文のひな形の字だけ。混ぜた名前などは入らない） */
  readonly altered: readonly string[];
}

/** 架空の文を1つ組み立て、本番と同じ流れ（整え → 選別 → 置き換え → 形の検査）を通して、採点する。文そのものは返さない。 */
export async function runSelfCheck(id: string, seed: number, selector: Selector): Promise<SelfCheckResult | null> {
  const found = cases.find((c) => c.id === id);
  if (found === undefined) return null;
  const s = await score(build(found, seed), selector);
  return { id: s.id, failed: s.failed, leaked: s.leaked.length, lost: s.lost.length, exact: s.exact, altered: s.altered };
}

// ---------------------------------------------------------------------------
// 整理の評価（CD-018）：架空の文を、選んだ版の指示（いまの版・前の版）で整理し、記録に入る行を決まりで数える。
// 前後を比べるために、前の版の指示を残してある（prompt.ts の ORGANIZE_PROMPTS。本番の整理は、いつもいまの版）。
// 保存するのは、AI を呼んだ回数だけ。文・AI の答え・結果は、保存もログもしない。

const organizeCases: readonly OrganizeCase[] = checkOrganizeCases(ORGANIZE_CASES);

export const OrganizeCheckRequest = z.strictObject({
  id: z.string().min(1).max(20),
  prompt: z.enum(['current', 'previous']),
});

export interface OrganizeCheckCase {
  readonly id: string;
  readonly note: string;
  /** 決まりの id と説明（架空の文の決まり。AI の答えではない） */
  readonly rules: readonly { readonly id: string; readonly label: string }[];
}

export function organizeCheckCases(): OrganizeCheckCase[] {
  return organizeCases.map((c) => ({ id: c.id, note: c.note, rules: c.rules.map((r) => ({ id: r.id, label: r.label })) }));
}

export async function runOrganizeCheck(id: string, prompt: 'current' | 'previous', organizer: Organizer): Promise<OrganizeScore | null> {
  const found = organizeCases.find((c) => c.id === id);
  if (found === undefined) return null;
  return scoreOrganize(found, organizer, prompt);
}
