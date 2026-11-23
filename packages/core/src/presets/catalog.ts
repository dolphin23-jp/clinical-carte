// 定義を確かめるときと、記録の単位をそろえるときに使う、検査項目の表の最小の形（clinical-playbook の packages/core/src/labs/catalog.ts の
// findLab・labKey・unitKey・sameUnit・isUnitAlias・canonicalUnit を、必要な分だけ写した。2026-11-22）。
//
// - 取り込み（scripts/import_presets.mjs）は、Playbook の config/lab-catalog.yaml からこの形を作って、定義の検査の名前・単位・閾値を確かめる。
// - 画面と試験は、取り込んだ表（library.gen.ts の PRESET_LAB_UNITS）を、この形で使う（ありうる範囲は、観察の対応のものだけを持つ）。
// - carte は単位を換えない。同じ単位の書き方の違い（μ と µ、全角半角、尿量の mL/day など Playbook の unit_aliases）だけをそろえる。

export type PresetCatalogEntry = {
  name: string;
  aliases: readonly string[];
  unit: string | null;
  // 同じ単位の別の書き方（換算しない）
  unitAliases: readonly string[];
  plausible: { min: number; max: number } | null;
};
export type PresetCatalog = { entries: readonly PresetCatalogEntry[] };

export const labKey = (text: string): string => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
// 単位の比較用（μ と µ、全角半角、大文字・小文字、空白）
export const unitKey = (u: string): string => u.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
export const sameUnit = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : unitKey(a) === unitKey(b));

export function findLab(catalog: PresetCatalog, input: string): PresetCatalogEntry | null {
  const key = labKey(input);
  return catalog.entries.find((e) => labKey(e.name) === key || e.aliases.some((a) => labKey(a) === key)) ?? null;
}

// 単位の別名か（カタログの単位そのものは含まない）
export const isUnitAlias = (entry: Pick<PresetCatalogEntry, 'unitAliases'>, unit: string): boolean => entry.unitAliases.some((a) => sameUnit(unit, a));

// 書かれた単位が、カタログの単位と同じ書き方違いか単位の別名なら、カタログの書き方にそろえる。違う単位は、そのまま返す
export function canonicalUnit(entry: Pick<PresetCatalogEntry, 'unit' | 'unitAliases'> | null, raw: string | null): string | null {
  if (entry === null || raw === null || entry.unit === null) return raw;
  return sameUnit(raw, entry.unit) || isUnitAlias(entry, raw) ? entry.unit : raw;
}
