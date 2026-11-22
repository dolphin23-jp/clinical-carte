// スコアと診断基準の定義（段K4。CA-059・CA-063）を、clinical-playbook の config/clinical-presets/*.yaml と config/preset-inputs.yaml から取り込む。
// 使い方：node scripts/import_presets.mjs <clinical-playbook の作業ツリー>          … 書き出す
//         node scripts/import_presets.mjs <clinical-playbook の作業ツリー> --check  … 古くないかだけ確かめる（違えば 1 で終わる）
//
// - 定義（項目・点・閾値・区分・出典・confirmed）は、そのまま取り込む。手で写さない・閾値を変えない。取り込んだ Playbook のコミットを記録する。
// - 取り込む前に、carte の core に写した確かめ（packages/core/src/presets/parse.ts。Playbook のビルドと同じ規則）を、Playbook の検査項目のカタログ
//   （config/lab-catalog.yaml）に対して通す。定義が使う検査の名前が、carte の名前の表（labs/catalog.gen.ts）にあることも確かめる。
// - カタログからは、定義が使う検査と観察の項目の「正規名・単位・同じ単位の別の書き方（unit_aliases）・単位が要る項目か（unit_matters）」と、
//   観察の項目の「ありうる範囲」（範囲の外の値をスコアに使わないため。Playbook の観察の読み方と同じ）だけを取り込む。換算の倍率は取り込まない。
// - 書き出す packages/core/src/presets/library.gen.ts は手で直さない。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

import { scanText } from './phi-guard.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const tree = args.find((a) => !a.startsWith('--'));
if (tree === undefined) {
  process.stderr.write('使い方：node scripts/import_presets.mjs <clinical-playbook の作業ツリー> [--check]\n');
  process.exit(2);
}

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'packages', 'core', 'src', 'presets', 'library.gen.ts');
const core = (p) => join(ROOT, 'packages', 'core', 'src', p);
// core の確かめを、そのまま使う（Node が型を外して読む）
const { mergeClinicalPresetFiles, parseClinicalPresets } = await import(core('presets/parse.ts'));
const { parsePresetInputs } = await import(core('presets/inputs.ts'));
const { labKey } = await import(core('presets/catalog.ts'));
const { LAB_NAMES } = await import(core('labs/catalog.gen.ts'));

