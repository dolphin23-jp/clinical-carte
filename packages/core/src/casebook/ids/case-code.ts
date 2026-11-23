// 症例コード（A-007、D-008）。本人が紙の台帳に書き写す、短いコード。
//
// 紛らわしい文字を除く：0 と O、1 と I と L、U、を使わない（30文字）。6文字で約7億通り。
// core は乱数に触れないので、乱数（6バイト）は引数で受け取る。
// バイトを 30 で割った余りで選ぶので、わずかに偏る（256 は 30 で割り切れない）。台帳の識別用なので、偏りは許す。
export const CASE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // phi-guard: allow 文字表の数字の並び
export const CASE_CODE_LENGTH = 6;
export const CASE_CODE_RANDOM_BYTES = 6;

export const CASE_CODE_PATTERN: RegExp = /^[2-9A-HJKMNP-TV-Z]{6}$/;

export function caseCode(random: Uint8Array): string {
  if (random.length !== CASE_CODE_RANDOM_BYTES) throw new RangeError(`症例コードの乱数は ${String(CASE_CODE_RANDOM_BYTES)} バイト`);
  let code = '';
  for (const byte of random) code += CASE_CODE_ALPHABET.charAt(byte % CASE_CODE_ALPHABET.length);
  return code;
}

// 台帳から書き写したコードの正規化：前後の空白を除き、小文字を大文字にする
export function normalizeCaseCode(input: string): string {
  return input.trim().toUpperCase();
}
