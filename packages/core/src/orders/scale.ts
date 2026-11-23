// 段K11：指示簿のスケールのテンプレと、体重からの流量の計算（CA-075。2026-11-23 の本人の決定）。
// - テンプレ（ノルアドレナリンのスケール・インスリンの可変量メニューなど）は、**先生が自分の施設の内容で作る**（濃度・単位・段・閾値）。
//   carte に、患者に付かずに1つずつ持つ（患者の情報は書かない）。作成者（AI・エージェント）は、テンプレに臨床の数を書かない（見本もない）
// - 流量は、テンプレの数と先生が入れた体重から、**決定論で計算するだけ**（判定しない：多い・少ない・範囲の外などは言わない）。式を画面に出す
// - 単位が合わないときは、計算しない（推し量って換算しない）。体重あたりの単位で体重がないときも、計算しない
//
// 純関数（DOM・保存・通信・時計・乱数に触れない）。
import { z } from 'zod';

import { findShapes } from '../guard/shapes.ts';

// ---------------------------------------------------------------------------
// 単位

/** 濃度の量の単位（「2 mg を 50 mL に」の mg の欄） */
export const SCALE_AMOUNT_UNITS = ['μg', 'mg', 'g', '単位', 'mEq', 'mmol'] as const;
export type ScaleAmountUnit = (typeof SCALE_AMOUNT_UNITS)[number];

/** 投与量の単位（段の「量」の欄の単位） */
export const SCALE_DOSE_UNITS = [
  'μg/kg/min',
  'μg/kg/h',
  'mg/kg/min',
  'mg/kg/h',
  'μg/min',
  'μg/h',
  'mg/min',
  'mg/h',
  'g/h',
  '単位/h',
  '単位/kg/h',
  'mEq/h',
  'mmol/h',
  'mL/h',
] as const;
export type ScaleDoseUnit = (typeof SCALE_DOSE_UNITS)[number];

type Mass = ScaleAmountUnit | 'mL';
interface DoseParts {
  readonly mass: Mass;
  readonly perKg: boolean;
  readonly per: 'min' | 'h';
}

/** 投与量の単位を、量・体重あたりか・時間に分ける */
export function doseParts(unit: ScaleDoseUnit): DoseParts {
  const m = /^(μg|mg|g|単位|mEq|mmol|mL)(\/kg)?\/(min|h)$/u.exec(unit);
  // 表の単位は、すべてこの形（試験が確かめる）
  if (m === null) throw new Error('単位の形が表と合いません');
  return { mass: m[1] as Mass, perKg: m[2] !== undefined, per: m[3] as 'min' | 'h' };
}

/** 同じ次元の中での倍率（μg を 1 として）。単位・mEq・mmol は、それぞれ別の次元で、互いに換算しない */
const MASS_FACTOR: Readonly<Partial<Record<Mass, { readonly dim: string; readonly factor: number }>>> = {
  μg: { dim: 'mass', factor: 1 },
  mg: { dim: 'mass', factor: 1000 },
  g: { dim: 'mass', factor: 1_000_000 },
  単位: { dim: 'unit', factor: 1 },
  mEq: { dim: 'meq', factor: 1 },
  mmol: { dim: 'mmol', factor: 1 },
};

// ---------------------------------------------------------------------------
// テンプレの形

export const SCALE_NAME_MAX = 40;
export const SCALE_DRUG_MAX = 60;
export const SCALE_STEP_LABEL_MAX = 40;
export const SCALE_STEP_NOTE_MAX = 80;
export const SCALE_NOTE_MAX = 300;
export const SCALE_STEPS_MAX = 30;
/** 数の欄の上限（打ち間違いで桁が増えたものを受けない。臨床の閾値ではない） */
const NUMBER_MAX = 10_000_000;

const Positive = z.number().positive().max(NUMBER_MAX);

/** 段（「段1」「血糖 201〜250」など。名前は先生が書く）。量は投与量の単位で。量を書かない段（「医師コール」など）は null */
export const ScaleStep = z.strictObject({
  label: z.string().max(SCALE_STEP_LABEL_MAX),
  dose: z.number().min(0).max(NUMBER_MAX).nullable(),
  note: z.string().max(SCALE_STEP_NOTE_MAX),
});
export type ScaleStep = z.infer<typeof ScaleStep>;

/** テンプレの中身（先生の施設の内容。患者の情報を書かない） */
export const ScaleTemplateBody = z.strictObject({
  name: z.string().trim().min(1).max(SCALE_NAME_MAX),
  drug: z.string().max(SCALE_DRUG_MAX),
  /** 濃度：amount（amountUnit）を volume mL に。投与量が mL/h のときは、なくてよい */
  amount: Positive.nullable(),
  amountUnit: z.enum(SCALE_AMOUNT_UNITS),
  volume: Positive.nullable(),
  doseUnit: z.enum(SCALE_DOSE_UNITS),
  steps: z.array(ScaleStep).max(SCALE_STEPS_MAX),
  note: z.string().max(SCALE_NOTE_MAX),
});
export type ScaleTemplateBody = z.infer<typeof ScaleTemplateBody>;

/** 保存したテンプレ */
export const ScaleTemplate = z.object({ id: z.string(), body: ScaleTemplateBody, createdAt: z.string(), updatedAt: z.string() });
export type ScaleTemplate = z.infer<typeof ScaleTemplate>;

