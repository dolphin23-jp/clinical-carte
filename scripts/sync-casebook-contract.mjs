#!/usr/bin/env node
// Casebook の受け渡しの契約（段K10。CA-073）のファイルを、clinical-casebook の作業ツリーから写し直す。Playbook の scripts/sync-contract.mjs と同じ形。
//
// 使い方
//   node scripts/sync-casebook-contract.mjs <Casebook の作業ツリー>   写して、casebook-copies.json（写し元の commit と各ファイルの SHA-256）を書き直す
//   node scripts/sync-casebook-contract.mjs --check                   写したファイルが、記録の SHA-256 と同じかを確かめる（試験が使う）
//
// 写したファイルは、carte では直さない（パケットの符号化と匿名化リンタを、Casebook と1字も違えないため）。直すときは Casebook で直して、ここで写し直す。
// 写し先は、Casebook の中の並び（handoff/・ids/・schema/・lint/・text/）を packages/core/src/casebook/ の下に保つので、import の書き換えは要らない。
// 外部依存を持たない（Node.js の標準モジュールだけ）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = resolve(ROOT, 'casebook-copies.json');

// base64url で持つ（16進だと、数字が12桁続くことがあり、phi-guard の「12桁の数字」に当たるため。Playbook と同じ）
export const sha256 = (text) => createHash('sha256').update(text).digest('base64url');

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

/** 記録と違うファイルの一覧（パスと理由） */
export function checkCopies(root = ROOT) {
  const manifest = readManifest();
  const problems = [];
  for (const f of manifest.files) {
    let text;
    try {
      text = readFileSync(resolve(root, f.path), 'utf8');
    } catch {
      problems.push({ path: f.path, reason: 'ファイルがない' });
      continue;
    }
    if (f.sha256 === undefined) problems.push({ path: f.path, reason: '記録（sha256）がない。sync-casebook-contract を動かす' });
    else if (sha256(text) !== f.sha256) problems.push({ path: f.path, reason: '記録と違う（直接直した？ Casebook で直して、写し直す）' });
  }
  return problems;
}

/** Casebook の作業ツリーの、いまのファイルと写しが同じか（写し直しが要るか。CASEBOOK_DIR を渡した試験が使う） */
export function compareWithCasebook(casebookDir) {
  const manifest = readManifest();
  const differ = [];
  for (const f of manifest.files) {
    const from = readFileSync(resolve(casebookDir, f.from), 'utf8');
    if (sha256(from) !== f.sha256) differ.push(f.path);
  }
  return differ;
}

function sync(casebookDir) {
  const manifest = readManifest();
  const commit = execFileSync('git', ['-C', casebookDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for (const f of manifest.files) {
    const text = readFileSync(resolve(casebookDir, f.from), 'utf8');
    const to = resolve(ROOT, f.path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, text);
    f.sha256 = sha256(text);
  }
  manifest.commit = commit;
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`写しました：${String(manifest.files.length)} ファイル（Casebook ${commit.slice(0, 7)}）\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = process.argv[2];
  if (arg === '--check') {
    const problems = checkCopies();
    for (const p of problems) process.stderr.write(`${p.path}：${p.reason}\n`);
    process.exit(problems.length === 0 ? 0 : 1);
  } else if (arg === undefined) {
    process.stderr.write('使い方：node scripts/sync-casebook-contract.mjs <Casebook の作業ツリー> | --check\n');
    process.exit(2);
  } else {
    sync(resolve(arg));
  }
}
