// clinical-playbook の packages/core/src/presets/parse.ts から写した（2026-11-22）。carte に合わせて変えたところ：
// (1) 文の匿名化リンタ（lint）はかけない（Playbook のビルドがかけている。carte では、取り込んだファイルを phi-guard が見る）。8桁以上の数字の並びは、ここでも止める。
// (2) カタログは presets/catalog.ts の最小の形。名前をそろえる形（nameKey）と NFKC は、文全体の NFKC で作る。確かめる規則は、そのまま。
// (3) 取り込み（scripts/import_presets.mjs）と試験だけが使う（画面は、取り込んで確かめた定義を読むだけ）。
//
// スコアと診断基準の定義を確かめる（P004a。旧 JOSLER-core の presets/parse.ts から、確かめる規則を引き継いで持ち込んだ。docs/12-scores.md の 2・8）【案】。
//
// - ビルド（scripts/check-presets.ts）が config/clinical-presets/*.yaml をまとめて確かめ、web が同じ YAML を同じ関数で読み直す。
// - 止めること：
//   - 形（zod）。id・出典 id・領域 id・項目と選択肢とまとまりの key の重なり、知らない出典 id・領域、key の形（英字で始まる英数字だけ。id は使わない）
//   - 検査の名前と単位：検査項目のカタログ（config/lab-catalog.yaml）の正規名（別名は正規名に直す）で、単位がその項目の単位と同じ。閾値がありうる範囲の中。
//     定性の条件（qual）は、正規名で書く（Playbook の項目は数だけなので、定性の値は入れられない。いつも「分からない」になり、手で選ぶ）
//   - 観察の種類（config/preset-inputs.yaml にある種類）と、閾値がありうる範囲の中。年齢は 0〜130。計算値の名前（preset-inputs.yaml にある名前）
//   - 点数のスコアの区分が、とりうる合計をすき間も重なりもなく覆う（どの合計もちょうど1つの区分に入り、合計の入らない区分がない）。
//     式のスコアの区分は min 以上 max 未満で、端がつながる。式のスコアは digits が要る
//   - 基準の count がまとまりを指し、atLeast がそのまとまりの項目の数以下。知らない項目・まとまり・定義を指さない。定義どうしの参照に輪がない。
//     count・total・item の条件は rule・near（item と count は式でも）だけで使う（項目の条件・おすすめからは使わない）
//   - 段階のある項目で、when のない選択肢は、ほかに when のある選択肢があれば1つまで（既定）
//   - 式の演算の引数の数（形で確かめる）、日の幅（from ≤ to）
//   - confirmed: true の定義には、確かめた日（checked_on）が要る
//   - 数は7桁まで（小数は6桁まで。指数の形にしない）。文（名前・説明・項目・選択肢・まとまり・区分・足す文・おすすめの語）に匿名化リンタをかけ、
//     error と warn があれば止める（lint を渡したときだけ。web で読み直すときは渡さない）。8桁以上の数字の並びも止める
// - 旧 repo にあった「閾値が入力用の選択肢の境目にあるか」の検査は、持ち込んでいない（Playbook の検査値は数で入れるので、選択肢がない）。
//   定義の `off_boundary` は、形だけ受け取り、使わない。
// - ビルドのスクリプトは Node の型を外すだけで動かすので、ここと、ここが読み込むものは型を外すだけで動く書き方にする。
import type { z } from 'zod';

import type { PresetCatalog } from './catalog.ts';
import type { PresetInputs } from './inputs.ts';
import {
  type BuiltinPreset,
  type ClinicalPresetLibrary,
  ClinicalPresetFile,
  ClinicalPresetLibraryShape,
  type PresetBand,
  type PresetCondition,
  type PresetDefinition,
  type PresetExpr,
  type PresetItem,
  type PresetKind,
} from './schema.ts';

// 名前を比べる形（前後の空白を除き、NFKC にして、英字は小文字）と、7桁を超える数字の並び（Playbook の text/normalize.ts と同じ）
const nameKey = (s: string): string => s.trim().normalize('NFKC').toLowerCase();
const LONG_DIGIT_RUN = /\d{8,}/u;

