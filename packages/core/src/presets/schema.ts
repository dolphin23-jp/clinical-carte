// clinical-playbook の packages/core/src/presets/schema.ts から写した（2026-11-22）。carte に合わせて変えたところ：暦日の形（LocalDate）と
// key の形（PATH_KEY_PATTERN）は、Playbook の schema/primitives.ts の代わりに、ここに置いた（暦日は carte の isDay）。定義の形はそのまま。
//
// スコアと診断基準の定義の形（P004a。旧 JOSLER-core の presets/schema.ts から、定義の形はそのままで持ち込んだ。docs/12-scores.md の 2）【案】。
//
// - 同梱の定義（config/clinical-presets/<領域>.yaml）の形。本人が定義を作る機能（旧 T067）は持ち込んでいない。
// - 条件と式は JSON の木で持ち、決まった演算だけを core で計算する（eval・new Function は使わない。CSP の script-src 'self'）。
//   形はここ（zod）で確かめ、項目・まとまり・定義を指しているか、検査の名前と単位、閾値、区分などは parse.ts で確かめる。
// - 項目・選択肢・まとまりの key は、英字で始まる英数字だけ（PATH_KEY_PATTERN。旧 repo の「同期の道のキーの形」）。id は使わない。
// - ビルドのスクリプトは Node の型を外すだけで動かすので、ここと、ここが読み込むものは型を外すだけで動く書き方にする。
import { z } from 'zod';

import { isDay } from '../time/day.ts';

// Playbook の schema/primitives.ts と同じ（暦日 YYYY-MM-DD、英字で始まる英数字だけのキー）
const LocalDate = z.string().refine(isDay, '暦日（YYYY-MM-DD）ではない');
const PATH_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

const isPathKey = (key: string): boolean => PATH_KEY_PATTERN.test(key);

// 比べ方（閾値の条件）
const COMPARE_OPS = ['<', '<=', '>', '>='] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];
// 幅の中の値の選び方（式）：最大、最小、最も新しい日、最も古い日
const PRESET_PICKS = ['max', 'min', 'latest', 'first'] as const;
export type PresetPick = (typeof PRESET_PICKS)[number];
// 条件と式に使える観察の種類（数の項目）。carte では、記録のバイタル・検査値の行から読む（Playbook の config/preset-inputs.yaml の対応を取り込む）
export const PRESET_OBS_KINDS = ['bt', 'sbp', 'dbp', 'hr', 'rr', 'spo2', 'urine', 'intake', 'weight'] as const;
export type PresetObsKind = (typeof PRESET_OBS_KINDS)[number];
export const PRESET_KINDS = ['score', 'criteria'] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];
// 基準の状態：満たす、近い、満たすかもしれない、満たさない
export const CRITERIA_STATES = ['met', 'near', 'possible', 'not-met'] as const;
export type CriteriaState = (typeof CRITERIA_STATES)[number];

// 式（calc・formula）
export type PresetExpr =
  | number
  | { lab: string; unit: string | null; pick?: PresetPick | undefined; from?: number | undefined; to?: number | undefined }
  | { obs: PresetObsKind; pick?: PresetPick | undefined; from?: number | undefined; to?: number | undefined }
  | { age: Record<string, never> }
  | { derived: string; pick?: PresetPick | undefined; from?: number | undefined; to?: number | undefined }
  | { preset: string }
  | { item: string }
  | { add: PresetExpr[] }
  | { sub: [PresetExpr, PresetExpr] }
  | { mul: PresetExpr[] }
  | { div: [PresetExpr, PresetExpr] }
  | { min: PresetExpr[] }
  | { max: PresetExpr[] }
  | { ln: PresetExpr }
  | { log10: PresetExpr }
  | { sqrt: PresetExpr }
  | { pow: [PresetExpr, number] }
  | { clamp: [PresetExpr, PresetExpr, PresetExpr] }
  | { if: PresetCondition; then: PresetExpr; else: PresetExpr };

// 条件（when・suggest・rule・near）。problem は、suggest の中だけ「語がなければ成り立たない」の2択（not で除外の語を書ける）で、
// ほかでは「語がなければ分からない」（docs/06 の11）
export type PresetCondition =
  | { lab: string; unit: string | null; op: CompareOp; value: number; off_boundary?: boolean | undefined }
  | { lab: string; qual: 'positive' | 'negative' }
  | { obs: PresetObsKind; op: CompareOp; value: number }
  | { age: { op: CompareOp; value: number } }
  | { sex: '男性' | '女性' }
  | { problem: string[] }
  | { calc: PresetExpr; op: CompareOp; value: number }
  | { preset: string; state: 'met' | 'near' }
  | { preset: string; op: CompareOp; value: number }
  | { count: string; atLeast: number }
  | { total: { op: CompareOp; value: number } }
  | { item: string }
  | { all: PresetCondition[] }
  | { any: PresetCondition[] }
  | { not: PresetCondition };

