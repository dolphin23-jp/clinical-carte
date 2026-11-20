// Cloudflare の応答ヘッダの設定（_headers）をビルドで作る。Workers の静的ファイル配信が読む。
// CSP は <meta>（csp.ts）と同じ関数から作り、ヘッダでしか効かない frame-ancestors を足す。
import type { Plugin } from 'vite';

import { contentSecurityPolicy } from '../src/net/csp.ts';

export const HEADERS_FILE = '_headers';

export function headersFile(): string {
  const all = [
    `Content-Security-Policy: ${contentSecurityPolicy('header')}`,
    'X-Content-Type-Options: nosniff',
    'X-Frame-Options: DENY',
    'Referrer-Policy: no-referrer',
    'Cross-Origin-Opener-Policy: same-origin',
    'Strict-Transport-Security: max-age=31536000', // phi-guard: allow 1年の秒数
    'Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    // 検索に載せない
    'X-Robots-Tag: noindex, nofollow',
  ];
  const rules: [string, string[]][] = [
    ['/*', all],
    // 入口は毎回確かめる（新しい版に早く入れ替わるように）
    ['/', ['Cache-Control: no-cache']],
    ['/index.html', ['Cache-Control: no-cache']],
    ['/manifest.webmanifest', ['Cache-Control: no-cache']],
    // ファイル名に中身のハッシュが入っているので、長く置いてよい
    ['/assets/*', ['Cache-Control: public, max-age=31536000, immutable']], // phi-guard: allow 1年の秒数
  ];
  return `${rules.map(([path, lines]) => [path, ...lines.map((l) => `  ${l}`)].join('\n')).join('\n')}\n`;
}

export function cloudflareHeaders(): Plugin {
  return {
    name: 'carte-cloudflare-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: HEADERS_FILE, source: headersFile() });
    },
  };
}
