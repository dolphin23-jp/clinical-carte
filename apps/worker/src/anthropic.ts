// Anthropic の API を呼ぶ、ただ1つの場所（CA-012・CA-022）。送るのは、指示（prompt.ts）と、その1回に打った文だけ。
// 答えは、決めた形（構造化した出力）で受け、確かめるのは core の applySelection。ここでは、保存もログもしない。
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { DiscussAnswer, DraftAnswer, LinkAnswer, OrganizeAnswer, ProposalAnswer, SelectionAnswer } from '@clinical-carte/core';

import type { DiscussResult, DrafterResult, LinkerResult, Organizer, OrganizerResult, ProposerResult, ResearchResult } from './organizer.ts';
import { AP_SYSTEM, DISCUSS_SYSTEM, DRAFT_SYSTEM, LINK_SYSTEM, ORGANIZE_SYSTEM, RESEARCH_SYSTEM, SELECT_SYSTEM, WEB_DOMAINS } from './prompt.ts';
import type { WebHit } from './references.ts';
import type { Selector, SelectorResult } from './selector.ts';

/** 始めるモデル（CA-022）。設定（MODEL）で変えられる */
export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model: string;
}

export function createAnthropicSelector(options: AnthropicOptions): Selector {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 2, timeout: 60_000 });
  return {
    async select(text: string): Promise<SelectorResult> {
      try {
        const response = await client.beta.messages.parse({
          model: options.model,
          max_tokens: 16000,
          // 安全の仕組みが、医療の文を誤って断ったとき、同じ依頼を、別のモデルでやり直す（どのモデルにするかは、API に任せる）
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          // 指示は毎回同じなので、キャッシュに載せる
          cache_control: { type: 'ephemeral' },
          system: SELECT_SYSTEM,
          // 場所を指すだけの仕事だが、指し漏れは記録に残る。既定（medium）を、明示して使う
          output_config: { effort: 'medium', format: zodOutputFormat(SelectionAnswer) },
          messages: [{ role: 'user', content: text }],
        });
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = SelectionAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        // 何が起きたかの文は、外に出さない（打った文が混ざりうる）
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
  };
}

/** 整理（段2）。選別と同じ鍵・モデル。答えが長くなりうるので、待つ時間を長めにとる */
export function createAnthropicOrganizer(options: AnthropicOptions): Organizer {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 2, timeout: 180_000 });
  return {
    async organize(text: string): Promise<OrganizerResult> {
      try {
        const response = await client.beta.messages.parse({
          model: options.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: ORGANIZE_SYSTEM,
          output_config: { effort: 'medium', format: zodOutputFormat(OrganizeAnswer) },
          messages: [{ role: 'user', content: text }],
        });
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = OrganizeAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // 問題の筋のつなぎ（段3a）。送るのは、保存した問題の名前と、保存した文の行だけ（core の linkRequest）
    async link(message: string): Promise<LinkerResult> {
      try {
        const response = await client.beta.messages.parse({
          model: options.model,
          max_tokens: 8000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: LINK_SYSTEM,
          output_config: { effort: 'medium', format: zodOutputFormat(LinkAnswer) },
          messages: [{ role: 'user', content: message }],
        });
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = LinkAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // 参照元（段5）：ウェブ検索（Anthropic の側で検索する）。許す先は WEB_DOMAINS。答えから、引用（題・URL・引用の字）だけを取り出す
    async research(message: string): Promise<ResearchResult> {
      try {
        const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: message }];
        const hits: WebHit[] = [];
        // 検索が長いと、途中で止まる（pause_turn）。そのときは続けて送る（3回まで）
        for (let turn = 0; turn < 3; turn += 1) {
          const response = await client.beta.messages.create({
            model: options.model,
            max_tokens: 8000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: RESEARCH_SYSTEM,
            output_config: { effort: 'medium' },
            tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5, allowed_domains: [...WEB_DOMAINS] }], // phi-guard: allow ツールの版の名前（患者の番号ではない）
            messages,
          });
          if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
          for (const block of response.content) {
            if (block.type !== 'text') continue;
            for (const c of block.citations ?? []) {
              if (c.type === 'web_search_result_location') hits.push({ title: c.title ?? c.url, url: c.url, citedText: c.cited_text });
            }
          }
          if (response.stop_reason !== 'pause_turn') break;
          messages.push({ role: 'assistant', content: response.content });
        }
        return { ok: true, hits };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // A/P の案（段5）。送るのは、記録の引用・書籍の抜き出し・ネットの引用だけ（core の proposalMessage）。保存しない
    async propose(message: string): Promise<ProposerResult> {
      try {
        const response = await client.beta.messages.parse({
          model: options.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: AP_SYSTEM,
          output_config: { effort: 'high', format: zodOutputFormat(ProposalAnswer) },
          messages: [{ role: 'user', content: message }],
        });
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = ProposalAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // 議論（段5）。保存しない
    async discuss(message: string): Promise<DiscussResult> {
      try {
        const response = await client.beta.messages.parse({
          model: options.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: DISCUSS_SYSTEM,
          output_config: { effort: 'high', format: zodOutputFormat(DiscussAnswer) },
          messages: [{ role: 'user', content: message }],
        });
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = DiscussAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // 草案（段4）。送るのは、保存した文から切り出した引用だけ（core の courseMaterial）。答えは保存もログもしない
    async draft(message: string): Promise<DrafterResult> {
      try {
        const response = await client.beta.messages.parse({
          model: options.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: DRAFT_SYSTEM,
          output_config: { effort: 'medium', format: zodOutputFormat(DraftAnswer) },
          messages: [{ role: 'user', content: message }],
        });
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = DraftAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
  };
}
