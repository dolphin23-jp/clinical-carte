// サーバーの設定の読み方（index.ts）：Anthropic の API の鍵の名前。
import { describe, expect, test } from 'vitest';

import { ANTHROPIC_KEY_NAMES, anthropicKeyOf } from '../src/index.ts';

describe('Anthropic の API の鍵', () => {
  test('読む名前は2つ：手順書の名前と、本番で置いた名前', () => {
    expect(ANTHROPIC_KEY_NAMES).toEqual(['ANTHROPIC_API_KEY', 'CARTE_api_key']);
  });

  test('どちらの名前でも読む。両方あれば、ANTHROPIC_API_KEY を使う。前後の空白は落とす', () => {
    expect(anthropicKeyOf({ ANTHROPIC_API_KEY: 'a-key' })).toBe('a-key');
    expect(anthropicKeyOf({ CARTE_api_key: ' c-key\n' })).toBe('c-key');
    expect(anthropicKeyOf({ ANTHROPIC_API_KEY: 'a-key', CARTE_api_key: 'c-key' })).toBe('a-key');
  });

  test('空・空白だけの値は、ないものとして、次の名前を見る。どれもなければ空（文は入れられない）', () => {
    expect(anthropicKeyOf({ ANTHROPIC_API_KEY: '  ', CARTE_api_key: 'c-key' })).toBe('c-key');
    expect(anthropicKeyOf({})).toBe('');
    expect(anthropicKeyOf({ ANTHROPIC_API_KEY: '', CARTE_api_key: ' ' })).toBe('');
  });

  test('名前の大文字・小文字は区別する（似た名前は読まない）', () => {
    expect(anthropicKeyOf({ anthropic_api_key: 'x', CARTE_API_KEY: 'y' } as never)).toBe('');
  });
});
