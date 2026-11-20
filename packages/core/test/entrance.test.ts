import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  DEVICE_SECRET_BYTES,
  formatDeviceToken,
  isDeviceKind,
  keyProblem,
  MIN_KEY_LENGTH,
  parseDeviceToken,
  readCookie,
  sameText,
  toHex,
  ulid,
} from '../src/index.ts';

const id = ulid(1_800_000_000_000, new Uint8Array(10).fill(7));
const secret = toHex(new Uint8Array(DEVICE_SECRET_BYTES).fill(0xab));

describe('合鍵の形（鍵なしで動かさない）', () => {
  test('ない・空・短い・同じ字の繰り返しは、使えない', () => {
    expect(keyProblem(undefined)).toBe('missing');
    expect(keyProblem('   ')).toBe('missing');
    expect(keyProblem('x'.repeat(MIN_KEY_LENGTH - 1))).toBe('too_short');
    expect(keyProblem('a'.repeat(MIN_KEY_LENGTH))).toBe('too_simple');
    expect(keyProblem('abab'.repeat(MIN_KEY_LENGTH))).toBe('too_simple');
  });
  test('長くて、字の種類が多い合鍵は、使える', () => {
    expect(keyProblem(toHex(new Uint8Array(32).map((_, i) => (i * 37 + 11) % 256)))).toBeNull();
  });
});

describe('端末の印', () => {
  test('作った印は、同じ値に読み戻せる', () => {
    expect(parseDeviceToken(formatDeviceToken(id, secret))).toEqual({ deviceId: id, secretHex: secret });
  });
  test('形の違うものは、読まない', () => {
    for (const bad of [undefined, null, '', id, `${id}.`, `${id}.${secret}0`, `${id}.${secret.slice(1)}`, `${id}.${secret.toUpperCase()}`, `x${id}.${secret}`, `${id.toLowerCase()}.${secret}`]) {
      expect(parseDeviceToken(bad)).toBeNull();
    }
  });
  test('どんな文字列を渡しても、例外を投げない', () => {
    fc.assert(fc.property(fc.string(), (s) => parseDeviceToken(s) === null || typeof parseDeviceToken(s)?.deviceId === 'string'));
  });
  test('形の違う id・秘密からは、印を作らない', () => {
    expect(() => formatDeviceToken('abc', secret)).toThrow(RangeError);
    expect(() => formatDeviceToken(id, 'zz')).toThrow(RangeError);
  });
});

describe('文字列の比べ方', () => {
  test('同じなら true、1字でも違えば false、長さが違えば false', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(sameText(a, b)).toBe(a === b);
        expect(sameText(a, a)).toBe(true);
      }),
    );
  });
});

describe('Cookie の読み方', () => {
  test('名前の値を取り出す', () => {
    expect(readCookie('a=1; carte=xyz; b=2', 'carte')).toBe('xyz');
    expect(readCookie('carte=xyz', 'carte')).toBe('xyz');
  });
  test('ない・同じ名前が2つ・ヘッダがない ときは null', () => {
    expect(readCookie('a=1', 'carte')).toBeNull();
    expect(readCookie('carte=1; carte=2', 'carte')).toBeNull();
    expect(readCookie(null, 'carte')).toBeNull();
    expect(readCookie('', 'carte')).toBeNull();
  });
  test('名前の一部が同じだけの Cookie は、読まない', () => {
    expect(readCookie('xcarte=1; carte2=2', 'carte')).toBeNull();
  });
});

describe('端末の種類', () => {
  test('決めた4つだけ', () => {
    expect(['iphone', 'ipad', 'pc', 'other'].every(isDeviceKind)).toBe(true);
    expect(isDeviceKind('android')).toBe(false);
    expect(isDeviceKind(1)).toBe(false);
  });
});
