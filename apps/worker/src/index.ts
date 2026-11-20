// Cloudflare Workers の入口。設定（保存先・合鍵・静的ファイル）を、handler に渡すだけ。
import type { Db } from './db.ts';
import { handle } from './handler.ts';
import { webRuntime } from './runtime.ts';

export interface Env {
  /** D1（wrangler.jsonc の d1_databases） */
  readonly DB: Db;
  /** 画面の静的ファイル（wrangler.jsonc の assets） */
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  /** 合鍵（wrangler secret put CARTE_KEY）。ない・短いときは、すべての API を断る */
  readonly CARTE_KEY?: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      db: env.DB,
      key: env.CARTE_KEY,
      runtime: webRuntime,
      secureCookies: true,
      assets: (r) => env.ASSETS.fetch(r),
    });
  },
};
