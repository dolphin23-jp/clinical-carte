// 電波のないときの入力（段K9。CA-058 の B4・CA-072。CD-006 の答え）：送れなかった文の「送り待ち」。
// - **画面のメモリだけ**（このモジュールの変数）。端末の保存先（localStorage・sessionStorage・IndexedDB・Cookie・Cache Storage・Service Worker）は使わない。
//   読み込み直す・閉じると、送り待ちの文は消える（画面にそう出す。閉じる・読み込み直すときは、ブラウザの決まりの確かめ〔beforeunload〕を出す）
// - 保存するのは、サーバーが、いつもの取り込み（AI の選別 → 置き換え → 形の検査）を通して受け付けた文だけ。送り待ちのあいだ、何も保存されていない
// - つながらない（network：fetch が失敗した・答えが読めない・待つ時間の上限を過ぎた）ときだけ、待ちに戻して送り直す。
//   送り直すのは、電波が戻ったとき（online）と、送り待ちがあるあいだ 30 秒ごと（1つずつ。忙しく回さない）と、「いま送る」を押したとき
// - サーバーが断った（形・選別の失敗・上限など）ときは、もう送らない。いつもの誤りの文を出し、先生が欄に戻して直すか、取り消す
// - 送る鍵（ULID）を、送るボタンを押したときに作り、送り直しでも同じ鍵を送る：答えが戻らずに送り直しても、サーバーは二重に保存しない
// 並びの規則（順・二重にしない・断られたら止める）は core の outbox.ts（純関数）。通信は net/api.ts だけ。
import { enqueue, markSending, type NewSource, nextToSend, type OutboxItem, removeQueued, settle, shouldRetry, ulid, ULID_RANDOM_BYTES } from '@clinical-carte/core';
import { useSyncExternalStore } from 'react';

import { onReturn } from './lifecycle.ts';
import { addSource } from './net/api.ts';
import { runOrganize } from './organizing.ts';

/** 送り直す間隔（ミリ秒）。送り待ちがあるあいだだけ */
export const RETRY_INTERVAL_MS = 30_000;

export interface QueuedSource {
  readonly encounterId: string;
  /** 送る文（送る鍵つき）。画面のメモリだけ */
  readonly input: NewSource & { readonly sendKey: string };
}

export interface OutboxSnapshot {
  readonly items: readonly OutboxItem<QueuedSource>[];
  /** 送り待ちから保存できた数（受診ごと。記録を読み直す印。画面を開いているあいだだけ） */
  readonly delivered: Readonly<Record<string, number>>;
  /** 送れた・整理が済んだたびに増える数（患者の画面が、記録を読み直す） */
  readonly version: number;
}

let snapshot: OutboxSnapshot = { items: [], delivered: {}, version: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let stopReturn: (() => void) | null = null;
let pumping = false;

function onOnline(): void {
  kick();
}
/** 送り待ちがあるときは、閉じる・読み込み直す前に、ブラウザの決まりの確かめを出す（画面の外への知らせではない） */
function onBeforeUnload(event: BeforeUnloadEvent): void {
  // ブラウザによっては出さない（電話の Safari など）。そのため、送り待ちが消えることは、いつも画面の帯と札に書く
  event.preventDefault();
}

/** 送り待ちがあるあいだだけ、online・30 秒ごと・閉じる前の確かめを見張る（なくなったら外す） */
function watch(): void {
  const any = snapshot.items.length > 0;
  if (any && timer === null) {
    timer = setInterval(kick, RETRY_INTERVAL_MS);
    window.addEventListener('online', onOnline);
    window.addEventListener('beforeunload', onBeforeUnload);
    // 画面に戻ったときも、すぐ送り直す（CA-086。ほかのアプリから戻っても online は起きないことがある）
    stopReturn = onReturn(kick);
  } else if (!any && timer !== null) {
    clearInterval(timer);
    timer = null;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('beforeunload', onBeforeUnload);
    stopReturn?.();
    stopReturn = null;
  }
}

function set(next: Partial<OutboxSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  watch();
  for (const l of listeners) l();
}

/** 送る鍵を作る（ULID。患者の情報ではない） */
export function newSendKey(): string {
  return ulid(Date.now(), crypto.getRandomValues(new Uint8Array(ULID_RANDOM_BYTES)));
}

/** この受診に、送り待ち（断られたものを含む）があるか */
export const hasQueued = (encounterId: string): boolean => snapshot.items.some((q) => q.group === encounterId);

/** 送り待ちに入れる（同じ鍵は二重にしない） */
export function queueSource(item: QueuedSource): void {
  set({ items: enqueue(snapshot.items, { id: item.input.sendKey, group: item.encounterId, payload: item }) });
}

/** 取り消す（送っている最中のものは外さない）。外した文は、どこにも残らない */
export function cancelQueued(id: string): void {
  set({ items: removeQueued(snapshot.items, id) });
}

/** 欄に戻す：並びから外して、その文を返す（断られた文を直して送り直すため） */
export function takeBack(id: string): QueuedSource | null {
  const item = snapshot.items.find((q) => q.id === id && q.state !== 'sending');
  if (item === undefined) return null;
  set({ items: removeQueued(snapshot.items, id) });
  return item.payload;
}

/** 送れるものを、1つずつ送る（つながらなければ、そこで止めて、次のきっかけを待つ） */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = nextToSend(snapshot.items);
      if (next === null) return;
      set({ items: markSending(snapshot.items, next.id) });
      const result = await addSource(next.payload.encounterId, next.payload.input);
      if (result.ok) {
        const group = next.group;
        set({ items: settle(snapshot.items, next.id, { kind: 'sent' }), delivered: { ...snapshot.delivered, [group]: (snapshot.delivered[group] ?? 0) + 1 }, version: snapshot.version + 1 });
        // いつもと同じく、続けて整理する（整理に失敗しても、文は保存されている。記録の「整理する」で、あとから押せる）
        const sourceId = result.value.source.id;
        void runOrganize(sourceId).then(() => {
          set({ version: snapshot.version + 1 });
        });
        continue;
      }
      set({ items: settle(snapshot.items, next.id, { kind: 'failed', error: result.error }) });
      if (shouldRetry(result.error)) return;
    }
  } finally {
    pumping = false;
  }
}

/** いま送る（「いま送る」・online・30 秒ごと） */
export function kick(): void {
  void pump();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 送り待ちの並び（画面の部品が読む） */
export function useOutbox(): OutboxSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
