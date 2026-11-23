// Anthropic の API を呼ぶ、ただ1つの場所（CA-012・CA-022）。送るのは、指示（prompt.ts）と、その1回に打った文だけ。
// 答えは、決めた形（構造化した出力）で受け、確かめるのは core の applySelection。ここでは、保存もログもしない。
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AskAnswer, DocumentAnswer, LinkAnswer, OrganizeAnswerWire, organizeFromWire, PendingAnswer, PlanAnswer, ProblemListAnswer, ProposeAnswer, ReviseAnswer, SelectionAnswer, SupportAnswer, TranscribeAnswer } from '@clinical-carte/core';

import type { AskResult, DocumentResult, LinkerResult, Organizer, OrganizerResult, PendingResultAnswer, PlanResultAnswer, ProblemListResult, ProposeResult, ResearchResult, ReviseResult, SupportResult, TranscribeResult } from './organizer.ts';
import { ASK_SYSTEM, DOC_REVISE_SYSTEM, DOC_SYSTEM, LINK_SYSTEM, ORDER_PROPOSE_SYSTEM, ORDER_TRANSCRIBE_SYSTEM, PENDING_SYSTEM, PLAN_SYSTEM, PLIST_SYSTEM, ORGANIZE_PROMPTS, type OrganizePromptChoice, RESEARCH_SYSTEM, SELECT_SYSTEM, SUPPORT_SYSTEM, WEB_DOMAINS } from './prompt.ts';
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

/** 整理の答えの上限（2026-11-23。16000 では長い記載で切れた） */
export const ORGANIZE_MAX_TOKENS = 64000;

/** 整理（段2）。選別と同じ鍵・モデル。答えが長くなりうるので、待つ時間を長めにとる */
export function createAnthropicOrganizer(options: AnthropicOptions): Organizer {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 2, timeout: 180_000 });
  return {
    // 2026-11-23：時刻つきの処置・投薬・値・指示が多い長い記載で、答えが 16000 の上限で切れて整理できなかった。
    // 上限を 64000 に広げ、長い答えでも切れずに受け取れるよう、流して受け取る（stream。待つ時間は 600 秒）
    async organize(text: string, prompt: OrganizePromptChoice = 'current'): Promise<OrganizerResult> {
      try {
        const stream = client.beta.messages.stream(
          {
            model: options.model,
            max_tokens: ORGANIZE_MAX_TOKENS,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: ORGANIZE_PROMPTS[prompt].system,
            output_config: { effort: 'medium', format: zodOutputFormat(OrganizeAnswerWire) },
            messages: [{ role: 'user', content: text }],
          },
          { timeout: 600_000 },
        );
        const response = await stream.finalMessage();
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = OrganizeAnswerWire.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: organizeFromWire(parsed.data) } : { ok: false, reason: 'bad_answer' };
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
    // AI の臨床支援（段K5。CA-064）。送るのは、記録から作った資料と、出典の抜き出しだけ（core の supportMessage）。答えは、確かめてから保存する
    async support(message: string): Promise<SupportResult> {
      try {
        const response = await client.beta.messages.parse(
          {
            model: options.model,
            max_tokens: 32000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: SUPPORT_SYSTEM,
            output_config: { effort: 'high', format: zodOutputFormat(SupportAnswer) },
            messages: [{ role: 'user', content: message }],
          },
          { timeout: 300_000 },
        );
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = SupportAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // 結果待ち（段K6。CA-065）。送るのは、記録から作った提出の候補と事実だけ（core の pendingMaterial）。答えは記号と状態だけで、確かめてから保存する
    async pending(message: string): Promise<PendingResultAnswer> {
      try {
        const response = await client.beta.messages.parse(
          {
            model: options.model,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: PENDING_SYSTEM,
            output_config: { effort: 'medium', format: zodOutputFormat(PendingAnswer) },
            messages: [{ role: 'user', content: message }],
          },
          { timeout: 300_000 },
        );
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = PendingAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // 予定と実施（段K9。CA-071）。送るのは、記録から作った予定の行と事実だけ（core の planMaterial）。答えは記号と種類と手がかりの数だけで、確かめてから保存する
    async plans(message: string): Promise<PlanResultAnswer> {
      try {
        const response = await client.beta.messages.parse(
          {
            model: options.model,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: PLAN_SYSTEM,
            output_config: { effort: 'medium', format: zodOutputFormat(PlanAnswer) },
            messages: [{ role: 'user', content: message }],
          },
          { timeout: 300_000 },
        );
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = PlanAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // 記録への質問（段K6。CA-066）。送るのは、記録から作った資料と、先生の問いだけ（core の askMessage）。問いも答えも、保存もログもしない
    async ask(message: string): Promise<AskResult> {
      try {
        const response = await client.beta.messages.parse(
          {
            model: options.model,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: ASK_SYSTEM,
            output_config: { effort: 'high', format: zodOutputFormat(AskAnswer) },
            messages: [{ role: 'user', content: message }],
          },
          { timeout: 300_000 },
        );
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = AskAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // 指示簿を写す（段K11。CA-074）。送るのは、先生が選んだ記載の保存した字だけ（core の transcribeMessage）。答えは引用と欄だけで、確かめてから案として返す（保存しない）
    async orderTranscribe(message: string): Promise<TranscribeResult> {
      try {
        const response = await client.beta.messages.parse(
          {
            model: options.model,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: ORDER_TRANSCRIBE_SYSTEM,
            output_config: { effort: 'medium', format: zodOutputFormat(TranscribeAnswer) },
            messages: [{ role: 'user', content: message }],
          },
          { timeout: 300_000 },
        );
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = TranscribeAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
    // 指示簿の案（段K11。CA-076）。送るのは、記録から作った資料・確かめた後の臨床支援・テンプレ・いまの指示だけ（core の proposeMessage）。答えは確かめてから案として返す（保存しない）
    async orderPropose(message: string): Promise<ProposeResult> {
      try {
        const response = await client.beta.messages.parse(
          {
            model: options.model,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: ORDER_PROPOSE_SYSTEM,
            output_config: { effort: 'high', format: zodOutputFormat(ProposeAnswer) },
            messages: [{ role: 'user', content: message }],
          },
          { timeout: 300_000 },
        );
        if (response.stop_reason === 'refusal') return { ok: false, reason: 'refused' };
        if (response.stop_reason !== 'end_turn') return { ok: false, reason: 'bad_answer' };
        const parsed = ProposeAnswer.safeParse(response.parsed_output);
        return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, reason: 'bad_answer' };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return { ok: false, reason: 'unavailable' };
        return { ok: false, reason: 'bad_answer' };
      }
    },
  };
}
