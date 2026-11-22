// 画面の境界：記録を端末に保存しない（docs/03 の 4）。通信は net/api.ts だけで、宛先は自分のオリジンだけ（CA-012）。
// ソースを読んで、約束が破られていないかを確かめる。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({ rel: relative(SRC, path), text: readFileSync(path, 'utf8') }));
const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

describe('保存先の境界', () => {
  test('端末の保存先（localStorage・sessionStorage・IndexedDB・Cache Storage・Cookie・ファイル）を使わない', () => {
    for (const f of files) {
      expect(code(f.text), f.rel).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|caches)\b|document\.cookie|showSaveFilePicker|serviceWorker/);
    }
  });
});

describe('通信の境界', () => {
  test('fetch などを呼ぶのは、net/api.ts だけ', () => {
    const users = files.filter((f) => /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/.test(code(f.text))).map((f) => f.rel);
    expect(users).toEqual(['net/api.ts']);
  });

  test('宛先は、自分のオリジンの /api/ だけ（ほかのホストを書かない）', () => {
    for (const f of files) expect(code(f.text), f.rel).not.toMatch(/https?:\/\//);
    const api = files.find((f) => f.rel === 'net/api.ts');
    expect(code(api?.text ?? '')).toContain('fetch(`/api/${path}`');
  });

  test('合鍵を、画面の外（アドレス・ログ）に出さない', () => {
    for (const f of files) expect(code(f.text), f.rel).not.toMatch(/\bconsole\b|location\.(href|search|hash)\s*=|history\.(push|replace)State/);
  });
});

describe('クリップボードの境界（段K10。CA-073）', () => {
  test('クリップボードに書くのは、Casebook へ送る画面（パケット）と、鍵を作る2つの画面（合鍵・書籍の合鍵）だけ。記録の文を、ほかのところからコピーしない', () => {
    const users = files.filter((f) => /\bclipboard\b/.test(code(f.text))).map((f) => f.rel).sort();
    expect(users).toEqual(['BookKey.tsx', 'CasebookPanel.tsx', 'KeyMaker.tsx']);
    const panel = files.find((f) => f.rel === 'CasebookPanel.tsx');
    // Casebook の画面がコピーするのは、作ったパケット（CBH1: で始まる文字列）だけ
    expect(code(panel?.text ?? '').match(/clipboard\.writeText\(([^)]*)\)/gu)).toEqual(['clipboard.writeText(built.text)']);
  });

  test('クリップボードを読まない（Casebook から戻す向きはない）', () => {
    for (const f of files) expect(code(f.text), f.rel).not.toMatch(/\breadText\b|clipboard\.read\b/);
  });
});

describe('常時表示の帯', () => {
  test('帯は、画面の全体（App）に1つ置き、どの状態でも出す（状態の分岐の外にある）', () => {
    const app = files.find((f) => f.rel === 'App.tsx');
    const text = code(app?.text ?? '');
    expect(text.match(/<Banner \/>/g)).toHaveLength(1);
    expect(text.indexOf('<Banner />')).toBeLessThan(text.indexOf("state.at === 'loading'"));
  });

  test('帯に、消す・閉じるボタンがない', () => {
    const banner = files.find((f) => f.rel === 'Banner.tsx');
    expect(code(banner?.text ?? '')).not.toMatch(/<button|onClick|useState/);
  });
});
