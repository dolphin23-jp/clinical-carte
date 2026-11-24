// 画面を離れて戻ったときに、続きをする（CA-086）。画面のメモリだけ（端末の保存先は使わない）。
// - iPhone でほかのアプリへ移る・画面を消すと、Safari が止まり、AI を待っている通信が切れる（つながらない誤り network になる）。
//   戻ったとき（visibilitychange で見える・pageshow で戻った・online）に、見張っている部品へ知らせる
// - 保存しない答え（相談・記載を出す・記録に聞く・指示簿の写しと案）は、切れたら受け取れない（サーバーにも残さない決まり）。
//   離れているあいだに切れたものは、戻ったときに、同じ頼みを1回だけ自動で送り直す（resendAfterReturn）
// - 保存する仕事（整理・プロブレムリストなど）は、サーバーが切れたあとも 30 秒まで続ける。戻ったら記録を読み直し、まだなら続ける（organizing.ts・afterReturn）
import { useEffect, useRef } from 'react';

import type { Result } from './net/api.ts';

const listeners = new Set<() => void>();
/** いちばん最近、画面が見えなくなった時刻（ミリ秒）。見えなくなったことがなければ -Infinity */
let lastHidden = Number.NEGATIVE_INFINITY;

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function fire(): void {
  for (const listener of [...listeners]) listener();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (hidden()) lastHidden = Date.now();
    else fire();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) fire();
  });
  window.addEventListener('online', fire);
}

/** 戻ったときに呼ぶ（見えるようになった・戻った・つながった）。外すときは、返した関数を呼ぶ */
export function onReturn(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 部品が開いているあいだ、戻ったときに呼ぶ */
export function useReturn(listener: () => void): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(
    () =>
      onReturn(() => {
        latest.current();
      }),
    [],
  );
}

/** その時刻のあとに、画面を離れたか（いま離れているかを含む） */
export function wasAwaySince(since: number): boolean {
  return hidden() || lastHidden >= since;
}

/** 画面が見えるようになるまで待つ（見えていれば、すぐ） */
export function whenBack(): Promise<void> {
  if (!hidden()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = onReturn(() => {
      if (hidden()) return;
      off();
      resolve();
    });
  });
}

/** 戻ってから、少し待って呼ぶ（サーバーが、切れたあとに続けている仕事を仕上げる猶予） */
export function afterReturn(call: () => void, waitMs: number): void {
  void whenBack().then(() => {
    setTimeout(call, waitMs);
  });
}

/**
 * 保存しない答えの頼み（相談・記載を出す・記録に聞く・指示簿の写しと案）：離れているあいだに切れたら、戻ってから1回だけ、同じ頼みを送り直す。
 * onAway は、送り直すと決めたときに呼ぶ（画面に「戻ったら、もう一度送ります」と出す）。送り直しは、AI の 1 日の上限に数える
 */
export async function resendAfterReturn<T>(call: () => Promise<Result<T>>, onAway?: () => void): Promise<Result<T>> {
  const started = Date.now();
  const first = await call();
  if (first.ok || first.error !== 'network' || !wasAwaySince(started)) return first;
  onAway?.();
  await whenBack();
  return call();
}
