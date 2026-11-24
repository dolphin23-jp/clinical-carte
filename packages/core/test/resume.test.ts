// 画面を離れて切れた整理を、戻ったときに続ける規則（CA-086）。純関数で、いまの時刻は引数。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { type OrganizeJob, RESUME_ATTEMPTS, RESUME_GRACE_MS, resumeOrganize } from '../src/index.ts';

const NOW = 1_000_000;
const src = (id: string, organized: string | null = null) => ({ id, organized });

describe('切れた整理を続ける（resumeOrganize）', () => {
  test('整理済み・失敗した文は、続けない。画面が知らない、まだ整理されていない文は、続ける', () => {
    const plan = resumeOrganize({ sources: [src('a', 'done'), src('b', 'failed'), src('c')], jobs: new Map(), attempts: new Map(), now: NOW, loadedAt: NOW });
    expect(plan).toEqual({ run: ['c'], waiting: [], resuming: [], recheckAt: null });
  });

  test('答えを待っている文は、何もしない（自動で続けたものは「続けている」）', () => {
    const jobs = new Map<string, OrganizeJob>([
      ['a', { state: 'running', since: NOW - 5_000, auto: false }],
      ['b', { state: 'running', since: NOW - 5_000, auto: true }],
    ]);
    expect(resumeOrganize({ sources: [src('a'), src('b')], jobs, attempts: new Map(), now: NOW, loadedAt: NOW })).toEqual({ run: [], waiting: [], resuming: ['b'], recheckAt: null });
  });

  test('答えを受け取った文は、記録の読み直しが追いつくまで、頼み直さない（二重に頼まない）', () => {
    const jobs = new Map<string, OrganizeJob>([['a', { state: 'finished' }]]);
    expect(resumeOrganize({ sources: [src('a')], jobs, attempts: new Map([['a', 1]]), now: NOW, loadedAt: NOW })).toEqual({ run: [], waiting: [], resuming: [], recheckAt: null });
  });

  test('切れた文は、猶予のあいだは待ち（サーバーが仕上げるかもしれない）、猶予を過ぎたら続ける', () => {
    const jobs = new Map<string, OrganizeJob>([
      ['a', { state: 'lost', at: NOW - 1_000 }],
      ['b', { state: 'lost', at: NOW - 10_000 }],
      ['c', { state: 'lost', at: NOW - RESUME_GRACE_MS }],
    ]);
    const plan = resumeOrganize({ sources: [src('a'), src('b'), src('c')], jobs, attempts: new Map(), now: NOW, loadedAt: NOW });
    expect(plan.waiting).toEqual(['a', 'b']);
    expect(plan.run).toEqual(['c']);
    // 読み直すのは、いちばん早く猶予が明ける時刻
    expect(plan.recheckAt).toBe(NOW - 10_000 + RESUME_GRACE_MS);
    // 切れた文が、待つあいだに整理済みになっていれば、何もしない
    expect(resumeOrganize({ sources: [src('a', 'done')], jobs, attempts: new Map(), now: NOW, loadedAt: NOW })).toEqual({ run: [], waiting: [], resuming: [], recheckAt: null });
  });

  test('猶予が明けても、記録が猶予より前に読んだものなら、頼み直さずに読み直す（読み直しが届く前の古い記録で、二重に頼まない）', () => {
    const jobs = new Map<string, OrganizeJob>([['a', { state: 'lost', at: NOW - RESUME_GRACE_MS - 1_000 }]]);
    const stale = resumeOrganize({ sources: [src('a')], jobs, attempts: new Map(), now: NOW, loadedAt: NOW - RESUME_GRACE_MS - 500 });
    expect(stale).toEqual({ run: [], waiting: ['a'], resuming: [], recheckAt: NOW });
    const fresh = resumeOrganize({ sources: [src('a')], jobs, attempts: new Map(), now: NOW, loadedAt: NOW });
    expect(fresh.run).toEqual(['a']);
  });

  test('自動で続けるのは、文ごとに上限まで（それより後は、先生が「整理する」を押す）', () => {
    const jobs = new Map<string, OrganizeJob>([['a', { state: 'lost', at: NOW - RESUME_GRACE_MS * 2 }]]);
    expect(resumeOrganize({ sources: [src('a')], jobs, attempts: new Map([['a', RESUME_ATTEMPTS - 1]]), now: NOW, loadedAt: NOW }).run).toEqual(['a']);
    expect(resumeOrganize({ sources: [src('a')], jobs, attempts: new Map([['a', RESUME_ATTEMPTS]]), now: NOW, loadedAt: NOW }).run).toEqual([]);
    expect(resumeOrganize({ sources: [src('b')], jobs: new Map(), attempts: new Map([['b', RESUME_ATTEMPTS]]), now: NOW, loadedAt: NOW }).run).toEqual([]);
  });

  test('どんな様子でも：続ける・待つ・続けている文は、まだ整理されていない文だけで、重ならない。待つ文があれば、読み直す時刻は、いまより後', () => {
    const job = fc.oneof(
      fc.constant(undefined),
      fc.record({ state: fc.constant('running' as const), since: fc.nat(NOW), auto: fc.boolean() }),
      fc.record({ state: fc.constant('lost' as const), at: fc.integer({ min: NOW - 3 * RESUME_GRACE_MS, max: NOW }) }),
      fc.constant({ state: 'finished' as const }),
    );
    fc.assert(
      fc.property(fc.array(fc.record({ organized: fc.constantFrom(null, 'done', 'failed'), job, tried: fc.nat(4) }), { maxLength: 12 }), (rows) => {
        const sources = rows.map((r, i) => ({ id: `s${String(i)}`, organized: r.organized }));
        const jobs = new Map<string, OrganizeJob>(rows.flatMap((r, i) => (r.job === undefined ? [] : [[`s${String(i)}`, r.job] as const])));
        const attempts = new Map<string, number>(rows.map((r, i) => [`s${String(i)}`, r.tried] as const));
        const plan = resumeOrganize({ sources, jobs, attempts, now: NOW, loadedAt: NOW });
        const all = [...plan.run, ...plan.waiting, ...plan.resuming];
        expect(new Set(all).size).toBe(all.length);
        for (const id of all) expect(sources.find((x) => x.id === id)?.organized).toBeNull();
        for (const id of plan.run) expect(attempts.get(id) ?? 0).toBeLessThan(RESUME_ATTEMPTS);
        if (plan.waiting.length > 0) expect(plan.recheckAt).toBeGreaterThanOrEqual(NOW);
        else expect(plan.recheckAt).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});
