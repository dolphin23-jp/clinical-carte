// ULID（時刻48ビット＋乱数80ビットを、Crockford Base32 の26文字にしたもの）。clinical-casebook の ids/ulid.ts から写した。
// core は時計と乱数に触れないので、時刻（ミリ秒）と乱数（10バイト）は引数で受け取る。

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // phi-guard: allow Crockford Base32 の文字表
const TIME_CHARS = 10;
export const ULID_RANDOM_BYTES = 10;
export const MAX_ULID_TIME = 2 ** 48 - 1;
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function ulid(timeMs: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0 || timeMs > MAX_ULID_TIME) throw new RangeError('ULID の時刻は0以上 2^48 未満の整数（ミリ秒）');
  if (random.length !== ULID_RANDOM_BYTES) throw new RangeError(`ULID の乱数は ${String(ULID_RANDOM_BYTES)} バイト`);
  let time = '';
  let t = timeMs;
  for (let i = 0; i < TIME_CHARS; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  // 80ビット = 5ビット × 16文字
  let rest = '';
  let value = 0;
  let bits = 0;
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rest += ALPHABET.charAt((value >>> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  return time + rest;
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}