export type PresetIssue = { path: string; message: string };
export type PresetParseResult<T> = { ok: true; value: T } | { ok: false; issues: PresetIssue[] };

// ---- zod の誤りを場所つきの文にする ----
type ZIssue = z.core.$ZodIssue;

// 1つの枝の「形の違い」の大きさ（選んだ形の key がない・余分な key がある）。小さい枝を、書いた人が意図した形とみなす
function branchMismatch(issues: readonly ZIssue[]): number {
  let n = 0;
  for (const i of issues) {
    if (i.path.length === 0 && i.code === 'invalid_type') n += 100;
    else if (i.path.length === 0 && i.code === 'unrecognized_keys') n += i.keys.length;
    else if (i.path.length === 1 && i.code === 'invalid_type' && i.message.endsWith('received undefined')) n += 1;
  }
  return n;
}

// zod の誤りを平らにする。いくつかの形のどれか（条件・式・項目）で読めないときは、書いた形に最も近い枝の誤りを出す
export function presetZodIssues(issues: readonly ZIssue[], prefix: readonly PropertyKey[] = []): PresetIssue[] {
  const out: PresetIssue[] = [];
  for (const i of issues) {
    const path = [...prefix, ...i.path];
    if (i.code === 'invalid_union' && i.errors.length > 0) {
      const ranked = i.errors.map((b, k) => ({ b, k, score: branchMismatch(b) })).sort((x, y) => x.score - y.score || x.b.length - y.b.length || x.k - y.k);
      const best = ranked[0];
      // 形の違いのない枝が1つ、または形の違いの最も小さい枝が1つだけなら、その枝の誤りを出す（同じくらい違う枝がいくつもあれば、どの形か分からない）
      const clear = best !== undefined && best.score < 100 && (best.score === 0 || ranked[1]?.score !== best.score);
      if (best !== undefined && clear) {
        out.push(...presetZodIssues(best.b, path));
        continue;
      }
      out.push({ path: path.map(String).join('.'), message: '条件・式・項目の形として読めない（docs/12-scores.md の 2）' });
      continue;
    }
    out.push({ path: path.map(String).join('.'), message: i.message });
  }
  return out;
}

// ---- 検査の項目の表（名前 → 単位ごとの、ありうる範囲） ----
export type LabVariant = { unit: string | null; plausible: { min: number; max: number } | null };
export type PresetLabTable = { names: ReadonlyMap<string, LabVariant[]>; aliases: ReadonlyMap<string, string> };

// 検査項目のカタログ（config/lab-catalog.yaml）から作る
export function presetLabTable(catalog: PresetCatalog): PresetLabTable {
  const names = new Map<string, LabVariant[]>();
  const aliases = new Map<string, string>();
  for (const e of catalog.entries) {
    const list = names.get(e.name) ?? [];
    if (!list.some((x) => x.unit === e.unit)) list.push({ unit: e.unit, plausible: e.plausible });
    names.set(e.name, list);
    for (const a of e.aliases) if (!aliases.has(nameKey(a))) aliases.set(nameKey(a), e.name);
  }
  return { names, aliases };
}

export type PresetCheckEnv = {
  labs: PresetLabTable;
  inputs: PresetInputs; // 観察の種類 → 項目の対応と、計算値の名前
  presetKinds: ReadonlyMap<string, PresetKind>; // 参照してよい定義の id → 種類（state の参照が基準だけを指すかを見る）
};

// ---- 数と文 ----
const MAX_ABS = 10_000_000;
function numberProblem(n: number): string | null {
  if (!Number.isFinite(n) || Math.abs(n) >= MAX_ABS) return '数は7桁まで';
  const t = String(n);
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(t)) return '数は小数6桁までの形で書く（指数の形にしない）';
  return null;
}

function textProblems(text: string): string[] {
  return LONG_DIGIT_RUN.test(text.normalize('NFKC')) ? ['文の数字は7桁まで'] : [];
}

