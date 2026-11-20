// Cloudflare Workers の入口。設定（保存先・合鍵・静的ファイル・AI の鍵）を、handler に渡すだけ。
import { createAnthropicSelector, DEFAULT_MODEL } from './anthropic.ts';
import type { Db } from './db.ts';
import { handle } from './handler.ts';
import { webRuntime } from './runtime.ts';
import { DEFAULT_DAILY_AI_LIMIT } from './usage.ts';

export interface Env {
  /** D1（wrangler.jsonc の d1_databases） */
  readonly DB: Db;
  /** 画面の静的ファイル（wrangler.jsonc の assets） */
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  /** 合鍵（wrangler secret put CARTE_KEY）。ない・短いときは、すべての API を断る */
  readonly CARTE_KEY?: string;
  /** Anthropic の API の鍵（wrangler secret put ANTHROPIC_API_KEY）。ないときは、文を入れられない */
  readonly ANTHROPIC_API_KEY?: string;
  /** モデル（wrangler.jsonc の vars。なければ DEFAULT_MODEL） */
  readonly MODEL?: string;
  /** AI を呼べる回数（1日）。"0" は、上限なし。なければ DEFAULT_DAILY_AI_LIMIT */
  readonly DAILY_AI_LIMIT?: string;
}

/** 上限の設定を読む。数でない・負のときは、既定の値（上限を、設定の間違いで外さない） */
export function dailyLimitOf(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_DAILY_AI_LIMIT;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_AI_LIMIT;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
    return handle(request, {
      db: env.DB,
      key: env.CARTE_KEY,
      runtime: webRuntime,
      secureCookies: true,
      assets: (r) => env.ASSETS.fetch(r),
      selector: apiKey === '' ? null : createAnthropicSelector({ apiKey, model: env.MODEL?.trim() || DEFAULT_MODEL }),
      dailyAiLimit: dailyLimitOf(env.DAILY_AI_LIMIT),
    });
  },
};
