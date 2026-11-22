// clinical-playbook の packages/core/src/presets/suggest.ts から写した（2026-11-22）。carte に合わせて変えたところ：知らせ（presetAlerts）は写していない（carte は知らせを作らない。画面の外への通知もしない。CA-059）。おすすめの計算はそのまま。
//
// おすすめと知らせ（P004a。旧 JOSLER-core の presets/suggest.ts から、本人のきっかけ（旧 T067）を外して持ち込んだ。docs/12-scores.md の 4・6）【案】。
//
// - おすすめ：定義の suggest が成り立つ定義を、自動で分かる項目で計算した途中の結果と一緒に返す。
//   条件は項目の条件と同じ書き方（検査・観察・年齢・性別・プロブレムの語・ほかの定義）。プロブレムの語は matchKey でそろえて探し、
//   英数字だけの語は前後が英字・数字でないときだけ当たる（AF が AFP に当たらない。hasKeyword）。
//   おすすめの条件の中では、プロブレムの語の条件が2択（語がなければ成り立たない）なので、not で除外の語を書ける
//   （{ all: [{ problem: [肺炎] }, { not: { problem: [院内肺炎, 間質性肺炎] } }] }。評価は evaluatePresetCondition の suggest: true）。
// - 画面に出すだけで、プロブレムには足さない。
import { evaluatePreset, evaluatePresetCondition, type PresetEvaluation } from './evaluate.ts';
import type { PresetFacts } from './facts.ts';
import type { ClinicalPreset, PresetRegistry } from './registry.ts';

export type PresetSuggestion = { preset: ClinicalPreset; evidence: string[]; evaluation: PresetEvaluation };

export function presetSuggestions(facts: PresetFacts, registry: PresetRegistry, day: number): PresetSuggestion[] {
  return registry.list.flatMap((p) => {
    if (p.suggest === null) return [];
    const r = evaluatePresetCondition(p.suggest, facts, { day, window: p.window, registry, suggest: true });
    if (r.value !== true) return [];
    return [{ preset: p, evidence: r.evidence, evaluation: evaluatePreset(p, facts, { day, registry, autoOnly: true }) }];
  });
}