// ---- 1つの定義 ----
type Where = 'when' | 'suggest' | 'rule' | 'formula';
type Checker = {
  env: PresetCheckEnv;
  preset: PresetDefinition;
  items: ReadonlyMap<string, PresetItem>;
  groupSizes: ReadonlyMap<string, number>;
  refs: Set<string>; // 計算で参照するほかの定義（輪を見る。おすすめの参照は含めない）
  add: (path: string, message: string) => void;
};

function checkNumber(ch: Checker, path: string, n: number) {
  const p = numberProblem(n);
  if (p !== null) ch.add(path, p);
}

// 検査の名前と単位
function labVariant(ch: Checker, path: string, name: string, unit: string | null): LabVariant | null {
  const variants = ch.env.labs.names.get(name);
  if (variants === undefined) {
    const canonical = ch.env.labs.aliases.get(nameKey(name)) ?? [...ch.env.labs.names.keys()].find((n) => nameKey(n) === nameKey(name));
    ch.add(`${path}.lab`, canonical === undefined ? `検査「${name}」が検査項目のカタログ（config/lab-catalog.yaml）にない` : `検査は正規名で書く（${name} ではなく ${canonical}）`);
    return null;
  }
  const v = variants.find((x) => x.unit === unit);
  if (v === undefined) ch.add(`${path}.unit`, `${name} の単位は ${variants.map((x) => x.unit ?? 'null（単位なし）').join('・')}（${unit ?? 'null'} でない）`);
  return v ?? null;
}

function checkThreshold(ch: Checker, path: string, name: string, v: LabVariant, value: number) {
  if (v.plausible !== null && (value < v.plausible.min || value > v.plausible.max))
    ch.add(`${path}.value`, `${name} の閾値 ${String(value)} がありうる範囲（${String(v.plausible.min)}〜${String(v.plausible.max)}）の外`);
}

function checkWindow(ch: Checker, path: string, e: { from?: number | undefined; to?: number | undefined }) {
  if (e.from !== undefined && e.to !== undefined && e.from > e.to) ch.add(path, '日の幅は from ≤ to');
}

function checkExpr(ch: Checker, e: PresetExpr, path: string, where: Where): void {
  if (typeof e === 'number') {
    checkNumber(ch, path, e);
    return;
  }
  if ('lab' in e) {
    labVariant(ch, path, e.lab, e.unit);
    checkWindow(ch, path, e);
    return;
  }
  if ('obs' in e) {
    checkWindow(ch, path, e);
    return;
  }
  if ('derived' in e) {
    if (!ch.env.inputs.derived.has(e.derived)) ch.add(`${path}.derived`, `計算値「${e.derived}」はない（${[...ch.env.inputs.derived].join('・')}）`);
    checkWindow(ch, path, e);
    return;
  }
  if ('age' in e) return;
  if ('preset' in e) {
    checkPresetRef(ch, `${path}.preset`, e.preset, where);
    return;
  }
  if ('item' in e) {
    if (where === 'when' || where === 'suggest') ch.add(path, '項目の値（item）は rule・near・式だけで使う');
    else if (!ch.items.has(e.item)) ch.add(`${path}.item`, `項目「${e.item}」がない`);
    return;
  }
  if ('add' in e) {
    e.add.forEach((x, i) => {
      checkExpr(ch, x, `${path}.add.${String(i)}`, where);
    });
    return;
  }
  if ('sub' in e) {
    e.sub.forEach((x, i) => {
      checkExpr(ch, x, `${path}.sub.${String(i)}`, where);
    });
    return;
  }
  if ('mul' in e) {
    e.mul.forEach((x, i) => {
      checkExpr(ch, x, `${path}.mul.${String(i)}`, where);
    });
    return;
  }
  if ('div' in e) {
    e.div.forEach((x, i) => {
      checkExpr(ch, x, `${path}.div.${String(i)}`, where);
    });
    return;
  }
  if ('min' in e) {
    e.min.forEach((x, i) => {
      checkExpr(ch, x, `${path}.min.${String(i)}`, where);
    });
    return;
  }
  if ('max' in e) {
    e.max.forEach((x, i) => {
      checkExpr(ch, x, `${path}.max.${String(i)}`, where);
    });
    return;
  }
  if ('ln' in e) {
    checkExpr(ch, e.ln, `${path}.ln`, where);
    return;
  }
  if ('log10' in e) {
    checkExpr(ch, e.log10, `${path}.log10`, where);
    return;
  }
  if ('sqrt' in e) {
    checkExpr(ch, e.sqrt, `${path}.sqrt`, where);
    return;
  }
  if ('pow' in e) {
    checkExpr(ch, e.pow[0], `${path}.pow.0`, where);
    checkNumber(ch, `${path}.pow.1`, e.pow[1]);
    return;
  }
  if ('clamp' in e) {
    e.clamp.forEach((x, i) => {
      checkExpr(ch, x, `${path}.clamp.${String(i)}`, where);
    });
    return;
  }
  checkCondition(ch, e.if, `${path}.if`, where);
  checkExpr(ch, e.then, `${path}.then`, where);
  checkExpr(ch, e.else, `${path}.else`, where);
}

