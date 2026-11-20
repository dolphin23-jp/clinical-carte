// 応答ヘッダと CSP：通信先は自分のオリジンだけ。インラインのスクリプト・スタイルを許さない。
import { describe, expect, test } from 'vitest';

import { contentSecurityPolicy } from '../src/net/csp.ts';
import { guessKind } from '../src/Register.tsx';
import { headersFile } from '../vite-plugins/headers.ts';

describe('CSP', () => {
  test('通信先は自分のオリジンだけ。ほかのホスト・インライン・eval を許さない', () => {
    const csp = contentSecurityPolicy('header');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:|unsafe-inline|unsafe-eval|\*/);
  });
  test('<meta> には、frame-ancestors を入れない（効かないため）', () => {
    expect(contentSecurityPolicy('meta')).not.toContain('frame-ancestors');
  });
});

describe('_headers', () => {
  test('すべての道に、CSP・nosniff・埋め込みの禁止・検索に載せない印が付く', () => {
    const text = headersFile();
    const all = text.split('\n/')[0] ?? '';
    expect(all.startsWith('/*\n')).toBe(true);
    for (const name of ['Content-Security-Policy:', 'X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY', 'Referrer-Policy: no-referrer', 'X-Robots-Tag: noindex', 'Strict-Transport-Security:']) {
      expect(all).toContain(name);
    }
  });
});

describe('端末の種類の、最初の選択', () => {
  test('iPhone・iPad（Mac と名乗るものも）・PC を見分ける', () => {
    expect(guessKind('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', 5)).toBe('iphone');
    expect(guessKind('Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X)', 5)).toBe('ipad');
    expect(guessKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ipad');
    expect(guessKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('pc');
    expect(guessKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0)).toBe('pc');
    expect(guessKind('Mozilla/5.0 (Linux; Android 16) Mobile', 5)).toBe('other');
  });
});
