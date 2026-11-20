// ブラウザでの E2E（ビルドした画面と、本物の API の処理を、手元のサーバーで動かして確かめる）。ブラウザは playwright-core。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000, // ビルドとブラウザの起動を含む
    fileParallelism: false,
  },
});
