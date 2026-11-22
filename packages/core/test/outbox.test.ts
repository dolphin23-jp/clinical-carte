// 送り待ちの並び（段K9。CA-072）：順を守る・つながらないときだけ待ちに戻す・サーバーが断ったら止める・二重にしない。
// 文はすべて架空（synthetic）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { blockedBy, enqueue, markSending, nextToSend, type OutboxItem, queuedCount, removeQueued, settle, shouldRetry } from '../src/index.ts';

type Q = OutboxItem<string>[];
const add = (q: Q, id: string, group: string): Q => enqueue(q, { id, group, payload: `架空の文 ${id}` });

describe('送り待ちの並び', () => {
  test('同じ受診の中は、入れた順に1つずつ。送っているあいだは、次を出さない', () => {
    let q: Q = [];
    q = add(q, 'a1', 'enc-a');
    q = add(q, 'a2', 'enc-a');
    q = add(q, 'b1', 'enc-b');
    expect(nextToSend(q)?.id).toBe('a1');
    q = markSending(q, 'a1');
    expect(nextToSend(q)).toBeNull();
    // つながらない → 待ちに戻る（回数を足す）。順は変わらない
    q = settle(q, 'a1', { kind: 'failed', error: 'network' });
    expect(q.map((x) => [x.id, x.state, x.tries])).toEqual([
      ['a1', 'waiting', 1],
      ['a2', 'waiting', 0],
      ['b1', 'waiting', 0],
    ]);
    expect(nextToSend(q)?.id).toBe('a1');
    q = settle(markSending(q, 'a1'), 'a1', { kind: 'sent' });
    expect(nextToSend(q)?.id).toBe('a2');
    expect(queuedCount(q)).toBe(2);
    expect(queuedCount(q, 'enc-b')).toBe(1);
  });

  test('サーバーが断ったら、もう送らない（断られた印と誤りの名前）。同じ受診の後ろは、前を取り消す・欄に戻すまで待つ。ほかの受診は送る', () => {
    let q: Q = add(add(add([], 'a1', 'enc-a'), 'a2', 'enc-a'), 'b1', 'enc-b');
    q = settle(markSending(q, 'a1'), 'a1', { kind: 'failed', error: 'selection_failed' });
    expect(q[0]).toMatchObject({ state: 'rejected', error: 'selection_failed' });
    expect(blockedBy(q, 'a2')?.id).toBe('a1');
    expect(nextToSend(q)?.id).toBe('b1');
    q = settle(markSending(q, 'b1'), 'b1', { kind: 'sent' });
    expect(nextToSend(q)).toBeNull();
    q = removeQueued(q, 'a1');
    expect(nextToSend(q)?.id).toBe('a2');
    expect(shouldRetry('network')).toBe(true);
    for (const e of ['selection_failed', 'shape', 'bad_request', 'server', 'ai_unavailable', 'ai_limit', 'unregistered']) expect(shouldRetry(e), e).toBe(false);
  });

  test('二重にしない：同じ鍵は足さない。送っている項目は取り消さない。送っていない項目の結果は当てない', () => {
    let q: Q = add(add([], 'a1', 'enc-a'), 'a1', 'enc-a');
    expect(q).toHaveLength(1);
    q = markSending(q, 'a1');
    expect(removeQueued(q, 'a1')).toHaveLength(1);
    expect(add(q, 'a1', 'enc-a')).toHaveLength(1);
    const waiting = add([], 'x', 'enc-x');
    expect(settle(waiting, 'x', { kind: 'sent' })).toEqual(waiting);
    expect(settle(q, 'nope', { kind: 'sent' })).toEqual(q);
  });

  test('性質：どんな順の操作でも、鍵は重ならず、送っているのは多くて1つ、同じ受診の待ちは入れた順', () => {
    const op = fc.oneof(
      fc.record({ t: fc.constant('add' as const), id: fc.integer({ min: 0, max: 6 }), g: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ t: fc.constant('send' as const) }),
      fc.record({ t: fc.constant('settle' as const), r: fc.constantFrom('sent', 'network', 'shape') }),
      fc.record({ t: fc.constant('remove' as const), id: fc.integer({ min: 0, max: 6 }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        let q: Q = [];
        const order: string[] = [];
        for (const o of ops) {
          if (o.t === 'add') {
            const id = `k${String(o.id)}`;
            if (!q.some((x) => x.id === id)) order.push(id);
            q = add(q, id, `g${String(o.g)}`);
          } else if (o.t === 'send') {
            const next = nextToSend(q);
            if (next !== null) q = markSending(q, next.id);
          } else if (o.t === 'settle') {
            const s = q.find((x) => x.state === 'sending');
            if (s !== undefined) q = settle(q, s.id, o.r === 'sent' ? { kind: 'sent' } : { kind: 'failed', error: o.r });
          } else q = removeQueued(q, `k${String(o.id)}`);
          expect(new Set(q.map((x) => x.id)).size).toBe(q.length);
          expect(q.filter((x) => x.state === 'sending').length).toBeLessThanOrEqual(1);
          const ids = q.map((x) => x.id);
          expect([...ids].sort((a, b) => order.lastIndexOf(a) - order.lastIndexOf(b))).toEqual(ids);
        }
      }),
    );
  });
});
