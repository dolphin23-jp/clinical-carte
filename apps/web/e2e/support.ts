// E2E の道具：画面のビルド、手元のサーバー（本物の API の処理）、ブラウザの起動。
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { type Browser, chromium } from 'playwright-core';

const WEB_DIR = resolve(import.meta.dirname, '..');

export interface BuiltApp {
  readonly dir: string;
  remove(): Promise<void>;
}

/** 画面を、一時ディレクトリにビルドする（`pnpm test` を単独で動かしても、ビルド済みを前提にしない）。 */
export async function buildApp(): Promise<BuiltApp> {
  const dir = await mkdtemp(join(tmpdir(), 'carte-e2e-'));
  // vitest は NODE_ENV=test を設定する。本番と同じ形（CSP の <meta> つき）でビルドする
  const env = { ...process.env, NODE_ENV: 'production' };
  execFileSync('pnpm', ['exec', 'vite', 'build', '--outDir', dir, '--emptyOutDir'], { cwd: WEB_DIR, stdio: 'pipe', env });
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** ブラウザを起動する。別の Chromium を使うときは、環境変数 CARTE_CHROMIUM_PATH に実行ファイルを指定する。 */
export function launch(): Promise<Browser> {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const executablePath = process.env['CARTE_CHROMIUM_PATH'];
  return chromium.launch({ ...(executablePath === undefined ? {} : { executablePath }), args: isRoot ? ['--no-sandbox'] : [] });
}
