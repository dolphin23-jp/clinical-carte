// Anthropic の API を呼ぶ、ただ1つの場所（CA-012・CA-022）。送るのは、指示（prompt.ts）と、その1回に打った文だけ。
// 答えは、決めた形（構造化した出力）で受け、確かめるのは core の applySelection。ここでは、保存もログもしない。
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { DocumentAnswer, LinkAnswer, OrganizeAnswerWire, ProblemListAnswer, ReviseAnswer, SelectionAnswer } from '@clinical-carte/core';

import type { DocumentResult, LinkerResult, Organizer, OrganizerResult, ProblemListResult, ResearchResult, ReviseResult } from './organizer.ts';
import { DOC_REVISE_SYSTEM, DOC_SYSTEM, LINK_SYSTEM, PLIST_SYSTEM, ORGANIZE_PROMPTS, type OrganizePromptChoice, RESEARCH_SYSTEM, SELECT_SYSTEM, WEB_DOMAINS } from './prompt.ts';
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
    async organize(text: string, prompt: OrganizePromptChoice = 'current'): Promise<OrganizerResult> {
      try {
        const response = await client.beta.messages.parse({
          model: options.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: ORGANIZE_PROMPTS[prompt].system,
          output_config: { effort: 'medium', format: zodOutputFormat(OrganizeAnswerWire) },
          messages: [{ role: 'user', content: text }],
        });
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = OrganizeAnswerWire.safeParse(response.parsed_output);
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
    // カルテ記載（段I）。送るのは、保存した文（識別情報を置き換えた後）と整理した事実と、出典の抜き出しだけ（core の documentMessage）。
    // 答えは保存もログもしない。出来上がった記載を書くので、考える量を多めにとる
    async document(message: string): Promise<DocumentResult> {
      try {
        const response = await client.beta.messages.parse({
          model: options.model,
          max_tokens: 32000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: DOC_SYSTEM,
          output_config: { effort: 'high', format: zodOutputFormat(DocumentAnswer) },
          messages: [{ role: 'user', content: message }],
        },
        // 出来上がった記載を書くので、待つ時間を長めにとる
        { timeout: 300_000 },
        );
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = DocumentAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // カルテ記載を相談して直す（段I）。やりとりは保存しない
    async revise(message: string): Promise<ReviseResult> {
      try {
        const response = await client.beta.messages.parse({
          model: options.model,
          max_tokens: 32000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: DOC_REVISE_SYSTEM,
          output_config: { effort: 'high', format: zodOutputFormat(ReviseAnswer) },
          messages: [{ role: 'user', content: message }],
        },
        // 出来上がった記載を書くので、待つ時間を長めにとる
        { timeout: 300_000 },
        );
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = ReviseAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // プロブレムリスト（CA-057）。送るのは、記録から作った資料だけ（core の listMaterial）。答えは、確かめてから保存する
    async problemList(message: string): Promise<ProblemListResult> {
      try {
        const response = await client.beta.messages.parse(
          {
            model: options.model,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: PLIST_SYSTEM,
            output_config: { effort: 'high', format: zodOutputFormat(ProblemListAnswer) },
            messages: [{ role: 'user', content: message }],
          },
          { timeout: 300_000 },
        );
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = ProblemListAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
  };
}