function checkPresetRef(ch: Checker, path: string, id: string, where: Where, byState = false) {
  const kind = ch.env.presetKinds.get(id);
  if (kind === undefined) ch.add(path, `定義「${id}」がない`);
  else {
    // state（met・near）は診断基準の状態。点数のスコアには状態がなく、いつも「分からない」になるので、点で比べる書き方（op と value）を求める
    if (byState && kind !== 'criteria') ch.add(path, `定義「${id}」は点数・式のスコアで、state は診断基準だけに使う（{ preset: ${id}, op: '>=', value: 2 } のように値で比べる）`);
    if (where !== 'suggest') ch.refs.add(id);
  }
}

function checkCondition(ch: Checker, c: PresetCondition, path: string, where: Where): void {
  if ('all' in c) {
    c.all.forEach((x, i) => {
      checkCondition(ch, x, `${path}.all.${String(i)}`, where);
    });
    return;
  }
  if ('any' in c) {
    c.any.forEach((x, i) => {
      checkCondition(ch, x, `${path}.any.${String(i)}`, where);
    });
    return;
  }
  if ('not' in c) {
    checkCondition(ch, c.not, `${path}.not`, where);
    return;
  }
  if ('lab' in c) {
    if ('qual' in c) {
      // 定性の値は、Playbook の項目に入れられない（数だけ）。カタログにない名前（定性だけの項目）も、そのまま書ける。別名で書くことだけを止める
      const canonical = ch.env.labs.aliases.get(nameKey(c.lab));
      if (canonical !== undefined && !ch.env.labs.names.has(c.lab)) ch.add(`${path}.lab`, `検査は正規名で書く（${c.lab} ではなく ${canonical}）`);
      return;
    }
    checkNumber(ch, `${path}.value`, c.value);
    const v = labVariant(ch, path, c.lab, c.unit);
    if (v !== null) checkThreshold(ch, path, c.lab, v, c.value);
    return;
  }
  if ('obs' in c) {
    checkNumber(ch, `${path}.value`, c.value);
    const input = ch.env.inputs.observations.get(c.obs);
    if (input === undefined) ch.add(`${path}.obs`, `観察の種類「${c.obs}」の対応が config/preset-inputs.yaml にない`);
    else if (c.value < input.plausible.min || c.value > input.plausible.max)
      ch.add(`${path}.value`, `観察（${c.obs}）の閾値 ${String(c.value)} がありうる範囲（${String(input.plausible.min)}〜${String(input.plausible.max)} ${input.unit}）の外`);
    return;
  }
  if ('age' in c) {
    checkNumber(ch, `${path}.age.value`, c.age.value);
    if (c.age.value < 0 || c.age.value > 130) ch.add(`${path}.age.value`, '年齢の閾値は 0〜130');
    return;
  }
  if ('sex' in c || 'problem' in c) return;
  if ('calc' in c) {
    checkNumber(ch, `${path}.value`, c.value);
    checkExpr(ch, c.calc, `${path}.calc`, where);
    return;
  }
  if ('preset' in c) {
    if ('value' in c) checkNumber(ch, `${path}.value`, c.value);
    checkPresetRef(ch, `${path}.preset`, c.preset, where, 'state' in c);
    return;
  }
  if ('count' in c) {
    if (where !== 'rule' && where !== 'formula') ch.add(path, '数の条件（count）は rule・near・式だけで使う');
    const size = ch.groupSizes.get(c.count);
    if (size === undefined) ch.add(`${path}.count`, `まとまり「${c.count}」がない`);
    else if (c.atLeast > size) ch.add(`${path}.atLeast`, `atLeast（${String(c.atLeast)}）がまとまり「${c.count}」の項目の数（${String(size)}）より多い`);
    return;
  }
  if ('total' in c) {
    checkNumber(ch, `${path}.total.value`, c.total.value);
    if (where !== 'rule') ch.add(path, '合計の条件（total）は rule・near だけで使う');
    return;
  }
  if (where === 'when' || where === 'suggest') ch.add(path, '項目の条件（item）は rule・near・式だけで使う');
  else if (!ch.items.has(c.item)) ch.add(`${path}.item`, `項目「${c.item}」がない`);
}

