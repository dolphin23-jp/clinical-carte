// 整理を頼む先（AI）の形。本物は anthropic.ts、試験では、決まった答えを返す代役を渡す。
import type { DocumentAnswer, LinkAnswer, OrganizeAnswer, ProblemListAnswer, ReviseAnswer } from '@clinical-carte/core';

import type { OrganizePromptChoice } from './prompt.ts';
import type { WebHit } from './references.ts';

import type { SelectorFailure } from './selector.ts';

export type OrganizerResult = { readonly ok: true; readonly answer: OrganizeAnswer } | { readonly ok: false; readonly reason: SelectorFailure };
export type ResearchResult = { readonly ok: true; readonly hits: readonly WebHit[] } | { readonly ok: false; readonly reason: SelectorFailure };
export type DocumentResult = { readonly ok: true; readonly answer: DocumentAnswer } | { readonly ok: false; readonly reason: SelectorFailure };
export type ProblemListResult = { readonly ok: true; readonly answer: ProblemListAnswer } | { readonly ok: false; readonly reason: SelectorFailure };
export type ReviseResult = { readonly ok: true; readonly answer: ReviseAnswer } | { readonly ok: false; readonly reason: SelectorFailure };
export type LinkerResult = { readonly ok: true; readonly answer: LinkAnswer } | { readonly ok: false; readonly reason: SelectorFailure };

export interface Organizer {
  /** 文（識別情報を置き換えた後）を整理する：区切り・投薬・できごと・問題・測定値の場所。文は書き換えない。例外を投げず、失敗は結果で返す。
   *  prompt は、整理の評価で前の版と比べるときだけ 'previous'（本番の整理は、いつも 'current'） */
  organize(text: string, prompt?: OrganizePromptChoice): Promise<OrganizerResult>;
  /** 問題の筋のつなぎ（段3a）：問題の名前と記載の行（JSON。core の linkRequest が作る）から、同じ問題を記号で指す。例外を投げない */
  link(message: string): Promise<LinkerResult>;
  /** 参照元（段5。CA-035）：問題の名前などの一般的な語で、ウェブ検索し、引用（題・URL・引用の字）を集める。例外を投げない */
  research(message: string): Promise<ResearchResult>;
  /** カルテ記載（段I。CA-054）：資料（JSON。core の documentMessage が作る）から、見出しごとの文と根拠の記号。保存しない。例外を投げない */
  document(message: string): Promise<DocumentResult>;
  /** カルテ記載を相談して直す（段I）：いまの記載・やりとり・頼みを見て、答えと直した記載。保存しない。例外を投げない */
  revise(message: string): Promise<ReviseResult>;
  /** プロブレムリスト（CA-057）：記録全体の資料（JSON。core の listMaterial が作る）から、#1… のリストと結びつけ。例外を投げない */
  problemList(message: string): Promise<ProblemListResult>;
}
