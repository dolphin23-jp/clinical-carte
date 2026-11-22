// スコアと診断基準の計算に使う事実を、carte の記録から作る（段K4。CA-063）。Playbook の presets/facts.ts の presetFacts の代わり。純関数。
//
// - 患者：年齢は評価の日の年齢の概算（ageNow）。性別は male → 男性、female → 女性、other → 分からない（null）。
// - 日の位置：暦の通し日（UNIX のエポックの日を 0）。窓（window）は暦の日数で数える。根拠の文の日は、日時と、入院なら病日（入院の日が第1病日。前は「入院N日前」）。
// - 検査：本人が外した行・日時のない行・AI が読んだ数で書かれた字に見つからないもの（unseen）は読まない。名前は正規名（なければ書かれた名前）。
//   単位は換えない：書かれた単位が、取り込んだ表の単位と同じ書き方違いか、同じ単位の別の書き方（Playbook の unit_aliases）なら、表の単位にそろえる。
//   違う単位は、別の系列のまま（定義の単位と違えば「単位が違う」で未入力）。
//   単位の書かれていない値は、その項目の単位の書き方が1つだけのとき（名前の表 LAB_NAMES。段K3 の基準範囲と同じ）だけ、その単位の値として読み、
//   根拠に「単位の記載なし」と出す。尿量のように単位が要る項目（unitRequired）は読まない（1回量と1日量を取り違えないため。Playbook の PA-061）。
//   不等号つきの値（<0.1 など）は、片側の区間として読む（閾値をまたげば分からない。Playbook の D-042）。数でない値は、定性の値の候補として持つ。
// - 観察：{ obs: sbp } などは、取り込んだ対応（名前と単位）の行の値を読む（不等号つき・範囲の外の値は読まない）。同じ種類・同じ日に、
//   バイタルと検査値の両方があれば、バイタルを使う（Playbook と同じ）。尿量は1日の量（mL/日）として書かれたものだけ。
// - プロブレム：記録に書かれた問題の名前と、AI のプロブレムリストの名前（呼ぶ側が、いまの問題・活動中のものを渡す）。語があれば成り立ち、
//   なければ「分からない」（おすすめの条件だけは、なければ成り立たない）。
// - 計算値（eGFR など）は作らない（定義の中では未入力になる）。
import { LAB_NAMES } from '../labs/catalog.gen.ts';
import type { Comparator } from '../labs/read.ts';
import { ageNow } from '../record/headline.ts';
import type { EncounterKind, Sex } from '../record/schema.ts';
import { daysBetween } from '../time/datetime.ts';
import { canonicalUnit, isUnitAlias, labKey, sameUnit } from './catalog.ts';
import { dailyAmountFacts, type LabFactSeries, type ObservationFact, observationInfoOf, type PresetFacts, type ProblemFact, sortObservations } from './facts.ts';
import { type Interval, intervalOf, pointInterval } from './interval.ts';
import { PRESET_OBSERVATION_INPUTS } from './library.ts';
import { PRESET_LAB_UNITS } from './library.gen.ts';

/** 記録の測定値の1行（画面の Observation と同じ形の、使う欄だけ） */
export interface PresetObservationRow {
  readonly id: string;
  readonly at: string | null;
  readonly atApprox?: string | null | undefined;
  readonly name: string | null;
  readonly nameRaw: string;
  readonly kind: 'lab' | 'vital' | null;
  readonly value: number | null;
  readonly comparator: Comparator | null;
  readonly valueText: string;
  readonly unit: string | null;
  readonly excluded?: boolean | undefined;
  readonly unseen?: boolean | undefined;
}

export interface PresetProblemName {
  readonly name: string;
  /** problem：記録に書かれた問題の名前、ai：AI のプロブレムリスト */
  readonly source: 'problem' | 'ai';
}

export interface PresetRecordInput {
  readonly patient: { readonly age: number; readonly ageOn: string; readonly sex: Sex };
  readonly encounter: { readonly kind: EncounterKind; readonly start: string };
  readonly observations: readonly PresetObservationRow[];
  readonly problems: readonly PresetProblemName[];
}

/** 暦の通し日（UNIX のエポックの日を 0。時計は使わない） */
export const civilDay = (day: string): number => Math.round(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000);

/** 根拠に出す日の書き方：日時と、入院なら病日 */
export function whenText(encounter: PresetRecordInput['encounter'], at: string, approx = false): string {
  const shown = `${at.slice(0, 10)}${at.length > 10 ? ` ${at.slice(11, 16)}` : ''}${approx ? 'ごろ' : ''}`;
  if (encounter.kind !== 'inpatient') return shown;
  const n = daysBetween(encounter.start.slice(0, 10), at.slice(0, 10)) + 1;
  return `${shown}・${n >= 1 ? `第${String(n)}病日` : `入院${String(1 - n)}日前`}`;
}

