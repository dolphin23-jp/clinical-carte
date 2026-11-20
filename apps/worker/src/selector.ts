// 選別を頼む先（AI）の形。本物は anthropic.ts、試験では、決まった答えを返す代役を渡す。
import type { SelectionAnswer } from '@clinical-carte/core';

export type SelectorFailure =
  /** AI が答えるのを断った */
  | 'refused'
  /** つながらない・混んでいる・鍵が違う など */
  | 'unavailable'
  /** 答えが、決めた形でない・途中で切れた */
  | 'bad_answer';

export type SelectorResult = { readonly ok: true; readonly answer: SelectionAnswer } | { readonly ok: false; readonly reason: SelectorFailure };

export interface Selector {
  /** 文の中の、識別情報の場所を返す。文は書き換えない。例外を投げず、失敗は結果で返す */
  select(text: string): Promise<SelectorResult>;
}