// とりうる合計（点数のスコア）。多すぎれば null
const MAX_TOTALS = 20_000;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
function reachableTotals(preset: PresetDefinition): number[] | null {
  const valuesOf = (item: PresetItem) => ('options' in item ? item.options.map((o) => o.points) : [0, item.points]);
  const combine = (a: readonly number[], b: readonly number[], f: (x: number, y: number) => number): number[] | null => {
    const s = new Set<number>();
    for (const x of a) for (const y of b) s.add(r6(f(x, y)));
    return s.size > MAX_TOTALS ? null : [...s];
  };
  const groups = new Map(preset.groups.map((g) => [g.key, g]));
  let total: number[] | null = [0];
  for (const item of preset.items) {
    if (item.group !== undefined && groups.has(item.group)) continue;
    total = total === null ? null : combine(total, valuesOf(item), (x, y) => x + y);
  }
  for (const g of preset.groups) {
    if (g.scoring === 'none') continue; // 合計に数えない（0 点として足すのと同じ）
    const members = preset.items.filter((i) => i.group === g.key);
    let v: number[] | null = members.length === 0 ? [0] : valuesOf(members[0] as PresetItem);
    for (const m of members.slice(1)) v = v === null ? null : combine(v, valuesOf(m), g.scoring === 'max' ? Math.max : (x, y) => x + y);
    total = total === null || v === null ? null : combine(total, v, (x, y) => x + y);
  }
  return total === null ? null : total.sort((a, b) => a - b);
}

function checkPointBands(ch: Checker, bands: readonly PresetBand[]) {
  if (bands.length === 0) return;
  let ok = true;
  for (const [i, b] of bands.entries()) {
    const p = `bands.${String(i)}`;
    const prev = bands[i - 1];
    if (b.min === undefined || b.max === undefined) ch.add(p, '点数のスコアの区分は min と max を書く');
    else if (b.min > b.max) ch.add(p, '区分の min は max 以下');
    else if (prev?.max !== undefined && !(prev.max < b.min)) ch.add(p, '区分は小さい順に、重ならずに並べる');
    else continue;
    ok = false;
  }
  if (!ok) return;
  const totals = reachableTotals(ch.preset);
  if (totals === null) {
    ch.add('bands', 'とりうる合計が多すぎて確かめられない');
    return;
  }
  const inBand = (x: number) => bands.findIndex((b) => b.min !== undefined && b.max !== undefined && x >= b.min && x <= b.max);
  const missing = totals.filter((t) => inBand(t) < 0);
  if (missing.length > 0) ch.add('bands', `とりうる合計（${missing.slice(0, 5).map(String).join('・')}${missing.length > 5 ? ' など' : ''}点）がどの区分にも入らない（すき間）`);
  bands.forEach((b, i) => {
    if (!totals.some((t) => b.min !== undefined && b.max !== undefined && t >= b.min && t <= b.max)) ch.add(`bands.${String(i)}`, `区分（${b.label}）に入るとりうる合計がない`);
  });
}

