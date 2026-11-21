// 整理の評価の道具（docs/03 の 3。CD-018）：架空の文を、本番と同じ流れ（AI の整理 → core の applyOrganization の確かめ）に通し、
// 記録に入った行を、文ごとの決まり（organize-cases.ts）で数える。決まりを超えた数は「余分」、足りない数は「欠け」。
// 返すのは、決まりの id と数だけ（文・AI の答えは返さない。どれも架空の文のものだが、選別の評価と同じ扱いにする）。
import { applyOrganization, cleanText, foldSameLength, lowerAscii, MEDICATION_ACTIONS, type Organized, reportTotal, SOURCE_KINDS } from '@clinical-carte/core';
import { z } from 'zod';

import type { Organizer } from '../src/organizer.ts';
import type { OrganizePromptChoice } from '../src/prompt.ts';

export const OrganizeRule = z
  .strictObject({
    id: z.string().regex(/^[a-z]\d{1,2}$/),
    label: z.string().min(1).max(60),
    target: z.enum(['problem', 'medication', 'event', 'measurement']),
    match: z.string().min(1),
    mode: z.enum(['starts', 'includes']).optional(),
    action: z.enum(MEDICATION_ACTIONS).optional(),
    active: z.literal(true).optional(),
    /** 記録に入った日時がこれのものだけを数える（測定値・投薬・できごと。区切りの時刻・記載の時刻の確かめ） */
    at: z.string().min(10).optional(),
    min: z.number().int().min(0),
    max: z.number().int().min(0),
  })
  .refine((r) => r.min <= r.max, 'min は max 以下');
export type OrganizeRule = z.infer<typeof OrganizeRule>;

export const OrganizeCase = z.strictObject({
  id: z.string().regex(/^[a-z]+-\d{2}$/),
  synthetic: z.literal(true),
  note: z.string().min(1),
  // 検査結果・バイタルの文は、AI の指した場所を使わず文全体を読むので、測定値の評価にならない
  kind: z.enum(SOURCE_KINDS).refine((k) => k !== 'lab' && k !== 'vital', '検査結果・バイタルの文は使わない'),
  at: z.string().min(1),
  encounterStart: z.string().min(1),
  text: z.string().min(1),
  rules: z.array(OrganizeRule).min(1),
});
export type OrganizeCase = z.infer<typeof OrganizeCase>;

/** 架空の文の集まりの形を確かめる（id の重なり、決まりの id の重なり） */
export function checkOrganizeCases(input: readonly unknown[]): OrganizeCase[] {
  const cases = input.map((c) => OrganizeCase.parse(c));
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('id が重なっている');
  for (const c of cases) if (new Set(c.rules.map((r) => r.id)).size !== c.rules.length) throw new Error(`${c.id}：決まりの id が重なっている`);
  return cases;
}

const fold = (s: string): string => lowerAscii(foldSameLength(s)).replace(/\s+/gu, '');
/** 問題の名前の頭の番号（「#1 」）を除く */
const core = (name: string): string => name.replace(/^[#＃]\s*\d+\s*[.．:：)）]?\s*/u, '');

/** 決まりに合う、記録に入った行の数 */
export function countMatches(organized: Organized, rule: OrganizeRule): number {
  const m = fold(rule.match);
  const hit = (s: string, mode: 'starts' | 'includes'): boolean => (mode === 'starts' ? fold(s).startsWith(m) : fold(s).includes(m));
  const atOk = (at: string | null): boolean => rule.at === undefined || at === rule.at;
  switch (rule.target) {
    case 'problem':
      return organized.problems.filter((p) => hit(core(p.name), rule.mode ?? 'starts') && (rule.active !== true || p.activity === null)).length;
    case 'medication':
      return organized.medications.filter((x) => hit(x.name, rule.mode ?? 'includes') && (rule.action === undefined || x.action === rule.action) && atOk(x.at)).length;
    case 'event':
      return organized.events.filter((x) => hit(x.title, rule.mode ?? 'includes') && atOk(x.at)).length;
    case 'measurement':
      return organized.observations.filter((o) => o.row.name === rule.match && atOk(o.at)).length;
  }
}

export interface OrganizeScore {
  readonly id: string;
  /** 整理が通らなかった理由（通ったなら null） */
  readonly failed: string | null;
  /** 決まりを超えた（拾いすぎ）決まりの id */
  readonly extra: readonly string[];
  /** 足りない（拾い漏れ）決まりの id */
  readonly missing: readonly string[];
  /** 記録に入った行の数 */
  readonly counts: { readonly problems: number; readonly medications: number; readonly events: number; readonly measurements: number } | null;
  /** 確かめの網で落ちた件数（引用が文にない など） */
  readonly unverified: number;
}

/** 架空の文を1つ、選んだ版の指示で整理し、確かめた後の行を、決まりで数える */
export async function scoreOrganize(c: OrganizeCase, organizer: Organizer, prompt: OrganizePromptChoice): Promise<OrganizeScore> {
  const text = cleanText(c.text);
  const result = await organizer.organize(text, prompt);
  if (!result.ok) return { id: c.id, failed: result.reason, extra: [], missing: [], counts: null, unverified: 0 };
  const organized = applyOrganization(result.answer, { text, kind: c.kind, at: c.at, encounterStart: c.encounterStart });
  const extra: string[] = [];
  const missing: string[] = [];
  for (const rule of c.rules) {
    const n = countMatches(organized, rule);
    if (n > rule.max) extra.push(rule.id);
    if (n < rule.min) missing.push(rule.id);
  }
  return {
    id: c.id,
    failed: null,
    extra,
    missing,
    counts: { problems: organized.problems.length, medications: organized.medications.length, events: organized.events.length, measurements: organized.observations.length },
    unverified: reportTotal(organized.report),
  };
}
