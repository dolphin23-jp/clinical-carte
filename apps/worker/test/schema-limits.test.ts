// 構造化出力の、答えの形の大きさの上限（API の決まり）：null になりうる欄（anyOf・型の配列）は 16 まで、必須でない欄は 24 まで。
// 超えると、API は 400 で断り、画面には「AI につながりませんでした」と出る（2026-11-22：organize-6 の形が 41 になり、整理がすべて断られた）。
// 本物の呼び出しと同じ変換（SDK の zodOutputFormat）で作った形を数える。
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AskAnswer, DocumentAnswer, LinkAnswer, OrganizeAnswerWire, PendingAnswer, ProblemListAnswer, ReviseAnswer, SelectionAnswer, SupportAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

/** API の決まり（https://platform.claude.com/docs/en/build-with-claude/structured-outputs の Schema complexity limits。2026-11-22 に確認） */
const UNION_MAX = 16;
const OPTIONAL_MAX = 24;

function count(schema: unknown): { unions: number; optional: number } {
  let unions = 0;
  let optional = 0;
  const walk = (s: unknown): void => {
    if (s === null || typeof s !== 'object') return;
    if (Array.isArray(s)) {
      for (const x of s) walk(x);
      return;
    }
    const o = s as Record<string, unknown>;
    if (typeof o['properties'] === 'object' && o['properties'] !== null) {
      const required = new Set(Array.isArray(o['required']) ? (o['required'] as string[]) : []);
      for (const [key, value] of Object.entries(o['properties'] as Record<string, Record<string, unknown>>)) {
        if (!required.has(key)) optional += 1;
        if (value['anyOf'] !== undefined || Array.isArray(value['type'])) unions += 1;
      }
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(schema);
  return { unions, optional };
}

describe('AI の答えの形は、構造化出力の上限の中', () => {
  const schemas = { OrganizeAnswerWire, SelectionAnswer, LinkAnswer, ProblemListAnswer, DocumentAnswer, ReviseAnswer, SupportAnswer, PendingAnswer, AskAnswer } as const;
  for (const [name, schema] of Object.entries(schemas)) {
    test(name, () => {
      const c = count(zodOutputFormat(schema).schema);
      expect(c.unions, `${name} の null になりうる欄`).toBeLessThanOrEqual(UNION_MAX);
      expect(c.optional, `${name} の必須でない欄`).toBeLessThanOrEqual(OPTIONAL_MAX);
    });
  }

  // 段K6 の形（結果待ち・記録への質問）は、null になりうる欄・必須でない欄を作らない（引用がなければ ""・記号がなければ []）
  test('結果待ちと記録への質問の形は、どちらも 0', () => {
    for (const schema of [PendingAnswer, AskAnswer]) expect(count(zodOutputFormat(schema).schema)).toEqual({ unions: 0, optional: 0 });
  });
});
