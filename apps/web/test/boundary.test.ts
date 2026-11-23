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

describe('見た目の境界（段K。CA-058）', () => {
  test('インラインの style を使わない（CSP：style-src は自分のオリジンだけ）。見た目は style.css のクラスで決める', () => {
    for (const f of files) expect(code(f.text), f.rel).not.toMatch(/\bstyle=|\.style\.|setAttribute\(\s*['"]style/);
  });

  test('絵の印（Icon）は、この中の SVG だけ（画像・フォント・外の読み込みを使わない）', () => {
    const icon = files.find((f) => f.rel === 'Icon.tsx');
    const text = code(icon?.text ?? '');
    expect(text).toContain('<svg');
    expect(text).not.toMatch(/<img|<image|<use|href=|url\(|@import|font-face/);
    // 飾りなので、読み上げには出さない（隣に、いつも字の名前がある）
    expect(text).toContain('aria-hidden="true"');
  });

  test('値で色を変えない：グラフの部品は、値を比べて class を選ばない（色の class は、項目・種類の名前からだけ）', () => {
    for (const rel of ['charts/Sparkline.tsx', 'charts/RecordMap.tsx', 'charts/ProblemLanes.tsx', 'LatestStrip.tsx']) {
      const text = code(files.find((f) => f.rel === rel)?.text ?? '');
      expect(text, rel).not.toBe('');
      // 判定の語と、判定の色（赤・緑の名前、警告）を class・文に持たない
      expect(text, rel).not.toMatch(/異常|正常|高値|低値|警告|danger|warning|alert|abnormal/);
    }
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
