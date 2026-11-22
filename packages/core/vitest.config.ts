import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { defineConfig } from 'vitest/config';

// Casebook の作業ツリー（CASEBOOK_DIR）のファイルを、試験で直接読むとき（test/casebook.test.ts）、そのファイルの import 'zod' を carte の zod に向ける
// （Casebook の作業ツリーに node_modules がなくても読めるように）。CASEBOOK_DIR がなければ、何も変えない
const require = createRequire(import.meta.url);
const alias = process.env['CASEBOOK_DIR'] === undefined ? {} : { zod: dirname(require.resolve('zod/package.json')) };

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
