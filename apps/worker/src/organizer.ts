// 整理を頼む先（AI）の形。本物は anthropic.ts、試験では、決まった答えを返す代役を渡す。
import type { LinkAnswer, OrganizeAnswer } from '@clinical-carte/core';

import type { SelectorFailure } from './selector.ts';

export type OrganizerResult = { readonly ok: true; readonly answer: OrganizeAnswer } | { readonly ok: false; readonly reason: SelectorFailure };
export type LinkerResult = { readonly ok: true; readonly answer: LinkAnswer } | { readonly ok: false; readonly reason: SelectorFailure };

export interface Organizer {
  /** 文（識別情報を置き換えた後）を整理する：区切り・投薬・できごと・問題・測定値の場所。文は書き換えない。例外を投げず、失敗は結果で返す */
  organize(text: string): Promise<OrganizerResult>;
  /** 問題の筋のつなぎ（段3a）：問題の名前と記載の行（JSON。core の linkRequest が作る）から、同じ問題を記号で指す。例外を投げない */
  link(message: string): Promise<LinkerResult>;
}
