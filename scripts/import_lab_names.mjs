// 検査項目・バイタルの「名前・別名・単位の書き方」を、clinical-playbook のカタログ（config/lab-catalog.yaml）から取り込む。
// 使い方：node scripts/import_lab_names.mjs <clinical-playbook の作業ツリー>          … 書き出す
//         node scripts/import_lab_names.mjs <clinical-playbook の作業ツリー> --check  … 古くないかだけ確かめる（違えば 1 で終わる）
//
// - 取り込むのは、名前・別名・単位・単位の別の書き方・群（バイタルか検査か）だけ。手で写さない。取り込んだ Playbook のコミットを記録する。
// - **取り込まないもの**：基準範囲（reference）、ありうる範囲（plausible）、書き方の単位の倍率（unit_scales の factor）、既定の読み方（default_scale）。
//   carte は記録で、値を判定せず、換算もしない（AGENTS.md の 1。docs/04 の 3.4）。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

const args = process.argv.slice(2);
const check = args.includes('--check');
const tree = args.find((a) => !a.startsWith('--'));
if (tree === undefined) {
  process.stderr.write('使い方：node scripts/import_lab_names.mjs <clinical-playbook の作業ツリー> [--check]\n');
  process.exit(2);
}

const OUT = resolve(import.meta.dirname, '..', 'packages', 'core', 'src', 'labs', 'catalog.gen.ts');
const file = parse(readFileSync(join(tree, 'config', 'lab-catalog.yaml'), 'utf8'));
const commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const str = (v, where) => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`文字列でない：${where}`);
  return v;
};

const entries = [];
for (const group of file.groups) {
  const kind = group.kind;
  if (kind !== 'lab' && kind !== 'vital') throw new Error(`知らない群の種類：${String(kind)}`);
  for (const item of group.items) {
    const name = str(item.name, 'name');
    const units = [];
    if (item.unit !== null && item.unit !== undefined) units.push(str(item.unit, `${name} の unit`));
    for (const u of item.unit_aliases ?? []) units.push(str(u, `${name} の unit_aliases`));
    for (const scale of item.unit_scales ?? []) {
      units.push(str(scale.unit, `${name} の unit_scales`));
      for (const u of scale.aliases ?? []) units.push(str(u, `${name} の unit_scales の aliases`));
    }
    entries.push({
      name,
      aliases: (item.aliases ?? []).map((a) => str(a, `${name} の aliases`)),
      kind,
      group: str(group.name, 'group.name'),
      units: [...new Set(units)],
    });
  }
}

const names = new Set();
for (const e of entries) {
  for (const n of [e.name, ...e.aliases]) {
    const key = n.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    if (names.has(key)) throw new Error(`名前・別名が重なっている：${n}`);
    names.add(key);
  }
}

const body = `// このファイルは scripts/import_lab_names.mjs が作る。手で直さない。
// 出どころ：clinical-playbook の config/lab-catalog.yaml（コミット ${commit}）。 phi-guard: allow コミットの id
// 取り込んだのは、名前・別名・単位の書き方・群だけ（基準範囲・ありうる範囲・換算の倍率は取り込まない。carte は値を判定せず、換算もしない）。

export interface LabName {
  /** 正規の名前（推移の表で、同じ項目をまとめるのに使う） */
  readonly name: string;
  /** 別の書き方 */
  readonly aliases: readonly string[];
  readonly kind: 'lab' | 'vital';
  readonly group: string;
  /** この項目の単位の書き方（書かれた単位を、単位として読み分けるのに使う。換算には使わない） */
  readonly units: readonly string[];
}

export const LAB_NAMES_SOURCE_COMMIT = ${JSON.stringify(commit)}; // phi-guard: allow コミットの id

export const LAB_NAMES: readonly LabName[] = ${JSON.stringify(entries, null, 2)};
`;

if (check) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== body) {
    process.stderr.write('packages/core/src/labs/catalog.gen.ts が、Playbook のカタログと違います。--check を外して作り直してください。\n');
    process.exit(1);
  }
  process.stdout.write(`同じです（${String(entries.length)} 項目）。\n`);
} else {
  writeFileSync(OUT, body);
  process.stdout.write(`書き出した：${String(entries.length)} 項目（Playbook ${commit.slice(0, 7)}）\n`);
}
