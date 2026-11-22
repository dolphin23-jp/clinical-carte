// 段K9：電波のないときの入力（CA-058 の B4。CA-072。CD-006 の答え）。送れなかった文の「送り待ち」の並びを、決まった規則で動かす純関数。
// - 並びは、画面のメモリにだけ置く（呼ぶ側が持つ。端末の保存先には置かない。読み込み直す・閉じると消える）
// - 同じ鍵（送る鍵。サーバーが同じ文を二重に保存しないための印）の項目は、1つだけ
// - 送るのは1つずつ（送っている項目があるあいだは、次を出さない）。同じ受診の中は、入れた順（前の項目が残っているあいだは、後ろを送らない）
// - つながらない（network）ときだけ、待ちに戻して、あとでもう一度送る。サーバーが断った（形・選別の失敗など）ときは、もう送らずに、断られた印と誤りの名前を残す
// 時計・タイマーは持たない（いつ送るかは呼ぶ側が決める）。

/** もう一度送ってよい誤り：つながらない・答えが読めない（サーバーまで届かなかったか、届いても答えが戻らなかった） */
export const OUTBOX_RETRY_ERRORS: readonly string[] = ['network'];
export const shouldRetry = (error: string): boolean => OUTBOX_RETRY_ERRORS.includes(error);

export const OUTBOX_STATES = ['waiting', 'sending', 'rejected'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export interface OutboxItem<T> {
  /** 送る鍵（同じ鍵は1つだけ。サーバーにも送り、二重に保存しない） */
  readonly id: string;
  /** 順を守る単位（受診の id） */
  readonly group: string;
  readonly payload: T;
  readonly state: OutboxState;
  /** つながらずに送れなかった回数 */
  readonly tries: number;
  /** サーバーが断ったときの誤りの名前（ほかは null） */
  readonly error: string | null;
}

export type OutboxOutcome = { readonly kind: 'sent' } | { readonly kind: 'failed'; readonly error: string };

/** 並びの後ろに足す。同じ鍵があれば、何もしない（二重にしない） */
export function enqueue<T>(queue: readonly OutboxItem<T>[], item: { readonly id: string; readonly group: string; readonly payload: T }): OutboxItem<T>[] {
  if (queue.some((q) => q.id === item.id)) return [...queue];
  return [...queue, { id: item.id, group: item.group, payload: item.payload, state: 'waiting', tries: 0, error: null }];
}

/** 同じ受診で、この項目より前にある項目（あれば、それが済むまで、この項目は送らない） */
export function blockedBy<T>(queue: readonly OutboxItem<T>[], id: string): OutboxItem<T> | null {
  const i = queue.findIndex((q) => q.id === id);
  const item = queue[i];
  if (item === undefined) return null;
  return queue.slice(0, i).find((q) => q.group === item.group) ?? null;
}

/** 次に送る項目：送っている項目がなければ、待ちの項目のうち、同じ受診の先頭のもの（前に断られた項目が残っていれば、その受診は止まる） */
export function nextToSend<T>(queue: readonly OutboxItem<T>[]): OutboxItem<T> | null {
  if (queue.some((q) => q.state === 'sending')) return null;
  return queue.find((q) => q.state === 'waiting' && blockedBy(queue, q.id) === null) ?? null;
}

/** 送り始めた印（待ちの項目だけ） */
export function markSending<T>(queue: readonly OutboxItem<T>[], id: string): OutboxItem<T>[] {
  return queue.map((q) => (q.id === id && q.state === 'waiting' ? { ...q, state: 'sending' } : q));
}

/** 送った結果を当てる：送れた → 並びから外す。つながらない → 待ちに戻す（回数を足す）。サーバーが断った → 断られた印（もう送らない） */
export function settle<T>(queue: readonly OutboxItem<T>[], id: string, outcome: OutboxOutcome): OutboxItem<T>[] {
  const item = queue.find((q) => q.id === id);
  if (item?.state !== 'sending') return [...queue];
  if (outcome.kind === 'sent') return queue.filter((q) => q.id !== id);
  if (shouldRetry(outcome.error)) return queue.map((q) => (q.id === id ? { ...q, state: 'waiting', tries: q.tries + 1, error: null } : q));
  return queue.map((q) => (q.id === id ? { ...q, state: 'rejected', error: outcome.error } : q));
}

/** 取り消す・欄に戻す（送っている最中の項目は、外さない：サーバーが受け付けたかもしれないので、答えを待つ） */
export function removeQueued<T>(queue: readonly OutboxItem<T>[], id: string): OutboxItem<T>[] {
  return queue.filter((q) => q.id !== id || q.state === 'sending');
}

/** 送り待ち（断られたものを含む）の数 */
export function queuedCount<T>(queue: readonly OutboxItem<T>[], group?: string): number {
  return queue.filter((q) => group === undefined || q.group === group).length;
}