const Op = z.enum(COMPARE_OPS);
const Pick = z.enum(PRESET_PICKS);
const ObsKind = z.enum(PRESET_OBS_KINDS);
const Name = z.string().min(1);
const DayOffset = z.number().int().min(-365).max(365);
const window = { pick: Pick.optional(), from: DayOffset.optional(), to: DayOffset.optional() };

// 項目・選択肢・まとまりの key（英字で始まる英数字だけ。id は使わない）
const PresetKey = z
  .string()
  .refine(isPathKey, 'key は英字で始まる英数字だけ（「-」「_」「.」を含めない）')
  .refine((k) => k !== 'id', 'key に id は使わない');

export const PresetExpr: z.ZodType<PresetExpr> = z.lazy(() =>
  z.union([
    z.number(),
    z.strictObject({ lab: Name, unit: Name.nullable(), ...window }),
    z.strictObject({ obs: ObsKind, ...window }),
    z.strictObject({ age: z.strictObject({}) }),
    z.strictObject({ derived: Name, ...window }),
    z.strictObject({ preset: Name }),
    z.strictObject({ item: PresetKey }),
    z.strictObject({ add: z.array(PresetExpr).min(2, 'add は2つ以上の式') }),
    z.strictObject({ sub: z.tuple([PresetExpr, PresetExpr]) }),
    z.strictObject({ mul: z.array(PresetExpr).min(2, 'mul は2つ以上の式') }),
    z.strictObject({ div: z.tuple([PresetExpr, PresetExpr]) }),
    z.strictObject({ min: z.array(PresetExpr).min(2, 'min は2つ以上の式') }),
    z.strictObject({ max: z.array(PresetExpr).min(2, 'max は2つ以上の式') }),
    z.strictObject({ ln: PresetExpr }),
    z.strictObject({ log10: PresetExpr }),
    z.strictObject({ sqrt: PresetExpr }),
    z.strictObject({ pow: z.tuple([PresetExpr, z.number()]) }),
    z.strictObject({ clamp: z.tuple([PresetExpr, PresetExpr, PresetExpr]) }),
    z.strictObject({ if: PresetCondition, then: PresetExpr, else: PresetExpr }),
  ]),
);

export const PresetCondition: z.ZodType<PresetCondition> = z.lazy(() =>
  z.union([
    z.strictObject({ lab: Name, unit: Name.nullable(), op: Op, value: z.number(), off_boundary: z.boolean().optional() }),
    z.strictObject({ lab: Name, qual: z.enum(['positive', 'negative']) }),
    z.strictObject({ obs: ObsKind, op: Op, value: z.number() }),
    z.strictObject({ age: z.strictObject({ op: Op, value: z.number() }) }),
    z.strictObject({ sex: z.enum(['男性', '女性']) }),
    z.strictObject({ problem: z.array(Name).min(1) }),
    z.strictObject({ calc: PresetExpr, op: Op, value: z.number() }),
    z.strictObject({ preset: Name, state: z.enum(['met', 'near']) }),
    z.strictObject({ preset: Name, op: Op, value: z.number() }),
    z.strictObject({ count: PresetKey, atLeast: z.number().int().min(1) }),
    z.strictObject({ total: z.strictObject({ op: Op, value: z.number() }) }),
    z.strictObject({ item: PresetKey }),
    z.strictObject({ all: z.array(PresetCondition).min(1) }),
    z.strictObject({ any: z.array(PresetCondition).min(1) }),
    z.strictObject({ not: PresetCondition }),
  ]),
);

