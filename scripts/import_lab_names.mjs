// 検査項目・バイタルの「名前・別名・単位の書き方」を、clinical-playbook のカタログ（config/lab-catalog.yaml）から取り込む。
// 使い方：node scripts/import_lab_names.mjs <clinical-playbook の作業ツリー>          … 書き出す
//         node scripts/import_lab_names.mjs <clinical-playbook の作業ツリー> --check  … 古くないかだけ確かめる（違えば 1 で終わる）
//
// - 取り込むのは、名前・別名・単位・単位の別の書き方・群（バイタルか検査か）と、**基準範囲（reference）と、その出典**（CA-059。段K3。
//   packages/core/src/labs/reference.gen.ts）。手で写さない。取り込んだ Playbook のコミットを記録する。
// - **取り込まないもの**：ありうる範囲（plausible）、書き方の単位の倍率（unit_scales の factor）、既定の読み方（default_scale）。carte は換算しない。
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
const REF_OUT = resolve(import.meta.dirname, '..', 'packages', 'core', 'src', 'labs', 'reference.gen.ts');
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

// 基準範囲（CA-059）：出典のあるものだけ。単位はカタログの単位（換算しない）
const num = (v, where) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`数でない：${where}`);
  return v;
};
const sourceIds = new Set((file.sources ?? []).map((src) => str(src.id, 'sources.id')));
const references = [];
for (const group of file.groups) {
  for (const item of group.items) {
    if (item.reference === undefined || item.reference === null) continue;
    const name = str(item.name, 'name');
    const source = str(item.reference.source, `${name} の reference.source`);
    if (!sourceIds.has(source)) throw new Error(`知らない出典：${name} の ${source}`);
    if (item.unit === null || item.unit === undefined) throw new Error(`単位のない項目に基準範囲：${name}`);
    const ranges = item.reference.ranges.map((r, i) => {
      const sex = str(r.sex, `${name} の ranges[${String(i)}].sex`);
      if (!['any', 'M', 'F'].includes(sex)) throw new Error(`知らない性別：${name}`);
      const low = num(r.low, `${name} の low`);
      const high = num(r.high, `${name} の high`);
      if (!(low < high)) throw new Error(`下限が上限より小さくない：${name}`);
      return { sex, low, high };
    });
    references.push({ name, unit: str(item.unit, `${name} の unit`), source, ranges, note: item.reference.note ?? null });
  }
}
const sources = (file.sources ?? []).map((src) => ({ id: src.id, title: str(src.title, 'sources.title'), url: src.url ?? null, checkedOn: src.checked_on ?? null, note: src.note ?? null }));
const minAge = num(file.reference_min_age, 'reference_min_age');

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

const refBody = `// このファイルは scripts/import_lab_names.mjs が作る。手で直さない。
// 出どころ：clinical-playbook の config/lab-catalog.yaml（コミット ${commit}）の reference と sources。 phi-guard: allow コミットの id
// 基準範囲は、健常者の測定値の中央 95%の区間で、診断・治療の臨床判断値ではない。施設・測定法で違うことがある（CA-059。本人の確認まで「未確認」）。

export interface ReferenceSource {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  /** 出典を確かめた日（Playbook の記録） */
  readonly checkedOn: string | null;
  readonly note: string | null;
}

export interface ReferenceRange {
  readonly sex: 'any' | 'M' | 'F';
  readonly low: number;
  readonly high: number;
}

export interface LabReference {
  /** カタログの正規の名前 */
  readonly name: string;
  /** 基準範囲の単位（カタログの単位。換算しない） */
  readonly unit: string;
  readonly source: string;
  readonly ranges: readonly ReferenceRange[];
  readonly note: string | null;
}

/** 本人が、自分の施設の基準範囲と照らして確かめたか（Playbook の confirmed）。false の間は、画面に「未確認の目安」と出す */
export const REFERENCE_CONFIRMED = ${JSON.stringify(file.confirmed === true)};
/** 表全体の注意 */
export const REFERENCE_NOTE = ${JSON.stringify(file.note ?? null)};
/** 基準範囲を使う最小の年齢（成人の範囲。小児には出さない） */
export const REFERENCE_MIN_AGE = ${JSON.stringify(minAge)};

export const REFERENCE_SOURCES: readonly ReferenceSource[] = ${JSON.stringify(sources, null, 2)};

export const LAB_REFERENCES: readonly LabReference[] = ${JSON.stringify(references, null, 2)};
`;

if (check) {
  const currentRef = readFileSync(REF_OUT, 'utf8');
  if (currentRef !== refBody) {
    process.stderr.write('packages/core/src/labs/reference.gen.ts が、Playbook のカタログと違います。--check を外して作り直してください。\n');
    process.exit(1);
  }
  const current = readFileSync(OUT, 'utf8');
  if (current !== body) {
    process.stderr.write('packages/core/src/labs/catalog.gen.ts が、Playbook のカタログと違います。--check を外して作り直してください。\n');
    process.exit(1);
  }
  process.stdout.write(`同じです（${String(entries.length)} 項目・基準範囲 ${String(references.length)} 項目）。\n`);
} else {
  writeFileSync(OUT, body);
  writeFileSync(REF_OUT, refBody);
  process.stdout.write(`書き出した：${String(entries.length)} 項目・基準範囲 ${String(references.length)} 項目（Playbook ${commit.slice(0, 7)}）\n`);
}
