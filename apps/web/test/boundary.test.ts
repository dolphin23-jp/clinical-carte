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

describe('見た目の境界（段L。CA-080）', () => {
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

  test('段L で足した図は、値で色を変えない：値を比べて class を選ばない（色の class は、項目・種類の名前からだけ。基準範囲の印〔CA-062〕は、これまでの場所だけ）', () => {
    for (const rel of ['charts/Sparkline.tsx', 'charts/RecordMap.tsx', 'charts/ProblemLanes.tsx', 'LatestStrip.tsx']) {
      const text = code(files.find((f) => f.rel === rel)?.text ?? '');
      expect(text, rel).not.toBe('');
      // 判定の語と、判定の色（赤・緑の名前、警告）を class・文に持たない
      expect(text, rel).not.toMatch(/異常|正常|高値|低値|警告|danger|warning|alert|abnormal/);
    }
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

describe('相談の窓口の境界（段M。CA-081）', () => {
  const panel = files.find((f) => f.rel === 'ConsultPanel.tsx');
  const text = code(panel?.text ?? '');

  test('残す要求に入れるのは、どちらの答えか・答えの字・参照だけ（問いの文を送らない）', () => {
    const note = /const note = ([^;]+);/u.exec(text)?.[1] ?? '';
    expect(note).toContain('consultNoteText(entry.reply)');
    expect(note).toContain('askNoteText(entry.reply)');
    expect(note).not.toContain('question');
    expect(text.match(/addConsultNote\(([^)]*)\)/gu)).toEqual(['addConsultNote(patientId, note)']);
  });

  test('送る前に、問い・前のやりとりの識別情報の形を確かめる（サーバーと同じ関数）。「臨床支援の草案・最終判断は先生」をいつも出す', () => {
    expect(text.indexOf('consultHasShapes({ question, turns })')).toBeGreaterThan(-1);
    expect(text.indexOf('consultHasShapes({ question, turns })')).toBeLessThan(text.search(/void consultPatient\(/u));
    expect(text.search(/void consultPatient\(/u)).toBeGreaterThan(-1);
    expect(text).toContain('臨床支援の草案です。最終判断は先生です。');
    // 外へのリンクを作らない（出典は字で出す）
    expect(text).not.toMatch(/<a\b|href=/u);
  });

  test('答えの文を使う先（段M2。CA-082）：記載へは、画面のメモリの候補に入れるだけ（保存の通信をしない）。指示簿へは、決めた1つの形（AI の案）でだけ足す', () => {
    // 窓口から呼ぶ保存の通信は、残す・直す・消す（相談の答え）と、指示簿に足す、だけ。カルテ記載の保存は、カルテ記載の画面の「保存する」だけ
    expect(text).not.toMatch(/\b(saveDocument|patchDocument|saveHandoff|addApNotes|addSource)\b/u);
    expect(text.match(/addOrders\(/gu)).toHaveLength(1);
    expect(text).toContain('addOrders(encounterId, [consultOrderNew(statement, category, text)])');
    // 途中の文（確かめた後の文）には、入れるボタンを出さない
    expect(text).toContain('onOpenSource={onOpenSource} targets={null} />');
    // カルテ記載の画面：候補を足すのは下書き（setWork）だけで、足すときに保存の通信をしない
    const doc = code(files.find((f) => f.rel === 'DocumentView.tsx')?.text ?? '');
    const insert = doc.slice(doc.indexOf('const insertPick ='), doc.indexOf('const save = () =>'));
    expect(insert).toContain("origin: 'ai', edited: true, dirty: true");
    expect(insert).not.toMatch(/saveDocument|patchDocument|fetch|await /u);
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
