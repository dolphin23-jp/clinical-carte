// ESLint の設定（flat config）。リポジトリのルートで `pnpm lint`（= eslint .）として動かす。
// 形は clinical-casebook の eslint.config.js から写した（core の境界、web の通信の出口）。
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// core は DOM、ストレージ、通信、時計、乱数に触れない。時刻と乱数は引数で受け取る（AGENTS.md の 2）。
// 型の側でも packages/core/tsconfig.src.json で DOM と Node の型を外して止めている。
const PURE = 'core は純関数だけを置く。時刻・乱数・入出力は引数で受け取る。';

const coreForbiddenGlobals = [
  // DOM とブラウザ
  'window', 'self', 'globalThis', 'document', 'navigator', 'location', 'history', 'alert', 'confirm', 'prompt',
  // ストレージ
  'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  // 通信
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Request', 'Response', 'Headers',
  // 時計と乱数
  'performance', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
  'requestAnimationFrame', 'requestIdleCallback', 'crypto',
  // Node
  'process', 'require', 'Buffer', '__dirname', '__filename',
].map((name) => ({ name, message: PURE }));

const coreForbiddenModules = [
  'node:*', 'fs', 'fs/*', 'path', 'crypto', 'http', 'https', 'net', 'os', 'child_process', 'worker_threads',
  'url', 'util', 'stream', 'events', 'timers', 'perf_hooks',
];

// web で通信できるのは net/ だけ。宛先は自分のオリジンだけ（Anthropic の API を呼ぶのはサーバー。CA-012）。
const NET = '通信は apps/web/src/net/ を通す（宛先を自分のオリジンだけにするため）。';
const webNetworkGlobals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection'].map(
  (name) => ({ name, message: NET }),
);

// 画面は、記録を端末に保存しない（docs/03 の 4）。
const STORE = '画面は、端末の保存先を使わない（記録はサーバーにだけ置く。docs/03 の 4）。';
const webStorageGlobals = ['localStorage', 'sessionStorage', 'indexedDB', 'caches'].map((name) => ({ name, message: STORE }));

// サーバーは、記録の中身をログに出さない（AGENTS.md の 1）。
const LOG = 'サーバーは、ログを出さない（記録の中身が残るのを防ぐ。AGENTS.md の 1）。';

export default defineConfig(
  { ignores: ['**/node_modules/', '**/dist/', '**/coverage/', '**/.wrangler/'] },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // JavaScript（scripts/、設定ファイル）は型情報なしで検査する
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // web の通信の出口と、保存先
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/net/**'],
    rules: {
      'no-restricted-globals': ['error', ...webNetworkGlobals, ...webStorageGlobals],
      'no-restricted-properties': [
        'error',
        { object: 'navigator', property: 'sendBeacon', message: NET },
        { object: 'window', property: 'fetch', message: NET },
        { object: 'globalThis', property: 'fetch', message: NET },
        { object: 'self', property: 'fetch', message: NET },
        { object: 'document', property: 'cookie', message: STORE },
      ],
    },
  },
  {
    files: ['apps/web/src/net/**/*.{ts,tsx}'],
    rules: { 'no-restricted-globals': ['error', ...webStorageGlobals] },
  },

  // サーバー
  {
    files: ['apps/worker/src/**/*.ts'],
    rules: { 'no-console': ['error', {}], 'no-restricted-globals': ['error', { name: 'console', message: LOG }] },
  },

  // core の境界
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-globals': ['error', ...coreForbiddenGlobals],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: PURE },
        { object: 'Math', property: 'random', message: PURE },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: PURE },
        { selector: "CallExpression[callee.name='Date']", message: PURE },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: PURE },
            { name: 'react-dom', message: PURE },
          ],
          patterns: [
            { group: coreForbiddenModules, message: PURE },
            { group: ['**/apps/**', '@clinical-carte/web', '@clinical-carte/web/*', '@clinical-carte/worker', '@clinical-carte/worker/*'], message: 'core から web・worker へは依存しない。' },
          ],
        },
      ],
    },
  },
);
