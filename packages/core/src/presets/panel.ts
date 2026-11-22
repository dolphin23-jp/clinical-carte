// いまの記録に出すスコアと診断基準（段K4。CA-063）。純関数：AI を使わず、取り込んだ定義と記録の値から、決定論で計算する。
//
// - 評価の日：この受診の、日時のある測定値のいちばん新しい日（なければ、呼ぶ側が渡した「記録の上で最後」の日、それもなければ受診の始まりの日）。
//   定義の default_day が first（入院時の評価など）なら、受診の始まりの日。値を読む幅は、定義の窓（window）のまま。
// - 出す順：プロブレムの名前（記録に書かれた名前と AI のプロブレムリスト）から勧められる定義（Playbook の presetSuggestions。定義の suggest）を先に。
//   ほかの定義は、画面が領域ごとの一覧から開く（presetsByArea）。
// - 手で選ぶ答え（answers）は、画面のメモリだけにある（保存しない・送らない）。ここは受け取って計算に入れるだけ。
import { carteFacts, civilDay, type PresetRecordInput } from './carte-facts.ts';
import { evaluatePreset, type PresetAnswers, type PresetEvaluation } from './evaluate.ts';
import type { PresetFacts } from './facts.ts';
import { PRESETS } from './library.ts';
import type { ClinicalPreset, PresetRegistry } from './registry.ts';
import { presetSuggestions } from './suggest.ts';

/** 評価の日の既定（YYYY-MM-DD）：この受診の測定値のいちばん新しい日 */
export function latestDay(input: PresetRecordInput, fallback: string | null = null): string {
  let latest: string | null = null;
  for (const o of input.observations) {
    if (o.at === null || o.excluded === true) continue;
    const d = o.at.slice(0, 10);
    if (latest === null || d > latest) latest = d;
  }
  return latest ?? fallback?.slice(0, 10) ?? input.encounter.start.slice(0, 10);
}

/** 定義ごとの評価の日（first は受診の始まりの日） */
export function presetDay(preset: Pick<ClinicalPreset, 'default_day'>, input: PresetRecordInput, latest: string): string {
  return preset.default_day === 'first' ? input.encounter.start.slice(0, 10) : latest;
}

/** 日ごとの事実（同じ日は作り直さない） */
function factsCache(input: PresetRecordInput): (day: string) => PresetFacts {
  const cache = new Map<string, PresetFacts>();
  return (day) => {
    const hit = cache.get(day);
    if (hit !== undefined) return hit;
    const facts = carteFacts(input, day);
    cache.set(day, facts);
    return facts;
  };
}

export interface PresetResult {
  readonly preset: ClinicalPreset;
  /** 評価の日（YYYY-MM-DD） */
  readonly day: string;
  readonly evaluation: PresetEvaluation;
  /** 勧められた理由（プロブレムの語など。勧められていなければ空） */
  readonly why: readonly string[];
}

/** 1つの定義を、評価の日に計算する（手で選んだ答えは画面のメモリから） */
export function evaluateForRecord(preset: ClinicalPreset, input: PresetRecordInput, latest: string, answers: PresetAnswers = {}, registry: PresetRegistry = PRESETS): PresetResult {
  const day = presetDay(preset, input, latest);
  const evaluation = evaluatePreset(preset, carteFacts(input, day), { day: civilDay(day), answers, registry });
  return { preset, day, evaluation, why: [] };
}

/** プロブレムの名前から勧められる定義（定義の並びの順）。結果は記録の値だけで計算したもの（手で選ぶ項目は未入力） */
export function suggestedPresets(input: PresetRecordInput, latest: string, registry: PresetRegistry = PRESETS): PresetResult[] {
  const factsOn = factsCache(input);
  return presetSuggestions(factsOn(latest), registry, civilDay(latest)).map((s) => {
    const day = presetDay(s.preset, input, latest);
    const evaluation = day === latest ? s.evaluation : evaluatePreset(s.preset, factsOn(day), { day: civilDay(day), registry, autoOnly: true });
    return { preset: s.preset, day, evaluation, why: s.evidence };
  });
}
