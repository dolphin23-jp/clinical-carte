// clinical-playbook の packages/core/src/presets/facts.ts から写した（2026-11-22）。carte に合わせて変えたところ：
// 事実の形（PresetFacts など）と、1日の量・観察の並べ方だけを写した。事実を作る関数（presetFacts。Playbook の session の項目から作る）は写さず、
// carte の記録から作る carte-facts.ts に置き換えた。プロブレムの出どころに「AI のプロブレムリスト」（ai）を足した。
//
// - 検査：同じ正規名・同じ単位の値を、時間の順に持つ（単位は換えない。定義の単位と違えば、計算では分からない）。値は区間で持つ。
// - 観察：定義の { obs: sbp } などが読む値（バイタル・検査値の行を、取り込んだ対応で読む）。
// - 日：位置（pos）の並びで、幅（window）を数える。
import { type Interval, intervalOf, pointInterval } from './interval.ts';
import type { PresetObservationInput } from './inputs.ts';
import type { PresetObsKind } from './schema.ts';

// 検査の1つの値。span は数の値の区間（定性の値は null）、qual は定性の値（数の値は null）、text は文の形、when は日の書き方
// itemId は出どころの行の id（画面から記録へ戻るため。読み方は変えない）
export type LabFactPoint = { text: string; span: Interval | null; qual: string | null; when: string; pos: number; itemId?: string | undefined };
// 同じ正規名・同じ単位の値（時間の順）。written は書いてあった名前（別名を含む）
export type LabFactSeries = { name: string; unit: string | null; written: string[]; points: LabFactPoint[] };
export type ObservationFact = { kind: PresetObsKind; value: number; when: string; pos: number; block: number | null; itemId?: string | undefined };
// 1日の量（尿量・飲水）。blocks は合計した区切りの数（1日全体の記録なら null）
export type DailyAmountFact = { kind: 'urine' | 'intake'; span: Interval; when: string; pos: number; blocks: number | null; itemIds?: readonly string[] | undefined };
export type DerivedFact = { name: string; value: number; text: string; when: string; pos: number };
// problem：記録に書かれた問題の名前、diagnosis：診断（carte では使わない）、ai：AI のプロブレムリストの名前
export type ProblemFact = { source: 'problem' | 'diagnosis' | 'ai'; text: string; itemId?: string | undefined };
// 根拠の文に出す、観察の名前と単位
export type ObservationInfo = { label: string; unit: string };

export type PresetFacts = {
  labs: ReadonlyMap<string, readonly LabFactSeries[]>; // 正規名 → 単位ごとの系列
  observations: readonly ObservationFact[]; // 時間の順
  dailyAmounts: readonly DailyAmountFact[];
  derived: ReadonlyMap<string, readonly DerivedFact[]>;
  observationInfo: ReadonlyMap<PresetObsKind, ObservationInfo>;
  age: number | null;
  sex: '男性' | '女性' | null;
  problems: readonly ProblemFact[];
};

// 1日の量：1日全体の記録があればそれぞれを値に、なければ区切りの合計（区切りに2件あれば小さいほう〜大きいほう）。
// carte の記録には区切りがないので、いつも1日全体の値（block は null）
export function dailyAmountFacts(observations: readonly ObservationFact[]): DailyAmountFact[] {
  const out: DailyAmountFact[] = [];
  for (const kind of ['urine', 'intake'] as const) {
    const byDay = new Map<number, ObservationFact[]>();
    for (const o of observations) if (o.kind === kind) byDay.set(o.pos, [...(byDay.get(o.pos) ?? []), o]);
    for (const [pos, list] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
      const first = list[0];
      if (first === undefined) continue;
      const whole = list.filter((o) => o.block === null);
      if (whole.length > 0) {
        for (const o of whole) out.push({ kind, span: pointInterval(o.value), when: o.when, pos, blocks: null, ...(o.itemId === undefined ? {} : { itemIds: [o.itemId] }) });
        continue;
      }
      const blocks = new Map<number, number[]>();
      for (const o of list) if (o.block !== null) blocks.set(o.block, [...(blocks.get(o.block) ?? []), o.value]);
      const lo = [...blocks.values()].reduce((n, vs) => n + Math.min(...vs), 0);
      const hi = [...blocks.values()].reduce((n, vs) => n + Math.max(...vs), 0);
      const span = blocks.size === 4 ? intervalOf(lo, true, hi, true) : intervalOf(lo, true, Infinity, false);
      const ids = list.flatMap((o) => (o.itemId === undefined ? [] : [o.itemId]));
      if (span !== null) out.push({ kind, span, when: first.when, pos, blocks: blocks.size, ...(ids.length === 0 ? {} : { itemIds: ids }) });
    }
  }
  return out.sort((a, b) => a.pos - b.pos);
}

// 観察を時間の順にする（同じ位置は区切りの順、1日全体は先。同じなら入れた順）
export function sortObservations(list: readonly ObservationFact[]): ObservationFact[] {
  return list
    .map((o, i) => ({ o, i }))
    .sort((a, b) => a.o.pos - b.o.pos || (a.o.block ?? 0) - (b.o.block ?? 0) || a.i - b.i)
    .map((x) => x.o);
}

// 根拠の文に出す、観察の名前と単位（対応の項目の名前と単位）
export function observationInfoOf(observations: readonly PresetObservationInput[]): Map<PresetObsKind, ObservationInfo> {
  return new Map(observations.map((o) => [o.kind, { label: o.item, unit: o.unit }]));
}
