// 時計・乱数・ハッシュ（WebCrypto）。ここだけが触れる。入口の処理（entrance.ts・handler.ts）は、引数で受け取る。
export interface Runtime {
  now(): number;
  randomBytes(length: number): Uint8Array;
  sha256Hex(value: string): Promise<string>;
}

export const webRuntime: Runtime = {
  now: () => Date.now(),
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  sha256Hex: async (value) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    let out = '';
    for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
    return out;
  },
};
