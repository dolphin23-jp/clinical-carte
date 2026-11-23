// clinical-playbook の packages/core/src/presets/inputs.ts から写した（2026-11-22）。carte に合わせて変えたところ：
// YAML の文字ではなく、取り込みのスクリプトが読んだ値（unknown）を受け取る（core は YAML を読まない）。カタログは presets/catalog.ts の最小の形。
// 確かめる規則はそのまま。
//
// スコア・診断基準の入力の対応（config/preset-inputs.yaml。P004a）：定義の `{ obs: sbp }` などの「観察の種類」が、session のどの項目（名前と単位）を読むか、
// 定義の `{ derived: eGFR }` で使える計算値の名前。純関数：読むだけで、何も書かない。
//
// - 旧 JOSLER-core では、観察（バイタルや尿量・体重）は別の記録で、カードに日ごと・区切りごとに持っていた。Playbook にはその記録がないので、
//   バイタル（検査項目のカタログの vital）や、本人が入れた項目の名前と単位で読む。対応は、旧 repo の観察の入力範囲（名前・単位・ありうる範囲）を写した。
// - カタログ（config/lab-catalog.yaml）にある項目は、カタログの単位とありうる範囲を使う（ここに書かない）。カタログにない項目（体重、尿量、飲水）は、
//   ここに単位とありうる範囲を書く。範囲の外の値は、計算に使わない（旧 repo の observationNumber と同じ）。
import { z } from 'zod';

import { isDay } from '../time/day.ts';
import { findLab, type PresetCatalog, sameUnit } from './catalog.ts';
import { PRESET_OBS_KINDS, type PresetObsKind } from './schema.ts';

const LocalDate = z.string().refine(isDay, '暦日（YYYY-MM-DD）ではない');

const Plausible = z.strictObject({ min: z.number(), max: z.number() });
const Observation = z.strictObject({
  kind: z.enum(PRESET_OBS_KINDS),
  item: z.string().min(1),
  unit: z.string().min(1),
  // カタログにない項目だけ書く。あれば、カタログの項目の単位とありうる範囲を使う
  plausible: Plausible.optional(),
});

export const PresetInputsFile = z.strictObject({
  schema_version: z.literal(1),
  checked_on: LocalDate,
  note: z.string().min(1),
  observations: z.array(Observation).min(1),
  // 定義の { derived: 名前 } に書ける計算値の名前（計算値は P004c。いまは session から作らないので、定義の中では「分からない」になる）
  derived: z.array(z.string().min(1)),
});
export type PresetInputsFile = z.infer<typeof PresetInputsFile>;

export type PresetObservationInput = {
  kind: PresetObsKind;
  // 画面と根拠に出す名前（カタログの正規名。カタログにない項目は、ここに書いた名前）
  item: string;
  unit: string;
  plausible: { min: number; max: number };
  // カタログにある項目か
  inCatalog: boolean;
};

export type PresetInputs = {
  file: PresetInputsFile;
  observations: ReadonlyMap<PresetObsKind, PresetObservationInput>;
  derived: ReadonlySet<string>;
};

export class PresetInputsError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`スコア・診断基準の入力の対応が正しくありません：\n${problems.join('\n')}`);
    this.name = 'PresetInputsError';
    this.problems = problems;
  }
}

// 形（zod）のあとの、カタログとの突き合わせ。見つけたものを、すべて集めて返す
export function presetInputsProblems(file: PresetInputsFile, catalog: PresetCatalog): string[] {
  const problems: string[] = [];
  const kinds = new Set<string>();
  for (const o of file.observations) {
    if (kinds.has(o.kind)) problems.push(`観察の種類が重なっている：${o.kind}`);
    kinds.add(o.kind);
    const entry = findLab(catalog, o.item);
    if (entry !== null) {
      if (entry.name !== o.item) problems.push(`観察（${o.kind}）の項目は正規名で書く：${o.item} ではなく ${entry.name}`);
      else if (!sameUnit(entry.unit, o.unit)) problems.push(`観察（${o.kind}）の単位がカタログと違う：${o.item} は ${entry.unit ?? '単位なし'}（${o.unit} でない）`);
      if (o.plausible !== undefined) problems.push(`観察（${o.kind}）：カタログにある項目（${o.item}）には、ありうる範囲を書かない（カタログの範囲を使う）`);
      if (entry.plausible === null) problems.push(`観察（${o.kind}）：カタログの項目（${o.item}）に、ありうる範囲がない`);
    } else if (o.plausible === undefined) {
      problems.push(`観察（${o.kind}）：カタログにない項目（${o.item}）には、ありうる範囲を書く`);
    } else if (!(o.plausible.min < o.plausible.max)) {
      problems.push(`観察（${o.kind}）：ありうる範囲の下限が上限より小さくない`);
    }
  }
  for (const k of PRESET_OBS_KINDS) if (!kinds.has(k)) problems.push(`観察の種類（${k}）の対応がない`);
  const seen = new Set<string>();
  for (const d of file.derived) {
    if (seen.has(d)) problems.push(`計算値の名前が重なっている：${d}`);
    seen.add(d);
  }
  return problems;
}

export function parsePresetInputs(raw: unknown, catalog: PresetCatalog): PresetInputs {
  const parsed = PresetInputsFile.safeParse(raw);
  if (!parsed.success) throw new PresetInputsError(parsed.error.issues.map((i) => `${i.path.join('.')}：${i.message}`));
  const file = parsed.data;
  const problems = presetInputsProblems(file, catalog);
  if (problems.length > 0) throw new PresetInputsError(problems);
  const observations = new Map<PresetObsKind, PresetObservationInput>();
  for (const o of file.observations) {
    const entry = findLab(catalog, o.item);
    const plausible = entry?.plausible ?? o.plausible;
    // presetInputsProblems が、ありうる範囲があることを確かめている
    if (plausible === undefined) throw new PresetInputsError([`観察（${o.kind}）：ありうる範囲がない`]);
    observations.set(o.kind, { kind: o.kind, item: o.item, unit: o.unit, plausible: { min: plausible.min, max: plausible.max }, inCatalog: entry !== null });
  }
  return { file, observations, derived: new Set(file.derived) };
}
