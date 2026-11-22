// スコアと診断基準の一覧（段K4。CA-063）：取り込んだ定義（library.gen.ts。scripts/import_presets.mjs が Playbook から作る。手で直さない）を、
// id で引ける一覧にする。並びは、領域の順・同じ領域の中は Playbook のファイルの順（registry.ts）。純関数。
import { PRESET_AREAS, PRESET_DEFINITIONS, PRESET_OBSERVATIONS, PRESET_SOURCES } from './library.gen.ts';
import type { PresetObservationInput } from './inputs.ts';
import { type ClinicalPreset, presetRegistry, type PresetRegistry } from './registry.ts';
import type { PresetArea, PresetSource } from './schema.ts';

export const PRESETS: PresetRegistry = presetRegistry({ areas: PRESET_AREAS, presets: PRESET_DEFINITIONS });

/** 観察の対応（{ obs: sbp } が読む項目）。取り込んだ表から */
export const PRESET_OBSERVATION_INPUTS: readonly PresetObservationInput[] = PRESET_OBSERVATIONS;

/** 定義の出典（出典 id の順。表にない id は飛ばす。取り込みが、表にない id を止めている） */
export function presetSources(preset: Pick<ClinicalPreset, 'sources'>): PresetSource[] {
  return preset.sources.flatMap((id) => PRESET_SOURCES.filter((s) => s.id === id));
}

/** 領域ごとの定義（画面の「ほかのスコア・基準を見る」） */
export function presetsByArea(registry: PresetRegistry = PRESETS): { area: PresetArea; presets: ClinicalPreset[] }[] {
  return registry.areas.map((area) => ({ area, presets: registry.list.filter((p) => p.area === area.id) })).filter((g) => g.presets.length > 0);
}

/** 定義の窓（評価の日から何日前までの値を読むか）の説明 */
export function windowText(preset: Pick<ClinicalPreset, 'window'>): string {
  return preset.window === 0 ? '評価の日の値だけを読みます。' : `評価の日と、その ${String(preset.window)} 日前までの値を読みます（暦の日数）。`;
}
