// Anthropic の API を呼ぶ、ただ1つの場所（CA-012・CA-022）。送るのは、指示（prompt.ts）と、その1回に打った文だけ。
// 答えは、決めた形（構造化した出力）で受け、確かめるのは core の applySelection。ここでは、保存もログもしない。
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LinkAnswer, OrganizeAnswer, SelectionAnswer } from '@clinical-carte/core';

import type { LinkerResult, Organizer, OrganizerResult } from './organizer.ts';
import { LINK_SYSTEM, ORGANIZE_SYSTEM, SELECT_SYSTEM } from './prompt.ts';
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
  };
}