function checkFormulaBands(ch: Checker, bands: readonly PresetBand[]) {
  bands.forEach((b, i) => {
    const p = `bands.${String(i)}`;
    if (b.min === undefined && i > 0) ch.add(p, '式の区分の min を省けるのは最初の区分だけ');
    if (b.max === undefined && i < bands.length - 1) ch.add(p, '式の区分の max を省けるのは最後の区分だけ');
    if (b.min !== undefined && b.max !== undefined && !(b.min < b.max)) ch.add(p, '式の区分は min 以上 max 未満（min < max）');
    const prev = bands[i - 1];
    if (prev !== undefined && prev.max !== undefined && b.min !== undefined && prev.max !== b.min) ch.add(p, '式の区分は端がつながる（前の区分の max が次の区分の min）');
  });
}

// 1つの定義を見る：決まりの誤り（場所は定義の中の道）と、計算で参照するほかの定義（輪を見る。おすすめの参照は含めない）
function inspectPreset(preset: PresetDefinition, env: PresetCheckEnv): { issues: PresetIssue[]; refs: string[] } {
  const issues: PresetIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const items = new Map<string, PresetItem>();
  const groupSizes = new Map<string, number>();
  preset.groups.forEach((g, i) => {
    if (groupSizes.has(g.key)) add(`groups.${String(i)}.key`, `まとまりの key（${g.key}）が重なる`);
    groupSizes.set(g.key, 0);
  });
  preset.items.forEach((item, i) => {
    const p = `items.${String(i)}`;
    if (items.has(item.key)) add(`${p}.key`, `項目の key（${item.key}）が重なる`);
    else if (groupSizes.has(item.key)) add(`${p}.key`, `項目の key（${item.key}）がまとまりの key と重なる`);
    items.set(item.key, item);
    if (item.group !== undefined) {
      const n = groupSizes.get(item.group);
      if (n === undefined) add(`${p}.group`, `まとまり「${item.group}」がない`);
      else groupSizes.set(item.group, n + 1);
    }
  });
  const ch: Checker = { env, preset, items, groupSizes, refs: new Set(), add };
  const texts: { path: string; text: string }[] = [
    { path: 'name', text: preset.name },
    { path: 'summary', text: preset.summary },
  ];
  preset.groups.forEach((g, i) => texts.push({ path: `groups.${String(i)}.label`, text: g.label }));
  if (preset.suggest !== null) checkCondition(ch, preset.suggest, 'suggest', 'suggest');
  const words = (c: PresetCondition | null, path: string) => {
    if (c === null) return;
    if ('problem' in c) c.problem.forEach((w, i) => texts.push({ path: `${path}.problem.${String(i)}`, text: w }));
    else if ('all' in c)
      c.all.forEach((x, i) => {
        words(x, `${path}.all.${String(i)}`);
      });
    else if ('any' in c)
      c.any.forEach((x, i) => {
        words(x, `${path}.any.${String(i)}`);
      });
    else if ('not' in c) words(c.not, `${path}.not`);
  };
  words(preset.suggest, 'suggest');
  preset.items.forEach((item, i) => {
    const p = `items.${String(i)}`;
    texts.push({ path: `${p}.label`, text: item.label });
    if ('options' in item) {
      const keys = new Set<string>();
      item.options.forEach((o, oi) => {
        const op = `${p}.options.${String(oi)}`;
        if (keys.has(o.key)) add(`${op}.key`, `選択肢の key（${o.key}）が重なる`);
        keys.add(o.key);
        checkNumber(ch, `${op}.points`, o.points);
        texts.push({ path: `${op}.label`, text: o.label });
        if (o.when !== undefined) checkCondition(ch, o.when, `${op}.when`, 'when');
      });
      const unconditioned = item.options.filter((o) => o.when === undefined).length;
      if (unconditioned < item.options.length && unconditioned > 1) add(`${p}.options`, 'when のない選択肢（既定）は、ほかに when のある選択肢があれば1つまで');
    } else {
      checkNumber(ch, `${p}.points`, item.points);
      if (item.when !== undefined) checkCondition(ch, item.when, `${p}.when`, 'when');
    }
  });
  if (preset.kind === 'score') {
    preset.bands.forEach((b, i) => {
      texts.push({ path: `bands.${String(i)}.label`, text: b.label });
      if (b.min !== undefined) checkNumber(ch, `bands.${String(i)}.min`, b.min);
      if (b.max !== undefined) checkNumber(ch, `bands.${String(i)}.max`, b.max);
    });
    if (preset.formula === undefined) {
      if (preset.items.length === 0) add('items', '点数のスコアは項目を1つ以上持つ（式のスコアは formula を書く）');
      if (preset.digits !== undefined) add('digits', 'digits は式のスコア（formula）だけに書く');
      checkPointBands(ch, preset.bands);
    } else {
      if (preset.digits === undefined) add('digits', '式のスコアは digits（見せる小数の桁）を書く');
      checkExpr(ch, preset.formula, 'formula', 'formula');
      checkFormulaBands(ch, preset.bands);
    }
  } else {
    checkCondition(ch, preset.rule, 'rule', 'rule');
    if (preset.near !== null) checkCondition(ch, preset.near, 'near', 'rule');
    if (preset.problem_text !== null) texts.push({ path: 'problem_text', text: preset.problem_text });
  }
  for (const t of texts) for (const m of textProblems(t.text)) add(t.path, m);
  return { issues, refs: [...ch.refs] };
}