/** テンプレの字の確かめ：識別情報の形（電話・メール・郵便番号・長い数字）があれば断る（患者の情報は書かない決まり。CA-079） */
export function templateProblem(body: ScaleTemplateBody): 'shape' | null {
  const texts = [body.name, body.drug, body.note, ...body.steps.flatMap((s) => [s.label, s.note])];
  return texts.some((t) => findShapes(t).length > 0) ? 'shape' : null;
}

// ---------------------------------------------------------------------------
// 流量の計算

export const RATE_PROBLEMS = ['no_dose', 'no_weight', 'no_concentration', 'unit_mismatch'] as const;
export type RateProblem = (typeof RATE_PROBLEMS)[number];
export const RATE_PROBLEM_NAMES: Readonly<Record<RateProblem, string>> = {
  no_dose: 'この段に量が書かれていないので、計算していません',
  no_weight: '体重あたりの量なので、体重を入れると計算します',
  no_concentration: '濃度（量と mL）が入っていないので、計算していません',
  unit_mismatch: '濃度の単位と投与量の単位が合わないので、計算していません（換算を推し量りません）',
};

export type RateResult =
  | {
      readonly ok: true;
      /** 計算した流量（mL/h。丸めていない） */
      readonly mlPerHour: number;
      /** 画面に出す流量（小数第2位までに四捨五入） */
      readonly shown: number;
      readonly rounded: boolean;
      /** 式（画面に出す。濃度の行と、流量の行） */
      readonly formula: readonly string[];
    }
  | { readonly ok: false; readonly problem: RateProblem };

/** 数を、画面に出す字にする（計算の端数のぶれを除く。丸めない） */
export function numberText(n: number): string {
  return String(Number(n.toPrecision(10)));
}

/**
 * 体重あたり・時間あたりの投与量から、流量（mL/h）を計算する。
 * 流量 = 量 ×（体重 kg：体重あたりのとき）×（60：分あたりのとき）÷ 濃度（投与量の単位にそろえた、1 mL あたりの量）
 */
export function infusionRate(input: { readonly dose: number | null; readonly doseUnit: ScaleDoseUnit; readonly weightKg: number | null; readonly amount: number | null; readonly amountUnit: ScaleAmountUnit; readonly volume: number | null }): RateResult {
  const parts = doseParts(input.doseUnit);
  if (input.dose === null || !Number.isFinite(input.dose)) return { ok: false, problem: 'no_dose' };
  const weight = input.weightKg;
  if (parts.perKg && (weight === null || !Number.isFinite(weight) || weight <= 0)) return { ok: false, problem: 'no_weight' };
  const perHour = parts.per === 'min' ? 60 : 1;
  const kg = parts.perKg ? (weight ?? 0) : 1;
  const doseLine = `${numberText(input.dose)} ${input.doseUnit}${parts.perKg ? ` × ${numberText(kg)} kg` : ''}${parts.per === 'min' ? ' × 60 min/h' : ''}`;
  const finish = (value: number, formula: string[]): RateResult => {
    const shown = Math.round(value * 100) / 100;
    const rounded = Math.abs(shown - value) > 1e-9;
    formula.push(`${formula.pop() ?? ''} = ${numberText(rounded ? value : shown)} mL/h${rounded ? `（画面では小数第2位までに四捨五入して ${numberText(shown)} mL/h）` : ''}`);
    return { ok: true, mlPerHour: value, shown, rounded, formula };
  };
  // 投与量が mL/h なら、そのまま（濃度は使わない）
  if (parts.mass === 'mL') return finish(input.dose * kg * perHour, [doseLine]);
  const doseMass = MASS_FACTOR[parts.mass];
  const amountMass = MASS_FACTOR[input.amountUnit];
  if (input.amount === null || input.volume === null || !(input.amount > 0) || !(input.volume > 0)) return { ok: false, problem: 'no_concentration' };
  if (doseMass === undefined || amountMass === undefined || doseMass.dim !== amountMass.dim) return { ok: false, problem: 'unit_mismatch' };
  // 1 mL あたりの量（濃度の単位で）と、投与量の単位にそろえた量
  const perMl = input.amount / input.volume;
  const perMlInDose = (perMl * amountMass.factor) / doseMass.factor;
  const unitText = parts.mass;
  const lines = [
    `濃度：${numberText(input.amount)} ${input.amountUnit} ÷ ${numberText(input.volume)} mL = ${numberText(perMl)} ${input.amountUnit}/mL${input.amountUnit === unitText ? '' : `（= ${numberText(perMlInDose)} ${unitText}/mL）`}`,
    `流量：${doseLine} ÷ ${numberText(perMlInDose)} ${unitText}/mL`,
  ];
  return finish((input.dose * kg * perHour) / perMlInDose, lines);
}

/** テンプレの段ごとの流量（体重は先生が入れたもの。null なら、体重あたりの段は計算しない） */
export function scaleRates(template: ScaleTemplateBody, weightKg: number | null): { readonly step: ScaleStep; readonly rate: RateResult }[] {
  return template.steps.map((step) => ({
    step,
    rate: infusionRate({ dose: step.dose, doseUnit: template.doseUnit, weightKg, amount: template.amount, amountUnit: template.amountUnit, volume: template.volume }),
  }));
}

/** 濃度の字（「2 mg / 50 mL」。入っていなければ「濃度の記載なし」） */
export function concentrationText(template: Pick<ScaleTemplateBody, 'amount' | 'amountUnit' | 'volume'>): string {
  return template.amount === null || template.volume === null ? '濃度の記載なし' : `${numberText(template.amount)} ${template.amountUnit} / ${numberText(template.volume)} mL`;
}
