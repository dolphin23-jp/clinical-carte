// スコア・診断基準（段K4。CA-063）の入口。純関数だけ（DOM、ストレージ、通信、時計、乱数に触れない）。
// 計算は clinical-playbook の presets/ から写したもの（evaluate.ts など）。定義は library.gen.ts（scripts/import_presets.mjs が作る。手で直さない）。
export { CRITERIA_STATE_LABEL, evaluatePreset, type PresetAnswers, type PresetEvaluation, type PresetItemResult, type PresetItemSource, presetResultText } from './evaluate.ts';
export type { PresetFacts } from './facts.ts';
export { carteFacts, civilDay, type PresetObservationRow, type PresetProblemName, type PresetRecordInput, whenText } from './carte-facts.ts';
export { PRESET_OBSERVATION_INPUTS, PRESETS, presetSources, presetsByArea, windowText } from './library.ts';
export { PRESET_AREAS, PRESET_DEFINITIONS, PRESET_SOURCES, PRESETS_SOURCE_COMMIT } from './library.gen.ts';
export { evaluateForRecord, latestDay, presetDay, type PresetResult, suggestedPresets } from './panel.ts';
export { type ClinicalPreset, type PresetRegistry, presetRegistry } from './registry.ts';
export { appliedCount, autoAnswerText, criteriaUsesTotal, itemAnswerText, itemPointsText, type PresetAnswerChoice, presetAnswerChoices, type ResultView, resultView } from './results.ts';
export type { CriteriaState, PresetArea, PresetBand, PresetCondition, PresetDefinition, PresetExpr, PresetItem, PresetSource } from './schema.ts';
export { type PresetSuggestion, presetSuggestions } from './suggest.ts';