// 1つの定義の決まり
export function checkPresetDefinition(preset: PresetDefinition, env: PresetCheckEnv): PresetIssue[] {
  return inspectPreset(preset, env).issues;
}

// 参照の輪（見つけた輪ごとに、輪の id の並び）
export function presetCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const state = new Map<string, 'open' | 'done'>();
  const cycles: string[][] = [];
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, 'open');
    stack.push(id);
    for (const next of graph.get(id) ?? []) {
      const s = state.get(next);
      if (s === 'open') cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (s === undefined && graph.has(next)) visit(next);
    }
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of graph.keys()) if (!state.has(id)) visit(id);
  return cycles;
}

export type ParseClinicalPresetsOptions = {
  catalog: PresetCatalog;
  inputs: PresetInputs;
};

// 同梱の定義（ファイルをまとめたもの、または同梱する JSON）を確かめる
export function parseClinicalPresets(raw: unknown, opts: ParseClinicalPresetsOptions): PresetParseResult<ClinicalPresetLibrary> {
  const r = ClinicalPresetLibraryShape.safeParse(raw);
  if (!r.success) return { ok: false, issues: presetZodIssues(r.error.issues) };
  const lib = r.data;
  const issues: PresetIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const areaIds = new Set<string>();
  lib.areas.forEach((a, i) => {
    if (areaIds.has(a.id)) add(`areas.${String(i)}.id`, `領域の id（${a.id}）が重なる`);
    areaIds.add(a.id);
    for (const m of textProblems(a.name)) add(`areas.${String(i)}.name`, m);
  });
  const sourceIds = new Set<string>();
  lib.sources.forEach((s, i) => {
    if (sourceIds.has(s.id)) add(`sources.${String(i)}.id`, `出典の id（${s.id}）が重なる`);
    sourceIds.add(s.id);
    if (LONG_DIGIT_RUN.test(`${s.title} ${s.url ?? ''}`)) add(`sources.${String(i)}`, '出典に8桁以上の数字（PMID など）を書かない');
  });
  const kinds = new Map<string, PresetKind>();
  lib.presets.forEach((p, i) => {
    if (kinds.has(p.id)) add(`presets.${String(i)}.id`, `定義の id（${p.id}）が重なる`);
    else kinds.set(p.id, p.kind);
  });
  const env: PresetCheckEnv = { labs: presetLabTable(opts.catalog), inputs: opts.inputs, presetKinds: kinds };
  const graph = new Map<string, string[]>();
  lib.presets.forEach((p: BuiltinPreset, i) => {
    const pp = `presets.${String(i)}`;
    if (!areaIds.has(p.area)) add(`${pp}.area`, `領域「${p.area}」がない`);
    p.sources.forEach((s, si) => {
      if (!sourceIds.has(s)) add(`${pp}.sources.${String(si)}`, `出典「${s}」が sources にない`);
    });
    if (p.confirmed && p.checked_on === null) add(`${pp}.confirmed`, 'confirmed: true にするのは、本人が原著で確かめてから（checked_on を書く）');
    const seen = inspectPreset(p, env);
    for (const x of seen.issues) add(`${pp}.${x.path}`, `${p.id}：${x.message}`);
    if (!graph.has(p.id)) graph.set(p.id, seen.refs);
  });
  for (const cycle of presetCycles(graph)) {
    const at = lib.presets.findIndex((p) => p.id === cycle[0]);
    add(`presets.${String(at)}`, `定義の参照が輪になっている（${cycle.join(' → ')}）`);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: lib };
}