const commit = execFileSync('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const yaml = (path) => parse(readFileSync(path, 'utf8'), { version: '1.2' });
const fail = (lines) => {
  process.stderr.write(`取り込めません：\n${lines.join('\n')}\n`);
  process.exit(1);
};

// ---- 検査項目のカタログ（確かめるためと、単位の表のため） ----
const labFile = yaml(join(tree, 'config', 'lab-catalog.yaml'));
const entries = [];
for (const group of labFile.groups) {
  for (const item of group.items) {
    entries.push({
      name: item.name,
      aliases: item.aliases ?? [],
      unit: item.unit ?? null,
      unitAliases: item.unit_aliases ?? [],
      plausible: item.plausible ?? null,
      unitRequired: typeof item.unit_matters === 'string',
    });
  }
}
const catalog = { entries };

// ---- 入力の対応と定義 ----
let inputs;
try {
  inputs = parsePresetInputs(yaml(join(tree, 'config', 'preset-inputs.yaml')), catalog);
} catch (error) {
  fail([String(error instanceof Error ? error.message : error)]);
}
const dir = join(tree, 'config', 'clinical-presets');
const names = readdirSync(dir)
  .filter((n) => n.endsWith('.yaml'))
  .sort();
const merged = mergeClinicalPresetFiles(names.map((name) => ({ name, raw: yaml(join(dir, name)) })));
if (!merged.ok) fail(merged.issues.map((i) => `  ${i.path}: ${i.message}`));
const result = parseClinicalPresets(merged.value.value, { catalog, inputs });
if (!result.ok) fail(result.issues.map((i) => `  ${merged.value.locate(i.path)}: ${i.message}`));
const library = result.value;

// ---- 定義が使う検査（と観察の項目）の名前 ----
const used = new Set();
const walk = (x) => {
  if (Array.isArray(x)) {
    for (const y of x) walk(y);
    return;
  }
  if (x === null || typeof x !== 'object') return;
  if (typeof x.lab === 'string' && !('qual' in x)) used.add(x.lab);
  for (const y of Object.values(x)) walk(y);
};
walk(library.presets);
const observations = [...inputs.observations.values()].map((o) => ({ kind: o.kind, item: o.item, unit: o.unit, plausible: o.plausible, inCatalog: o.inCatalog }));
for (const o of observations) used.add(o.item);
const carteNames = new Set(LAB_NAMES.map((e) => e.name));
const labUnits = [];
const missing = [];
for (const name of [...used].sort()) {
  const e = entries.find((x) => labKey(x.name) === labKey(name));
  // 飲水はカタログにない（観察の対応に単位とありうる範囲がある）
  if (e === undefined) {
    if (!observations.some((o) => o.item === name && !o.inCatalog)) missing.push(`  カタログにない：${name}`);
    continue;
  }
  if (!carteNames.has(e.name)) missing.push(`  carte の名前の表（labs/catalog.gen.ts）にない：${e.name}（import_lab_names.mjs で取り込み直す）`);
  labUnits.push({ name: e.name, unit: e.unit, unitAliases: e.unitAliases, unitRequired: e.unitRequired });
}
if (missing.length > 0) fail(missing);

// ---- 書き出す ----
// 1つの定義を1行にする。phi-guard が数の並び（JCS の段階の書き方など）を暦日・生年月日の形と見る行には、理由つきの allow を付け、
// 付けた行の id と規則を、書き出すときに出す（定義は Playbook の出典から写した文で、患者の情報ではない。Playbook の側も phi-guard を通している）
const allowed = [];
const ALLOW = ' // phi-guard: allow 定義の文（出典から写した数の並び。患者の情報ではない）';
const lines = (list) =>
  `[\n${list
    .map((x) => {
      const line = `  ${JSON.stringify(x)},`;
      const found = scanText(line).filter((f) => f.level === 'error' || f.level === 'warn');
      if (found.length === 0) return line;
      allowed.push(`${String(x.id)}（${[...new Set(found.map((f) => f.rule))].join('・')}）`);
      return `${line}${ALLOW}`;
    })
    .join('\n')}\n]`;
const body = `// このファイルは scripts/import_presets.mjs が作る。手で直さない。
// 出どころ：clinical-playbook の config/clinical-presets/*.yaml と config/preset-inputs.yaml、config/lab-catalog.yaml（コミット ${commit}）。 phi-guard: allow コミットの id
// 定義（項目・点・閾値・区分）は出典から写したもので、Playbook の confirmed: false のものは、先生が原典で確かめるまで「未確認」（CA-059）。
import type { PresetObservationInput } from './inputs.ts';
import type { ClinicalPresetLibrary } from './schema.ts';

export const PRESETS_SOURCE_COMMIT = ${JSON.stringify(commit)}; // phi-guard: allow コミットの id

export const PRESET_AREAS: ClinicalPresetLibrary['areas'] = ${lines(library.areas)};

export const PRESET_SOURCES: ClinicalPresetLibrary['sources'] = ${lines(library.sources)};

export const PRESET_DEFINITIONS: ClinicalPresetLibrary['presets'] = ${lines(library.presets)};

/** 観察の種類（{ obs: sbp } など）が読む項目の名前・単位・ありうる範囲（範囲の外の値はスコアに使わない） */
export const PRESET_OBSERVATIONS: readonly PresetObservationInput[] = ${lines(observations)};

/** 定義の { derived: 名前 } の計算値（carte はまだ作らない。定義の中では「未入力」になる） */
export const PRESET_DERIVED: readonly string[] = ${JSON.stringify([...inputs.derived])};

/** 定義が使う検査・観察の項目の単位（換算しない。同じ単位の別の書き方だけ。unitRequired は、単位が書かれていない値を読まない項目） */
export const PRESET_LAB_UNITS: readonly { name: string; unit: string | null; unitAliases: readonly string[]; unitRequired: boolean }[] = ${lines(labUnits)};
`;

if (Buffer.byteLength(body) > 900_000) fail(['library.gen.ts が 900KB を超える（phi-guard の 1MB の決まり）。領域ごとに分ける。']);

if (check) {
  let current = '';
  try {
    if (statSync(OUT).isFile()) current = readFileSync(OUT, 'utf8');
  } catch {
    current = '';
  }
  if (current !== body) {
    process.stderr.write('packages/core/src/presets/library.gen.ts が、Playbook の定義と違います。--check を外して作り直してください。\n');
    process.exit(1);
  }
  process.stdout.write(`同じです（定義 ${String(library.presets.length)}・出典 ${String(library.sources.length)}・領域 ${String(library.areas.length)}）。\n`);
} else {
  writeFileSync(OUT, body);
  if (allowed.length > 0) process.stdout.write(`phi-guard の allow を付けた行：${allowed.join('、')}\n`);
  process.stdout.write(`書き出した：定義 ${String(library.presets.length)}・出典 ${String(library.sources.length)}・領域 ${String(library.areas.length)}（Playbook ${commit.slice(0, 7)}・${String(Buffer.byteLength(body))} バイト）\n`);
}
