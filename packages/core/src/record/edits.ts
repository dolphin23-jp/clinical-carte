// 問題以外の事実を、本人が直す（段3e。docs/04 の 10）。直せるのは、外す・戻すと、選ぶだけの直し。打つ欄はない
// （打った文は選別を通す決まり。docs/01 の 2）。API の本文の形と、直した値を整理し直しで引き継ぐための鍵は、ここの1か所。
import { z } from 'zod';

import { EVENT_KINDS, MEDICATION_ACTIONS } from '../organize/answer.ts';
import { DateTime } from './schema.ts';

export const FACT_KINDS = ['medication', 'event', 'observation'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const FACT_FIELDS = ['excluded', 'action', 'kind', 'at'] as const;
export type FactField = (typeof FACT_FIELDS)[number];

export const FACT_FIELD_NAMES: Readonly<Record<FactField, string>> = {
  excluded: '外す・戻す',
  action: '投薬の動き',
  kind: 'できごとの種類',
  at: '日時',
};

/** 事実の直し：1回に1つの欄。action は投薬だけ、kind はできごとだけ（サーバーが確かめる） */
export const FactPatch = z.union([
  z.strictObject({ excluded: z.boolean() }),
  z.strictObject({ action: z.enum(MEDICATION_ACTIONS).nullable() }),
  z.strictObject({ kind: z.enum(EVENT_KINDS) }),
  z.strictObject({ at: DateTime.nullable() }),
]);
export type FactPatch = z.infer<typeof FactPatch>;

/** その直しが、その種類の事実に使えるか */
export function patchFits(fact: FactKind, patch: FactPatch): boolean {
  if ('action' in patch) return fact === 'medication';
  if ('kind' in patch) return fact === 'event';
  return true;
}

/** 整理し直しで、本人の直しを引き継ぐための鍵：同じ文の、同じ場所の、同じ字（場所が変われば、引き継がない） */
export function carryKey(start: number, end: number, text: string): string {
  return `${String(start)}:${String(end)}:${text}`;
}
