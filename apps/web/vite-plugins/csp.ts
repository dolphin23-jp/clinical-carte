// ビルドした index.html の先頭に、CSP の <meta> を入れる。docs/03 の 1。
// 開発サーバには入れない（Vite の HMR がインラインのスクリプトと WebSocket を使うため）。
import type { Plugin } from 'vite';

import { contentSecurityPolicy } from '../src/net/csp.ts';

export function cspMeta(): Plugin {
  return {
    name: 'carte-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy() },
          injectTo: 'head-prepend',
        },
      ],
    },
  };
}
