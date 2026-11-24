// 配る入口（wrangler.jsonc の main）。Worker の入口（index.ts）と、AI の仕事を通信から切り離して動かす係（Durable Objects。段N2。CA-087）を出す。
// 試験は index.ts を読む（この入口は、Cloudflare の Durable Objects のために、クラスを出すだけ）。
// CarteJobs は、頼みの本文をメモリにだけ持ち、Durable Objects の保存先（ディスク）を使わない（jobs.ts の createJobHost）。
// Cloudflare の資料（2026-11 確認）：Durable Objects は、出ている通信（AI の答えを待っているあいだ）がある限り動き続ける。無料プランでは SQLite の種類だけが使える。
import worker, { type Env, recordDepsOf } from './index.ts';
import { createJobHost, jobHostFetch, type JobRunner } from './jobs.ts';

export default worker;

export class CarteJobs {
  private readonly host: JobRunner;

  constructor(_state: unknown, env: Env) {
    this.host = createJobHost(() => recordDepsOf(env));
  }

  fetch(request: Request): Promise<Response> {
    return jobHostFetch(this.host, request);
  }
}
