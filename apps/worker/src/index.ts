// Cloudflare Workers の入口。設定（保存先・合鍵・静的ファイル・AI の鍵）を、handler に渡すだけ。
import { createAnthropicOrganizer, createAnthropicSelector, DEFAULT_MODEL } from './anthropic.ts';
import type { Db } from './db.ts';
import { handle } from './handler.ts';
import { durableRunner, type JobNamespace } from './jobs.ts';
import { type BookSearcher, createRagSearcher } from './references.ts';
import { webRuntime } from './runtime.ts';
import type { RecordDeps } from './routes.ts';
import { schemaGate } from './schema.ts';
import { DEFAULT_DAILY_AI_LIMIT } from './usage.ts';

export interface Env {
  /** D1（wrangler.jsonc の d1_databases） */
  readonly DB: Db;
  /** 画面の静的ファイル（wrangler.jsonc の assets） */
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  /** 合鍵（wrangler secret put CARTE_KEY）。ない・短いときは、すべての API を断る */
  readonly CARTE_KEY?: string;
  /** Anthropic の API の鍵（Cloudflare の画面の Secret）。ないときは、文を入れられない。名前は ANTHROPIC_API_KEY か CARTE_api_key（anthropicKeyOf） */
  readonly ANTHROPIC_API_KEY?: string;
  /** 同じ鍵の、もう1つの名前（本番で、この名前で置いた。2026-11-21） */
  readonly CARTE_api_key?: string;
  /** モデル（wrangler.jsonc の vars。なければ DEFAULT_MODEL） */
  readonly MODEL?: string;
  /** AI を呼べる回数（1日）。"0" は、上限なし。なければ DEFAULT_DAILY_AI_LIMIT */
  readonly DAILY_AI_LIMIT?: string;
  /** 本人の clinical-RAG（段5。wrangler.jsonc の services のサービスバインディング。Worker の名前 medbook-rag）。clinical-modules と同じ呼び方 */
  readonly RAG?: { fetch(request: Request): Promise<Response> };
  /** clinical-RAG の書籍の検索だけを開ける carte 専用の鍵（Cloudflare の画面の Secret。RAG の CARTE_SEARCH_TOKEN と同じ値。docs/05 の作業 7b）。なければ、書籍を参照元にしない */
  readonly RAG_TOKEN?: string;
  /** AI の仕事を、通信から切り離して動かす係（段N2。CA-087。wrangler.jsonc の durable_objects。entry.ts の CarteJobs）。なければ、要求の中で動かす */
  readonly JOBS?: JobNamespace;
}

/** 書籍の検索を作る。バインディングかトークンがないときは null（鍵なしで外へ出さない）。宛先の URL は、バインディングの中だけの名前 */
export function ragSearcherOf(env: { readonly RAG?: { fetch(request: Request): Promise<Response> }; readonly RAG_TOKEN?: string }): BookSearcher | null {
  const token = env.RAG_TOKEN?.trim() ?? '';
  const binding = env.RAG;
  if (token === '' || binding === undefined) return null;
  return createRagSearcher({ url: 'https://medbook-rag.internal', token, fetcher: (input, init) => binding.fetch(new Request(input, init)) });
}

/** Anthropic の API の鍵の名前（先にあるほうを使う）。ANTHROPIC_API_KEY が手順書の名前、CARTE_api_key は本番で置いた名前 */
export const ANTHROPIC_KEY_NAMES = ['ANTHROPIC_API_KEY', 'CARTE_api_key'] as const;

/** Anthropic の API の鍵を読む。空・空白だけの値は、ないものとして、次の名前を見る。どれもなければ '' */
export function anthropicKeyOf(env: Partial<Record<(typeof ANTHROPIC_KEY_NAMES)[number], string>>): string {
  for (const name of ANTHROPIC_KEY_NAMES) {
    const value = env[name]?.trim() ?? '';
    if (value !== '') return value;
  }
  return '';
}

/** 上限の設定を読む。数でない・負のときは、既定の値（上限を、設定の間違いで外さない） */
export function dailyLimitOf(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_DAILY_AI_LIMIT;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_AI_LIMIT;
}

/** 記録の道の依存（Worker と、仕事の係〔Durable Objects〕が同じものを作る） */
export function recordDepsOf(env: Env): RecordDeps {
  const apiKey = anthropicKeyOf(env);
  const model = env.MODEL?.trim() || DEFAULT_MODEL;
  return {
    db: env.DB,
    runtime: webRuntime,
    selector: apiKey === '' ? null : createAnthropicSelector({ apiKey, model }),
    dailyAiLimit: dailyLimitOf(env.DAILY_AI_LIMIT),
    model,
    organizer: apiKey === '' ? null : createAnthropicOrganizer({ apiKey, model }),
    books: ragSearcherOf(env),
  };
}

// 表の用意は、同じ起動の中で1回だけ（保存先は、起動のあいだ変わらない）
let database: Db | null = null;
const ready = schemaGate(() => {
  if (database === null) throw new Error('保存先がない');
  return database;
});

/** Cloudflare の実行の文脈（使うのは waitUntil だけ） */
export interface Context {
  waitUntil(work: Promise<unknown>): void;
}

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    database = env.DB;
    const apiKey = anthropicKeyOf(env);
    const model = env.MODEL?.trim() || DEFAULT_MODEL;
    return handle(request, {
      db: env.DB,
      key: env.CARTE_KEY,
      runtime: webRuntime,
      secureCookies: true,
      assets: (r) => env.ASSETS.fetch(r),
      ready,
      selector: apiKey === '' ? null : createAnthropicSelector({ apiKey, model }),
      model,
      organizer: apiKey === '' ? null : createAnthropicOrganizer({ apiKey, model }),
      dailyAiLimit: dailyLimitOf(env.DAILY_AI_LIMIT),
      // 画面とのつながりが切れても、書き込む要求の仕事を続ける（CA-086。切れたあと 30 秒まで）
      keepAlive: (work) => {
        ctx.waitUntil(work);
      },
      // AI の仕事を、通信から切り離す（段N2。CA-087）。設定がなければ、これまでどおり要求の中で動かす
      jobs: env.JOBS === undefined ? null : durableRunner(env.JOBS),
      books: ragSearcherOf(env),
    });
  },
};
