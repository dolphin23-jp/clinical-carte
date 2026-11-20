// Vite の設定（ビルドと開発サーバ）。試験の設定は vitest.*.config.ts。
import { defineConfig } from 'vite';

import { cspMeta } from './vite-plugins/csp.ts';
import { cloudflareHeaders } from './vite-plugins/headers.ts';

export default defineConfig({
  base: './',
  plugins: [cspMeta(), cloudflareHeaders()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 出荷するプログラムに、通信の API を足さない（Vite の modulepreload の補いは fetch を使う）
    modulePreload: { polyfill: false },
  },
});
