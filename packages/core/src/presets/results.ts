// clinical-playbook の packages/core/src/presets/results.ts から写した（2026-11-22）。carte に合わせて変えたところ：
// (1) 送る項目（scoreItemBody。Playbook の受け渡しパケット）は写していない（carte は結果を送らない・保存しない）。
// (2) 決まらない項目の文を「分からない」から「未入力」にした（CA-059）。未確認の注意の文を、carte の言い方（先生が原典で確かめていない）にした。
//
// 評価の結果の見せ方と、送る項目（score）にするときの文（P004a。旧 JOSLER-core の presets/assessment-rules.ts と cases/assessments.ts の読む側から、
// カードに依らない部分を持ち込んだ。docs/12-scores.md の 4・7）【案】。純関数。
import { CRITERIA_STATE_LABEL, type PresetEvaluation, type PresetItemResult, presetResultText } from './evaluate.ts';
import type { PresetCondition, PresetDefinition, PresetItem } from './schema.ts';

// 項目で選べる答え。2択は「あてはまる（yes）」と「あてはまらない（no）」、段階は選択肢（選択肢の key と名前）。points は選んだときの点
export type PresetAnswerChoice = { key: string; label: string; points: number };
export function presetAnswerChoices(item: PresetItem): PresetAnswerChoice[] {
  if ('options' in item) return item.options.map((o) => ({ key: o.key, label: o.label, points: o.points }));
  return [
    { key: 'yes', label: 'あてはまる', points: item.points },
    { key: 'no', label: 'あてはまらない', points: 0 },
  ];
}

// 診断基準の rule が、点の合計で決めているか（{ total }、または項目の点の和 { calc }）
function ruleSumsPoints(rule: PresetCondition): boolean {
  if ('total' in rule || 'calc' in rule) return true;
  if ('all' in rule) return rule.all.some(ruleSumsPoints);
  if ('any' in rule) return rule.any.some(ruleSumsPoints);
  if ('not' in rule) return ruleSumsPoints(rule.not);
  return false;
}

// 診断基準の合計を、原著の点として見せてよいか：点の合計で決める基準（{ total } か項目の点の和を使う）で、重みのある点（2点以上）の項目があるもの。
// 項目の数で決める基準と、満たした項目の数を使う基準（点はすべて1）は、状態を先に出し、合計は「あてはまる項目の数」として補足に出す（原著の点とは書かない）。
// 入口・必須・除外の項目（まとまり none）の点は数えない（合計に入らない）
export function criteriaUsesTotal(preset: PresetDefinition): boolean {
  if (preset.kind !== 'criteria' || !ruleSumsPoints(preset.rule)) return false;
  const none = new Set(preset.groups.filter((g) => g.scoring === 'none').map((g) => g.key));
  return preset.items.some((i) => (i.group === undefined || !none.has(i.group)) && ('options' in i ? i.options.some((o) => o.points > 1) : i.points > 1));
}

// あてはまる項目の数（まとまり none の項目は数えない。2択は「あてはまる」、段階は点が0より大きい選択肢）
export function appliedCount(preset: Pick<PresetDefinition, 'items' | 'groups'>, e: PresetEvaluation): { min: number; max: number } {
  const none = new Set(preset.groups.filter((g) => g.scoring === 'none').map((g) => g.key));
  let min = 0;
  let max = 0;
  for (const r of e.items) {
    if (r.group !== null && none.has(r.group)) continue;
    const yes = r.kind === 'binary' ? r.state === 'yes' : (r.points ?? 0) > 0;
    if (r.points === null) {
      // 分からない項目：あてはまる可能性があれば最大に数える
      if (r.range.max > 0) max += 1;
      continue;
    }
    if (yes) {
      min += 1;
      max += 1;
    }
  }
  return { min, max };
}

const rangeText = (min: number, max: number) => (min === max ? String(min) : `${String(min)}〜${String(max)}`);

export type ResultView = {
  headline: string; // 結果の文（点数のスコアは「3点（中等症）」、基準は状態）
  lines: string[]; // 補足（分からない項目の数、基準の合計・あてはまる項目の数、未確認の注意）
};

// 結果の見せ方。診断ではなく、判断の補助として出す
export function resultView(preset: PresetDefinition & { unconfirmed?: boolean }, e: PresetEvaluation): ResultView {
  const headline = presetResultText(preset, e);
  const lines: string[] = [];
  if (e.unknownCount > 0) lines.push(`未入力の項目が ${String(e.unknownCount)} つあります（値が記録に入るか、手で選ぶと決まります）。`);
  if (e.criteria !== null) {
    if (e.total !== null && criteriaUsesTotal(preset)) {
      lines.push(`合計 ${rangeText(e.total.min, e.total.max)}点`);
    } else if (preset.items.length > 0) {
      const n = appliedCount(preset, e);
      lines.push(`あてはまる項目 ${rangeText(n.min, n.max)} 個`);
    }
  }
  if (e.unconfirmed) lines.push('この定義は、先生がまだ原典で確かめていません（未確認）。');
  return { headline, lines };
}

export const criteriaStateText = (s: keyof typeof CRITERIA_STATE_LABEL): string => CRITERIA_STATE_LABEL[s];

// 項目の今の答えの文（自動でも手で選んでも）。決まらなければ「未入力」
export function itemAnswerText(item: PresetItem | undefined, r: PresetItemResult): string {
  if (r.state === 'unknown') return '未入力';
  if (r.kind === 'binary') return r.state === 'yes' ? 'あてはまる' : 'あてはまらない';
  return r.option?.label ?? (item !== undefined && 'options' in item ? (item.options.find((o) => o.key === r.state)?.label ?? r.state) : r.state);
}

// 自動の答えの文（手で選んでいるときも、自動ならこう決まる、を見せる）。条件のない項目は「手で選ぶ項目」
export function autoAnswerText(item: PresetItem, r: PresetItemResult): string {
  if (r.auto === null) return '手で選ぶ項目';
  if (r.auto === 'unknown') return '記録の値では決まらない（未入力）';
  if (r.auto === 'yes' || r.auto === 'no') return r.auto === 'yes' ? 'あてはまる' : 'あてはまらない';
  return 'options' in item ? (item.options.find((o) => o.key === r.auto)?.label ?? r.auto) : r.auto;
}

// 項目の点の文（決まっていれば「1点」、幅があれば「0〜1点」）
export function itemPointsText(r: PresetItemResult): string {
  return r.points !== null ? `${String(r.points)}点` : `${rangeText(r.range.min, r.range.max)}点`;
}
