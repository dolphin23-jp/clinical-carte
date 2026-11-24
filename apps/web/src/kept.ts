// 患者・受診ごとの、画面のメモリ（CA-086）。端末の保存先は使わない：読み込み直す・閉じると消える。
// 部品の useState の代わりに使うと、部品を閉じても（患者の一覧へ戻る・ほかの患者を開く）値が残り、
// 待っている AI の答え（相談・記載を出す など）が届いたときも、ここに入る（部品を開き直すと、そのまま見える）。
import { useCallback, useSyncExternalStore } from 'react';

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string): void {
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

function subscribe(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
  };
}

export type KeptSetter<T> = (next: T | ((prev: T) => T)) => void;

/** 鍵ごとに、メモリに残る値（初めて読むときに initial を入れる）。setter は、部品を閉じていても書ける */
export function useKept<T>(key: string, initial: T | (() => T)): [T, KeptSetter<T>] {
  if (!values.has(key)) values.set(key, typeof initial === 'function' ? (initial as () => T)() : initial);
  const value = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    () => values.get(key) as T,
  );
  const set = useCallback<KeptSetter<T>>(
    (next) => {
      const prev = values.get(key) as T;
      values.set(key, typeof next === 'function' ? (next as (p: T) => T)(prev) : next);
      notify(key);
    },
    [key],
  );
  return [value, set];
}
