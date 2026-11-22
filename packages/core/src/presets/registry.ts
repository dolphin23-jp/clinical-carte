// clinical-playbook の packages/core/src/presets/registry.ts から写した（2026-11-22）。carte に合わせて変えたところ：なし。
//
// 定義の一覧（P004a。旧 JOSLER-core の presets/registry.ts から、本人の定義（旧 T067）を外して持ち込んだ。docs/12-scores.md の 5）【案】。
//
// - 同梱の定義（ビルドで確かめた config/clinical-presets/*.yaml）を、id で引けるようにする。
// - 並びは決まった順：領域（areas の順）、同じ領域の中はファイルに書いた順。
// - unconfirmed は、本人がまだ原著で確かめていないもの（confirmed: false。画面に「未確認」と出す）。
import type { BuiltinPreset, ClinicalPresetLibrary, PresetArea, PresetDefinition } from './schema.ts';

export type ClinicalPreset = PresetDefinition & {
  area: string;
  unconfirmed: boolean;
  // 出典 id（CP-…）、確かめたか、確かめた日
  sources: readonly string[];
  confirmed: boolean;
  checked_on: string | null;
};
export type PresetRegistry = {
  areas: readonly PresetArea[];
  list: readonly ClinicalPreset[];
  get: (id: string) => ClinicalPreset | null;
};

function builtinPreset(p: BuiltinPreset): ClinicalPreset {
  return { ...p, unconfirmed: !p.confirmed };
}

// 同じ id があれば先のものを使う（ビルドが id の重なりを止めているので、ふつうは重ならない）
export function presetRegistry(library: Pick<ClinicalPresetLibrary, 'areas' | 'presets'>): PresetRegistry {
  const areaOrder = new Map(library.areas.map((a, i) => [a.id, i]));
  const rank = (p: ClinicalPreset) => areaOrder.get(p.area) ?? library.areas.length;
  const byId = new Map<string, ClinicalPreset>();
  for (const p of library.presets.map(builtinPreset)) if (!byId.has(p.id)) byId.set(p.id, p);
  const list = [...byId.values()]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p);
  return { areas: library.areas, list, get: (id) => byId.get(id) ?? null };
}