// ---- ファイルをまとめる（ビルド） ----
export type PresetFileInput = { name: string; raw: unknown };
export type MergedClinicalPresets = { value: unknown; locate: (path: string) => string };

// 領域ごとのファイル（<領域の id>.yaml）を1つにまとめる。定義には領域の id を足す（ファイルには書かない）。
// locate は、まとめたものの中の道（presets.12.items.0）を、ファイルの中の道（infection.yaml:presets.3.items.0）に戻す
export function mergeClinicalPresetFiles(files: readonly PresetFileInput[]): PresetParseResult<MergedClinicalPresets> {
  const issues: PresetIssue[] = [];
  const areas: unknown[] = [];
  const sources: unknown[] = [];
  const presets: unknown[] = [];
  const presetAt: { file: string; index: number }[] = [];
  const sourceAt: { file: string; index: number }[] = [];
  const areaAt: string[] = [];
  for (const f of files) {
    const r = ClinicalPresetFile.safeParse(f.raw);
    if (!r.success) {
      for (const i of presetZodIssues(r.error.issues)) issues.push({ path: `${f.name}:${i.path}`, message: i.message });
      continue;
    }
    if (f.name !== `${r.data.area.id}.yaml`) issues.push({ path: `${f.name}:area.id`, message: `ファイル名と領域の id（${r.data.area.id}）が違う` });
    areas.push(r.data.area);
    areaAt.push(f.name);
    r.data.sources.forEach((s, i) => {
      sources.push(s);
      sourceAt.push({ file: f.name, index: i });
    });
    r.data.presets.forEach((p, i) => {
      if (p !== null && typeof p === 'object' && !Array.isArray(p) && Object.hasOwn(p, 'area'))
        issues.push({ path: `${f.name}:presets.${String(i)}.area`, message: '定義に area は書かない（ファイルの area を使う）' });
      presets.push(p !== null && typeof p === 'object' && !Array.isArray(p) ? { ...(p as Record<string, unknown>), area: r.data.area.id } : p);
      presetAt.push({ file: f.name, index: i });
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  const locate = (path: string): string => {
    const [head, n, ...rest] = path.split('.');
    const i = Number(n);
    const tail = rest.length > 0 ? `.${rest.join('.')}` : '';
    if (head === 'presets' && presetAt[i] !== undefined) return `${presetAt[i].file}:presets.${String(presetAt[i].index)}${tail}`;
    if (head === 'sources' && sourceAt[i] !== undefined) return `${sourceAt[i].file}:sources.${String(sourceAt[i].index)}${tail}`;
    if (head === 'areas' && areaAt[i] !== undefined) return `${areaAt[i]}:area${tail}`;
    return path;
  };
  return { ok: true, value: { value: { schema_version: 1, areas, sources, presets }, locate } };
}