// 段階のある項目の選択肢。when がなければ手で選ぶ（ほかの選択肢に when があれば、ほかがすべて成り立たないときの既定）
const PresetOption = z.strictObject({ key: PresetKey, label: Name, points: z.number(), when: PresetCondition.optional() });
export type PresetOption = z.infer<typeof PresetOption>;
// 2択の項目（あてはまる yes：points 点、あてはまらない no：0点。points を書かなければ 1）と、段階のある項目
const BinaryItem = z.strictObject({ key: PresetKey, label: Name, group: PresetKey.optional(), points: z.number().default(1), when: PresetCondition.optional() });
const OptionItem = z.strictObject({ key: PresetKey, label: Name, group: PresetKey.optional(), options: z.array(PresetOption).min(2, '選択肢は2つ以上') });
export const PresetItem = z.union([BinaryItem, OptionItem]);
export type PresetItem = z.infer<typeof PresetItem>;
// まとまり。sum は点の和、max はあてはまる項目のうち最も大きい点だけ、none は合計に数えない（診断基準の入口・必須・除外の項目の点を、
// 原著の点として見せる合計に混ぜないため。項目の状態・点は変わらず、rule の count・item・calc の { item } はその点をそのまま読む）
const PresetGroup = z.strictObject({ key: PresetKey, label: Name, scoring: z.enum(['sum', 'max', 'none']).default('sum') });
export type PresetGroup = z.infer<typeof PresetGroup>;
// 区分。点数のスコアは min〜max の点（両端を含む）。式のスコアは min 以上 max 未満（最初の区分は min、最後の区分は max を省ける）
export const PresetBand = z.strictObject({ min: z.number().optional(), max: z.number().optional(), label: Name });
export type PresetBand = z.infer<typeof PresetBand>;

// 定義の中身（同梱と本人の定義で同じ）。window は評価の日から何日前までの値を使うか。default_day は評価の日の既定
const common = {
  id: Name,
  name: Name,
  summary: z.string().default(''),
  window: z.number().int().min(0).max(365).default(0),
  default_day: z.enum(['today', 'first']).default('today'),
  suggest: PresetCondition.nullable().default(null),
  items: z.array(PresetItem).default([]),
  groups: z.array(PresetGroup).default([]),
};
export const PRESET_SCORE_SHAPE = {
  ...common,
  kind: z.literal('score'),
  bands: z.array(PresetBand).default([]),
  formula: PresetExpr.optional(),
  digits: z.number().int().min(0).max(6).optional(),
};
export const PRESET_CRITERIA_SHAPE = {
  ...common,
  kind: z.literal('criteria'),
  rule: PresetCondition,
  near: PresetCondition.nullable().default(null),
  alert: z.enum(['met', 'near']).nullable().default(null),
  problem_text: Name.nullable().default(null),
};
export const PresetDefinition = z.discriminatedUnion('kind', [z.strictObject(PRESET_SCORE_SHAPE), z.strictObject(PRESET_CRITERIA_SHAPE)]);
export type PresetDefinition = z.infer<typeof PresetDefinition>;

// 同梱の定義：id は英小文字・数字・「-」、出典 id（CP-…）を1つ以上、confirmed は本人が原著で確かめたか（旧 repo の D-043。Playbook の PD-010）、checked_on は確かめた日
const BUILTIN_PRESET_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PRESET_AREA_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PRESET_SOURCE_ID = /^CP-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const builtin = {
  id: z.string().regex(BUILTIN_PRESET_ID, 'id は英小文字・数字・「-」（a-drop）'),
  sources: z.array(z.string().regex(PRESET_SOURCE_ID, '出典 id は CP- で始める')).min(1, '出典を1つ以上書く'),
  confirmed: z.boolean(),
  checked_on: LocalDate.nullable().default(null),
};
const area = z.string().regex(PRESET_AREA_ID, '領域の id は英小文字・数字・「-」');
// 同梱する JSON の定義（領域の id を持つ）
export const BuiltinPreset = z.discriminatedUnion('kind', [
  z.strictObject({ ...PRESET_SCORE_SHAPE, ...builtin, area }),
  z.strictObject({ ...PRESET_CRITERIA_SHAPE, ...builtin, area }),
]);
export type BuiltinPreset = z.infer<typeof BuiltinPreset>;

export const PresetArea = z.strictObject({ id: area, name: Name });
export type PresetArea = z.infer<typeof PresetArea>;
// 出典。PMID（8桁の数）と出版の年月日は書かない（phi-guard の形。年だけにする）
const PresetSource = z.strictObject({
  id: z.string().regex(PRESET_SOURCE_ID, '出典 id は CP- で始める'),
  title: Name,
  url: z.url({ protocol: /^https$/ }).nullable(),
  checked_on: LocalDate.nullable(),
});
export type PresetSource = z.infer<typeof PresetSource>;

// 1つの YAML のファイル（領域1つ）
export const ClinicalPresetFile = z.strictObject({
  schema_version: z.literal(1),
  area: PresetArea,
  sources: z.array(PresetSource).default([]),
  presets: z.array(z.unknown()).default([]),
});

// 同梱する JSON（ファイルをまとめたもの）。web は同じ関数で読み直す
export const ClinicalPresetLibraryShape = z.strictObject({
  schema_version: z.literal(1),
  areas: z.array(PresetArea),
  sources: z.array(PresetSource),
  presets: z.array(BuiltinPreset),
});
export type ClinicalPresetLibrary = z.infer<typeof ClinicalPresetLibraryShape>;
