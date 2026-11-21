// 段5：A/P の記録の形（残した A/P と、根拠の参照）。カルテ記載（段I）は document.test.ts
import { describe, expect, test } from 'vitest';

import { ApNoteNew } from '../src/index.ts';

describe('A/P を足す形', () => {
  test('参照は場所・題・頁・URL だけ。本文の欄はない', () => {
    const base = { encounterId: '01JD0000000000000000000000', threadId: '01JD0000000000000000000001', day: '2026-11-19', part: 'plan', planKind: 'tx', text: '抗菌薬を継続', origin: 'ai' };
    expect(ApNoteNew.safeParse({ ...base, refs: [{ k: 'web', title: 'G', url: 'https://example.org/' }, { k: 'book', title: '本', page: 'p.12', path: null }] }).success).toBe(true);
    expect(ApNoteNew.safeParse({ ...base, refs: [{ k: 'book', title: '本', page: 'p.12', path: null, text: '本文' }] }).success).toBe(false);
    expect(ApNoteNew.safeParse({ ...base, origin: 'ai_edited', refs: [] }).success).toBe(false);
  });
});
