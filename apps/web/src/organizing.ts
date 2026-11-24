// 整理の頼みの様子（CA-086）。画面のメモリだけ。整理を頼むところ（入れる欄・続きを足す・打ち直し・記録の「整理する」・送り待ち）は、みな runOrganize を通す。
// - 頼んで答えを待っている（running）か、つながりが切れて答えを受け取れなかった（lost）かを、文ごとに持つ
// - 患者の画面は useResumeOrganize で、戻ったときに記録を読み直し、切れた整理を続ける（規則は core の resumeOrganize：
//   サーバーが仕上げるかもしれない猶予のあいだは待ち、それでも整理されていなければ、自動で頼み直す。文ごとに回数の上限まで）
import { type OrganizeJob, RESUME_ATTEMPTS, RESUME_GRACE_MS, resumeOrganize } from '@clinical-carte/core';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { useReturn } from './lifecycle.ts';
import { organizeSource, type Result, type Source } from './net/api.ts';

const jobs = new Map<string, OrganizeJob>();
const attempts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** 整理を頼む（auto は、切れた整理を、画面が自動で続けるとき：回数を数える） */
export async function runOrganize(sourceId: string, options: { readonly auto?: boolean } = {}): Promise<Result<Source>> {
  const auto = options.auto === true;
  if (auto) attempts.set(sourceId, (attempts.get(sourceId) ?? 0) + 1);
  jobs.set(sourceId, { state: 'running', since: Date.now(), auto });
  changed();
  const result = await organizeSource(sourceId);
  // つながりが切れた：サーバーは、切れたあとも少し続けている。戻ったら、記録を読み直して確かめる。
  // 答えを受け取った：記録の読み直しが追いつくまで、頼み直さない（読み直す前に、まだ整理されていない文に見えても、二重に頼まない）
  jobs.set(sourceId, !result.ok && result.error === 'network' ? { state: 'lost', at: Date.now() } : { state: 'finished' });
  changed();
  return result;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ResumeView {
  /** サーバーが仕上げるのを待っている文の数 */
  readonly waiting: number;
  /** 自動で続けている文の数 */
  readonly resuming: number;
  /** 自動で続けても整理できなかった文の数（先生が「整理する」を押す） */
  readonly gaveUp: number;
}

/**
 * 患者の画面：戻ったとき（見えるようになった・つながった）に記録を読み直し、切れた整理を続ける。
 * 待つあいだは、猶予が明ける時刻に読み直す。画面が見えていないあいだは、何もしない（戻ってから）
 */
export function useResumeOrganize(sources: readonly { readonly id: string; readonly organized: string | null }[], reload: () => void): ResumeView {
  const v = useSyncExternalStore(subscribe, () => version);
  useReturn(reload);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const plan = resumeOrganize({ sources, jobs, attempts, now: Date.now() });
  const runKey = plan.run.join(',');
  const recheckAt = plan.recheckAt;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  useEffect(() => {
    if (runKey === '' || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    // 頼む直前に、もう一度決める（同じ文を、二重に頼まない）
    for (const id of resumeOrganize({ sources: sourcesRef.current, jobs, attempts, now: Date.now() }).run) {
      void runOrganize(id, { auto: true }).then(() => {
        reloadRef.current();
      });
    }
  }, [runKey, v]);
  useEffect(() => {
    if (recheckAt === null) return;
    const timer = setTimeout(
      () => {
        reloadRef.current();
      },
      Math.max(0, recheckAt - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [recheckAt]);
  // 自動で続けても整理できなかった文（切れたままか、答えを受け取っても整理されていない）
  const gaveUp = sources.filter((s) => {
    const job = jobs.get(s.id);
    return s.organized === null && (attempts.get(s.id) ?? 0) >= RESUME_ATTEMPTS && job?.state !== 'running' && !(job?.state === 'lost' && Date.now() < job.at + RESUME_GRACE_MS);
  }).length;
  return { waiting: plan.waiting.length, resuming: plan.resuming.length, gaveUp };
}
