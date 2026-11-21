// 整理を頼む先（AI）の形。本物は anthropic.ts、試験では、決まった答えを返す代役を渡す。
import type { OrganizeAnswer } from '@clinical-carte/core';

import type { SelectorFailure } from './selector.ts';

export type OrganizerResult = { readonly ok: true; readonly answer: OrganizeAnswer } | { readonly ok: false; readonly reason: SelectorFailure };

export interface Organizer {
  /** 文（識別情報を置き換えた後）を整理する：区切り・投薬・できごと・問題・測定値の場所。文は書き換えない。例外を投げず、失敗は結果で返す */
  organize(text: string): Promise<OrganizerResult>;
}
