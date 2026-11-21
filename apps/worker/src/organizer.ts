// 整理を頼む先（AI）の形。本物は anthropic.ts、試験では、決まった答えを返す代役を渡す。
import type { DiscussAnswer, DraftAnswer, LinkAnswer, OrganizeAnswer, ProposalAnswer } from '@clinical-carte/core';

import type { OrganizePromptChoice } from './prompt.ts';
import type { WebHit } from './references.ts';

import type { SelectorFailure } from './selector.ts';

export type OrganizerResult = { readonly ok: true; readonly answer: OrganizeAnswer } | { readonly ok: false; readonly reason: SelectorFailure };
export type DrafterResult = { readonly ok: true; readonly answer: DraftAnswer } | { readonly ok: false; readonly reason: SelectorFailure };
export type ResearchResult = { readonly ok: true; readonly hits: readonly WebHit[] } | { readonly ok: false; readonly reason: SelectorFailure };
export type ProposerResult = { readonly ok: true; readonly answer: ProposalAnswer } | { readonly ok: false; readonly reason: SelectorFailure };
export type DiscussResult = { readonly ok: true; readonly answer: DiscussAnswer } | { readonly ok: false; readonly reason: SelectorFailure };
export type LinkerResult = { readonly ok: true; readonly answer: LinkAnswer } | { readonly ok: false; readonly reason: SelectorFailure };

export interface Organizer {
  /** 文（識別情報を置き換えた後）を整理する：区切り・投薬・できごと・問題・測定値の場所。文は書き換えない。例外を投げず、失敗は結果で返す。
   *  prompt は、整理の評価で前の版と比べるときだけ 'previous'（本番の整理は、いつも 'current'） */
  organize(text: string, prompt?: OrganizePromptChoice): Promise<OrganizerResult>;
  /** 問題の筋のつなぎ（段3a）：問題の名前と記載の行（JSON。core の linkRequest が作る）から、同じ問題を記号で指す。例外を投げない */
  link(message: string): Promise<LinkerResult>;
  /** 草案（段4）：記号つきの引用（JSON。core の courseMaterial が作る）から、問題ごとの文と根拠の記号。例外を投げない */
  draft(message: string): Promise<DrafterResult>;
  /** 参照元（段5。CA-035）：問題の名前などの一般的な語で、ウェブ検索し、引用（題・URL・引用の字）を集める。例外を投げない */
  research(message: string): Promise<ResearchResult>;
  /** A/P の案（段5。CA-030）：出典（記号つき）から、問題ごとの評価と方針の文と根拠の記号。例外を投げない */
  propose(message: string): Promise<ProposerResult>;
  /** 議論（段5。CA-032）：問題1つについて、出典とやりとりを見て答える。保存しない。例外を投げない */
  discuss(message: string): Promise<DiscussResult>;
}