/** 不等号つきの値の区間（片側。端は書かれたとおり） */
function spanOf(value: number, comparator: Comparator | null): Interval | null {
  switch (comparator) {
    case null:
      return pointInterval(value);
    case '<':
      return intervalOf(-Infinity, false, value, false);
    case '<=':
      return intervalOf(-Infinity, false, value, true);
    case '>':
      return intervalOf(value, false, Infinity, false);
    case '>=':
      return intervalOf(value, true, Infinity, false);
  }
}

const unitTable = new Map(PRESET_LAB_UNITS.map((u) => [labKey(u.name), u]));
const oneUnit = new Map(LAB_NAMES.map((e) => [labKey(e.name), e.units.length === 1 ? e.units[0] ?? null : null]));
const obsByName = new Map(PRESET_OBSERVATION_INPUTS.map((o) => [labKey(o.item), o]));

/** 読む行か（外した・日時のない・字に見つからない数は読まない） */
const readable = (o: PresetObservationRow): o is PresetObservationRow & { at: string } => o.at !== null && o.excluded !== true && o.unseen !== true;

/** 記録から、評価の日（YYYY-MM-DD）の事実を作る */
export function carteFacts(input: PresetRecordInput, evalDay: string): PresetFacts {
  const labs = new Map<string, LabFactSeries[]>();
  const observed: { fact: ObservationFact; from: 'lab' | 'vital' }[] = [];
  for (const o of input.observations) {
    if (!readable(o)) continue;
    const name = o.name ?? o.nameRaw.trim();
    if (name === '') continue;
    const pos = civilDay(o.at);
    const when = whenText(input.encounter, o.at, typeof o.atApprox === 'string' && o.atApprox !== '');
    const entry = unitTable.get(labKey(name)) ?? null;
    const raw = o.unit === null || o.unit.trim() === '' ? null : o.unit.trim();
    // 単位の書かれていない値：書き方が1つだけの項目なら、その単位として読む（単位が要る項目は読まない）
    const single = oneUnit.get(labKey(name)) ?? null;
    const assumed: string | null = raw === null && entry !== null && entry.unit !== null && !entry.unitRequired && single !== null && sameUnit(single, entry.unit) ? entry.unit : null;
    if (raw === null && entry?.unitRequired === true) continue;
    const unit = assumed ?? canonicalUnit(entry, raw);
    const list = labs.get(name) ?? [];
    labs.set(name, list);
    let series = list.find((s) => s.unit === unit);
    if (series === undefined) {
      series = { name, unit, written: [], points: [] };
      list.push(series);
    }
    const written = o.nameRaw.trim();
    if (written !== '' && !series.written.includes(written)) series.written.push(written);
    const note = assumed === null ? '' : '（単位の記載なし）';
    if (o.value !== null && Number.isFinite(o.value)) {
      const span = spanOf(o.value, o.comparator);
      series.points.push({ text: `${o.comparator ?? ''}${o.valueText}${note}`, span, qual: null, when, pos, itemId: o.id });
    } else if (o.valueText.trim() !== '') {
      series.points.push({ text: o.valueText.trim(), span: null, qual: o.valueText.trim(), when, pos, itemId: o.id });
    }

    // 観察の対応にある項目（不等号のない数で、単位が合い、ありうる範囲の中のときだけ）
    const obs = obsByName.get(labKey(name));
    if (obs === undefined || o.value === null || o.comparator !== null) continue;
    const unitOk = raw === null ? entry?.unitRequired !== true : sameUnit(raw, obs.unit) || (entry !== null && isUnitAlias(entry, raw));
    if (unitOk && o.value >= obs.plausible.min && o.value <= obs.plausible.max) {
      observed.push({ fact: { kind: obs.kind, value: o.value, when, pos, block: null, itemId: o.id }, from: o.kind === 'vital' ? 'vital' : 'lab' });
    }
  }
  // 同じ観察の種類・同じ日に、バイタルと検査値の両方があるときは、バイタルを使う
  const vitalAt = new Set(observed.filter((x) => x.from === 'vital').map((x) => `${x.fact.kind}@${String(x.fact.pos)}`));
  const observations = observed.filter((x) => x.from === 'vital' || !vitalAt.has(`${x.fact.kind}@${String(x.fact.pos)}`)).map((x) => x.fact);
  for (const list of labs.values()) for (const s of list) s.points = s.points.map((p, i) => ({ p, i })).sort((a, b) => a.p.pos - b.p.pos || a.i - b.i).map((x) => x.p);
  const sorted = sortObservations(observations);
  const problems: ProblemFact[] = input.problems.flatMap((p) => (p.name.trim() === '' ? [] : [{ source: p.source, text: p.name.trim() }]));
  const sex = input.patient.sex === 'male' ? '男性' : input.patient.sex === 'female' ? '女性' : null;
  return {
    labs,
    observations: sorted,
    dailyAmounts: dailyAmountFacts(sorted),
    derived: new Map(),
    observationInfo: observationInfoOf(PRESET_OBSERVATION_INPUTS),
    age: ageNow(input.patient.age, input.patient.ageOn, evalDay),
    sex,
    problems,
  };
}
