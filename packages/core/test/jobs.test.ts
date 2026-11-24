// AI の仕事を通信から切り離す（CA-087）・答えを受け取るまで預かる（CA-088）の決まり。純関数。
import { describe, expect, test } from 'vitest';

import { HELD_JOB_KINDS, heldOutcome, JOB_KINDS, jobTargetOf, SHARED_JOB_KINDS } from '../src/index.ts';

const ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';

describe('仕事にできる頼み（jobTargetOf）', () => {
  test('AI を呼ぶ道の POST だけ。相手（文・受診・患者）を決める', () => {
    expect(jobTargetOf('POST', `/api/sources/${ID}/organize`)).toEqual({ kind: 'organize', target: ID, targetType: 'source' });
    expect(jobTargetOf('POST', `/api/patients/${ID}/problem-list`)).toEqual({ kind: 'problem_list', target: ID, targetType: 'patient' });
    expect(jobTargetOf('POST', `/api/patients/${ID}/consult`)).toEqual({ kind: 'consult', target: ID, targetType: 'patient' });
    expect(jobTargetOf('POST', `/api/patients/${ID}/ask`)).toEqual({ kind: 'ask', target: ID, targetType: 'patient' });
    expect(jobTargetOf('POST', `/api/encounters/${ID}/documents/generate`)).toEqual({ kind: 'document', target: ID, targetType: 'encounter' });
    expect(jobTargetOf('POST', `/api/encounters/${ID}/documents/revise`)).toEqual({ kind: 'revise', target: ID, targetType: 'encounter' });
    expect(jobTargetOf('POST', `/api/encounters/${ID}/orders/transcribe`)).toEqual({ kind: 'order_transcribe', target: ID, targetType: 'encounter' });
    expect(jobTargetOf('POST', `/api/encounters/${ID}/orders/propose`)).toEqual({ kind: 'order_propose', target: ID, targetType: 'encounter' });
    for (const kind of ['support', 'pending', 'plans'] as const) expect(jobTargetOf('POST', `/api/patients/${ID}/${kind}`)?.kind).toBe(kind);
  });

  test('読むだけ・直す・保存する・ほかの道は、仕事にしない（保存する頼みは、二重に保存しないよう、いつもの要求のまま）', () => {
    expect(jobTargetOf('GET', `/api/patients/${ID}/consult`)).toBeNull();
    expect(jobTargetOf('PATCH', `/api/patients/${ID}/pending`)).toBeNull();
    expect(jobTargetOf('POST', `/api/encounters/${ID}/documents`)).toBeNull();
    expect(jobTargetOf('POST', `/api/encounters/${ID}/documents/backing`)).toBeNull();
    expect(jobTargetOf('POST', `/api/patients/${ID}/consult-notes`)).toBeNull();
    expect(jobTargetOf('POST', `/api/encounters/${ID}/sources`)).toBeNull();
    expect(jobTargetOf('POST', `/api/encounters/${ID}/orders`)).toBeNull();
    expect(jobTargetOf('POST', `/api/sources/${ID}/organize/x`)).toBeNull();
  });

  test('種類の組：預かる種類と、同じ相手につなぐ種類は、重ならず、合わせて全部', () => {
    expect(HELD_JOB_KINDS.filter((k) => SHARED_JOB_KINDS.includes(k))).toEqual([]);
    expect([...HELD_JOB_KINDS, ...SHARED_JOB_KINDS].sort()).toEqual([...JOB_KINDS].sort());
  });
});

describe('預ける形（heldOutcome）', () => {
  test('保存しない答えの種類は、確かめた後の答えをそのまま。保存する種類は、中身を落とす（結果は記録にある）', () => {
    const answer = { answer: { statements: [{ text: '架空の答え' }] } };
    expect(heldOutcome('consult', { status: 200, body: answer })).toEqual({ status: 200, body: answer });
    expect(heldOutcome('organize', { status: 200, body: { source: { text: '架空の記載' } } })).toEqual({ status: 200, body: {} });
  });

  test('誤りは、どの種類も名前だけ（ほかの欄を預けない）', () => {
    expect(heldOutcome('consult', { status: 429, body: { error: 'ai_limit', left: 0, extra: '字' } })).toEqual({ status: 429, body: { error: 'ai_limit' } });
    expect(heldOutcome('organize', { status: 500, body: null })).toEqual({ status: 500, body: { error: 'server' } });
  });
});
