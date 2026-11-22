// clinical-playbook の packages/core/src/presets/evaluate.ts から写した（2026-11-22）。carte に合わせて変えたところ：
// (1) 語の探し方（hasKeyword）は presets/keyword.ts の写しを使う。(2) プロブレムの出どころに「AI のプロブレムリスト」（ai）を足した（根拠の文の名前だけ）。
// (3) 結果が決まらないときの短い文を「分からない」から「未入力」にした（CA-059：値がない項目は「未入力」）。計算の規則・3値の論理・比べ方は、そのまま。
//
// スコアと診断基準の計算（P004a。旧 JOSLER-core の presets/evaluate.ts から、計算の規則はそのままで持ち込んだ。docs/12-scores.md の 4）【案】。
//
// - 純関数。カードの事実（presetFacts）・評価の日・手で選んだ答えから、項目ごとの答え・合計・値・区分・基準の状態・根拠を出す。
//   時計・乱数・通信は使わない。式は JSON の木を決まった演算で計算する（eval は使わない）。
// - 答えは3つ：成り立つ（true）・成り立たない（false）・分からない（null）。組み合わせは Kleene の3値の論理
//   （all は1つでも成り立たなければ成り立たない、any は1つでも成り立てば成り立つ、not は逆。分からないは分からない）。
// - 値の幅：評価の日から window 日前までの日の値（日は時間の順の位置。入院N日前は 1−N。外来は暦の通し日）。幅の中に値が複数あれば、
//   どれか1つが確かに成り立てば「成り立つ」、すべてが確かに成り立たなければ「成り立たない」、ほかは「分からない」（幅の中の最も悪い値で比べるのと同じ）。
//   値がなければ分からない。範囲の値は両端を含まない間、<x・>x は片側の間として比べ、閾値をまたげば分からない（D-042）。
// - 検査は、定義の単位の系列だけを使う（単位は換えない）。違う単位の値しかなければ「単位が違う」で分からない。
// - プロブレムの語の条件は、語があれば成り立つ、なければ分からない（プロブレムにないことは、ないことの証拠にしない）。
//   ただしおすすめ・きっかけ（suggest）の条件の中だけは2択（なければ成り立たない）で、not で除外の語を書ける。カード全体の語を見る
//   （別々のプロブレムに、含める語と除外の語があれば除外になる）。
// - 項目：手で選んだ答え（answers）が自動の値より勝つ。2択の項目は、条件が成り立てば yes（points 点）、成り立たなければ no（0点）。
//   段階のある項目は、成り立つ選択肢のうち点の最も大きいものを選ぶ（それより点の大きい分からない選択肢があれば、分からない）。
//   ほかの選択肢がすべて成り立たなければ、when のない選択肢（既定）を選ぶ。条件のない項目は、手で選ぶまで分からない。
// - 合計：分からない項目は「とりうる点の最小〜最大」で数え、合計を「最小〜最大」で出す。まとまり（max）は、最も大きい点だけ。
//   まとまり（none）は合計に数えない（rule の count・item・式の { item } は、項目の点をそのまま読む）。
//   区分は、最小と最大が同じ区分に入るときだけ出す。式のスコアは区間で計算し（interval.ts）、値の区間が1つの区分に入るときだけ区分を出す。
// - 基準の状態：満たす（rule が成り立つ）→ 近い（near が成り立つ）→ 満たすかもしれない（rule が分からない）→ 満たさない、の順に決める。
//   near のない基準は、「1つ以上の項目があてはまっていて、あと1項目があてはまれば満たす」を近いとする（分からない項目は、点の最も小さい
//   答えとして、あてはまらない項目を1つずつ、点の最も大きい答えに変えて rule を見る）。ただし、分からない項目を最も小さい点にした
//   rule がすでに成り立つ（入口・必須・除外の答えがないだけ）なら近いにしない（満たすかもしれない）。
// - ほかの定義の参照は、同じ事実・同じ日で、その定義の window を使って計算する（手で選んだ答えは nestedAnswers にあれば使う）。輪は分からない。
// - 根拠は日本語の短い文（「BUN 28（第1病日）」「SpO2 89%（第1病日 6〜12時）」「WBC 12000〜15000（第2病日）」）。
// - 記録の答え（P015a。docs/18-alerts.md）：自動の条件（when）を持たない2択の「手で選ぶ」項目に、記録（確認・問診の答え、所見、背景など）から決まる答えを
//   入れられる（recordAnswers。決めるのは records/answers.ts の対応表。ここは受け取って入れるだけ）。手で選んだ答えは、記録の答えに勝つ。
//   段階のある項目と、when のある項目には入れない（定義の読み方を変えない）。
import { hasKeyword } from './keyword.ts';
import type { DailyAmountFact, LabFactPoint, ObservationFact, PresetFacts, ProblemFact } from './facts.ts';
import {
  addInterval,
  clampInterval,
  compareInterval,
  compareNumber,
  divInterval,
  hull,
  type Interval,
  intervalOf,
  lnInterval,
  log10Interval,
  maxInterval,
  minInterval,
  mulInterval,
  pointInterval,
  powInterval,
  snap12,
  sqrtInterval,
  subInterval,
  type Tri,
  triAll,
  triAny,
  triNot,
} from './interval.ts';
import type { PresetRegistry } from './registry.ts';
import type { CompareOp, CriteriaState, PresetBand, PresetCondition, PresetDefinition, PresetExpr, PresetItem, PresetObsKind, PresetPick } from './schema.ts';

// 手で選んだ答え：項目の key → yes・no（2択）か選択肢の key。null・undefined は自動に戻す
export type PresetAnswers = Readonly<Record<string, string | null | undefined>>;

// 記録から決まる答え（P015a）：yes・no、または記録の答えが食い違っているとき conflict（分からない扱い）。evidence は根拠の文
export type PresetRecordAnswer = { state: 'yes' | 'no' | 'conflict'; evidence: readonly string[] };
// 定義の id → 項目の key → 記録の答え
export type PresetRecordAnswers = Readonly<Record<string, Readonly<Record<string, PresetRecordAnswer>>>>;

export type PresetEvaluationOptions = {
  day: number; // 評価の日の位置（入院・救急は病日。0 以下は入院前。外来は暦の通し日）
  answers?: PresetAnswers | undefined;
  registry?: PresetRegistry | null | undefined; // ほかの定義の参照に使う
  nestedAnswers?: Readonly<Record<string, PresetAnswers>> | undefined; // ほかの定義の手で選んだ答え（定義の id ごと）
  autoOnly?: boolean | undefined; // 手で選んだ答えを使わない（知らせ・おすすめ）
  recordAnswers?: PresetRecordAnswers | undefined; // 記録から決まる答え（手で選ぶ2択の項目だけ。P015a）
};

export type PresetPointRange = { min: number; max: number };
// auto：自動（when）、record：記録から（対応表。P015a）、manual：手で選んだ、none：分からない（条件がない・自動で決まらない）
export type PresetItemSource = 'auto' | 'record' | 'manual' | 'none';
export type PresetItemResult = {
  key: string;
  label: string;
  kind: 'binary' | 'options';
  group: string | null;
  state: string; // 'yes'・'no'（2択）、選択肢の key、分からなければ 'unknown'
  option: { key: string; label: string } | null; // 段階のある項目で決まった選択肢
  points: number | null; // 決まった点（分からなければ null）
  range: PresetPointRange; // とりうる点（決まれば min = max）
  source: PresetItemSource;
  auto: string | null; // 自動の答え（'yes'・'no'・選択肢の key・'unknown'）。自動の条件のない項目は null（記録の答えがあれば、その 'yes'・'no'）
  evidence: string[]; // 自動の値の根拠
  reason: string | null; // 分からない理由（自動で決まらないとき）
};
export type PresetEvaluation = {
  presetId: string;
  kind: PresetDefinition['kind'];
  day: number;
  items: PresetItemResult[];
  total: PresetPointRange | null; // 点の合計（式のスコアは null）
  value: Interval | null; // 式のスコアの値（分からなければ null）
  band: PresetBand | null; // 区分（1つに決まるときだけ）
  criteria: CriteriaState | null; // 基準の状態（スコアは null）
  criteriaDetail: { rule: Tri; near: Tri } | null; // 基準の rule と「近い」の3つの答え（ほかの定義から参照するときに使う。スコアは null）
  ruleEvidence: string[]; // 基準の rule の根拠（項目を通さずに rule が直接読んだ値を含む。スコアは空。知らせの根拠の検査に使う。P015a）
  unknownCount: number; // 分からない項目の数
  unconfirmed: boolean; // 定義（と参照したほかの定義）に、本人がまだ確かめていないものがある
  reasons: string[]; // 値・状態が決まらない理由（式の値がない など）
};

type Outcome = { v: Tri; evidence: string[]; reasons: string[] };
type ExprOutcome = { v: Interval | null; evidence: string[]; reasons: string[] };

type Ctx = {
  facts: PresetFacts;
  day: number;
  pos: number; // 評価の日の位置
  window: number;
  registry: PresetRegistry | null;
  nestedAnswers: Readonly<Record<string, PresetAnswers>>;
  autoOnly: boolean;
  record: PresetRecordAnswers; // 記録から決まる答え（ほかの定義の参照にも渡す）
  suggest: boolean; // おすすめ・きっかけの条件の計算（プロブレムの語の条件が2択：あれば成り立つ、なければ成り立たない）
  stack: readonly string[]; // 計算中の定義（輪を止める）
  items: ReadonlyMap<string, PresetItemResult> | null; // 項目の結果（rule・near・式で使う）
  groups: ReadonlyMap<string, PresetItemResult[]>;
  preset: PresetDefinition;
  nested: { unconfirmed: boolean; cache: Map<string, PresetEvaluation | null> };
};

const uniq = (xs: readonly string[]) => [...new Set(xs)];
const outcome = (v: Tri, evidence: string[] = [], reasons: string[] = []): Outcome => ({ v, evidence: uniq(evidence), reasons: uniq(reasons) });
const unitText = (u: string | null) => u ?? '単位なし';

// 数の文字：-0 を 0 に、指数の形にしない（桁は最大6）
function numberText(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '−∞';
  const s = String(Math.round(x * 1e6) / 1e6);
  return s === '-0' ? '0' : s;
}

// 評価の日の位置からの幅（位置で）
const within = (pos: number, lo: number, hi: number) => pos >= lo && pos <= hi;

// ---- 根拠の文 ----
// 知らせの根拠から出どころの項目へ戻るため（P015a）、文の作り方はここ1か所に置いて、records/alerts.ts も使う
export const labEvidence = (name: string, p: LabFactPoint): string => `${name} ${p.text}（${p.when}）`;
export const ageEvidence = (age: number): string => `年齢 ${String(age)}歳`;
export const sexEvidence = (sex: '男性' | '女性'): string => `性別 ${sex}`;
export const problemEvidence = (p: Pick<ProblemFact, 'source' | 'text'>): string => `${({ problem: 'プロブレム', diagnosis: '診断', ai: 'AI のプロブレムリスト' } as const)[p.source]}「${p.text}」`;

// 区切りの呼び方（0・6・12・18時で区切る。旧 repo の ICU モード。Playbook の項目には区切りがなく、テストの事実だけが使う）
const BLOCK_LABEL: Readonly<Record<number, string>> = { 1: '0〜6時', 2: '6〜12時', 3: '12〜18時', 4: '18〜24時' };

// 観察の名前（対応の項目の名前。なければ種類の名前）と単位
const obsLabel = (facts: PresetFacts, kind: PresetObsKind): string => facts.observationInfo.get(kind)?.label ?? kind;

function obsValueText(facts: PresetFacts, kind: PresetObsKind, value: string): string {
  const unit = facts.observationInfo.get(kind)?.unit ?? '';
  return `${obsLabel(facts, kind)} ${value}${unit === '%' || unit === '℃' ? '' : ' '}${unit}`;
}

// 観察の根拠の文（区切りがあれば、区切りの呼び方も）
export const observationEvidence = (facts: PresetFacts, o: ObservationFact): string =>
  `${obsValueText(facts, o.kind, numberText(o.value))}（${o.when}${o.block === null ? '' : ` ${BLOCK_LABEL[o.block] ?? ''}`}）`;

function spanText(s: Interval): string {
  if (s.lo === s.hi) return numberText(s.lo);
  if (s.hi === Infinity) return `${numberText(s.lo)} 以上`;
  return `${numberText(s.lo)}〜${numberText(s.hi)}`;
}

export function dailyEvidence(facts: PresetFacts, d: DailyAmountFact): string {
  const where = d.blocks === null ? d.when : d.blocks === 4 ? `${d.when}、4つの区切りの合計` : `${d.when}、区切り ${String(d.blocks)}つの合計`;
  const s = d.span;
  const amount =
    s.hi === Infinity
      ? `${obsValueText(facts, d.kind, numberText(s.lo))} 以上`
      : obsValueText(facts, d.kind, s.lo === s.hi ? numberText(s.lo) : `${numberText(s.lo)}〜${numberText(s.hi)}`);
  return `${amount}（${where}）`;
}

// ---- 値を集める ----
type Valued = { span: Interval; evidence: string; pos: number };

// 検査の数の値（定義の単位の系列だけ）。値がなければ理由
function labValues(ctx: Ctx, name: string, unit: string | null, lo: number, hi: number): { values: Valued[]; reason: string | null } {
  const all = ctx.facts.labs.get(name) ?? [];
  const same = all.find((s) => s.unit === unit);
  const values: Valued[] = [];
  for (const p of same?.points ?? []) if (p.span !== null && within(p.pos, lo, hi)) values.push({ span: p.span, evidence: labEvidence(name, p), pos: p.pos });
  if (values.length > 0) return { values, reason: null };
  const other = all.some((s) => s.unit !== unit && s.points.some((p) => p.span !== null && within(p.pos, lo, hi)));
  return { values, reason: other ? `${name}：単位が違う（${unitText(unit)} でない）` : `${name} の値がない` };
}

function obsValues(ctx: Ctx, kind: PresetObsKind, lo: number, hi: number): { values: Valued[]; reason: string | null } {
  const values: Valued[] =
    kind === 'urine' || kind === 'intake'
      ? ctx.facts.dailyAmounts.filter((d) => d.kind === kind && within(d.pos, lo, hi)).map((d) => ({ span: d.span, evidence: dailyEvidence(ctx.facts, d), pos: d.pos }))
      : ctx.facts.observations
          .filter((o) => o.kind === kind && within(o.pos, lo, hi))
          .map((o) => ({ span: pointInterval(o.value), evidence: observationEvidence(ctx.facts, o), pos: o.pos }));
  return { values, reason: values.length > 0 ? null : `${obsLabel(ctx.facts, kind)}の値がない` };
}

function derivedValuesIn(ctx: Ctx, name: string, lo: number, hi: number): { values: Valued[]; reason: string | null } {
  const values = (ctx.facts.derived.get(name) ?? [])
    .filter((d) => within(d.pos, lo, hi))
    .map((d) => ({ span: pointInterval(d.value), evidence: `${name} ${d.text}（${d.when}）`, pos: d.pos }));
  return { values, reason: values.length > 0 ? null : `${name} の値がない` };
}

// 最も悪い値（比べ方の向きで最も端のもの）。同じなら新しいもの
function extreme(values: readonly Valued[], op: CompareOp): Valued | undefined {
  const up = op === '>' || op === '>=';
  let best: Valued | undefined;
  for (const v of values) {
    if (best === undefined) best = v;
    else if (up ? v.span.hi > best.span.hi || (v.span.hi === best.span.hi && v.span.lo >= best.span.lo) : v.span.lo < best.span.lo || (v.span.lo === best.span.lo && v.span.hi <= best.span.hi))
      best = v;
  }
  return best;
}

// 幅の中の値を閾値と比べる（どれかが確かに成り立てば成り立つ、すべて確かに成り立たなければ成り立たない）
function compareValues(values: readonly Valued[], op: CompareOp, t: number, noValue: string | null, straddle: string): Outcome {
  if (values.length === 0) return outcome(null, [], noValue === null ? [] : [noValue]);
  const answers = values.map((v) => ({ v, a: compareInterval(v.span, op, t) }));
  const yes = answers.filter((x) => x.a === true).map((x) => x.v);
  if (yes.length > 0) return outcome(true, [extreme(yes, op)?.evidence ?? '']);
  const unknown = answers.filter((x) => x.a === null).map((x) => x.v);
  if (unknown.length === 0) return outcome(false, [extreme(values, op)?.evidence ?? '']);
  return outcome(null, [extreme(unknown, op)?.evidence ?? ''], [straddle]);
}

const opText = (op: CompareOp) => ({ '<': '<', '<=': '≤', '>': '>', '>=': '≥' })[op];

// ---- 定性値 ----
const POSITIVE = new Set(['(+)', '1+', '2+', '3+', '4+', '陽性', '弱陽性']);
const NEGATIVE = new Set(['(-)', '陰性']);

function qualCondition(ctx: Ctx, name: string, want: 'positive' | 'negative'): Outcome {
  const lo = ctx.pos - ctx.window;
  const points = (ctx.facts.labs.get(name) ?? []).flatMap((s) => s.points).filter((p) => p.qual !== null && within(p.pos, lo, ctx.pos));
  if (points.length === 0) return outcome(null, [], [`${name} の定性の値がない`]);
  const [hit, miss] = want === 'positive' ? [POSITIVE, NEGATIVE] : [NEGATIVE, POSITIVE];
  const yes = points.find((p) => p.qual !== null && hit.has(p.qual));
  if (yes !== undefined) return outcome(true, [labEvidence(name, yes)]);
  if (points.every((p) => p.qual !== null && miss.has(p.qual))) return outcome(false, points.slice(-1).map((p) => labEvidence(name, p)));
  return outcome(
    null,
    points.filter((p) => p.qual !== null && !miss.has(p.qual)).map((p) => labEvidence(name, p)),
    [`${name} の定性の値で決まらない`],
  );
}

// ---- 条件 ----
function evalCondition(c: PresetCondition, ctx: Ctx): Outcome {
  if ('all' in c) {
    const rs = c.all.map((x) => evalCondition(x, ctx));
    const v = triAll(rs.map((r) => r.v));
    const used = v === false ? rs.filter((r) => r.v === false) : v === null ? rs.filter((r) => r.v !== true) : rs;
    return outcome(v, used.flatMap((r) => r.evidence), v === null ? used.flatMap((r) => r.reasons) : []);
  }
  if ('any' in c) {
    const rs = c.any.map((x) => evalCondition(x, ctx));
    const v = triAny(rs.map((r) => r.v));
    const used = v === true ? rs.filter((r) => r.v === true) : v === null ? rs.filter((r) => r.v !== false) : rs;
    return outcome(v, used.flatMap((r) => r.evidence), v === null ? used.flatMap((r) => r.reasons) : []);
  }
  if ('not' in c) {
    const r = evalCondition(c.not, ctx);
    return outcome(triNot(r.v), r.evidence, r.reasons);
  }
  if ('lab' in c) {
    if ('qual' in c) return qualCondition(ctx, c.lab, c.qual);
    const { values, reason } = labValues(ctx, c.lab, c.unit, ctx.pos - ctx.window, ctx.pos);
    return compareValues(values, c.op, c.value, reason, `${c.lab}：範囲の値が閾値（${opText(c.op)}${numberText(c.value)}）をまたぐ`);
  }
  if ('obs' in c) {
    const { values, reason } = obsValues(ctx, c.obs, ctx.pos - ctx.window, ctx.pos);
    return compareValues(values, c.op, c.value, reason, `${obsLabel(ctx.facts, c.obs)}：値が閾値（${opText(c.op)}${numberText(c.value)}）をまたぐ`);
  }
  if ('age' in c) {
    const age = ctx.facts.age;
    if (age === null) return outcome(null, [], ['年齢が分からない']);
    return outcome(compareNumber(age, c.age.op, c.age.value), [ageEvidence(age)]);
  }
  if ('sex' in c) {
    const sex = ctx.facts.sex;
    if (sex === null) return outcome(null, [], ['性別が分からない']);
    return outcome(sex === c.sex, [sexEvidence(sex)]);
  }
  if ('problem' in c) {
    const hit = ctx.facts.problems.find((p) => c.problem.some((w) => hasKeyword(p.text, w)));
    if (hit !== undefined) return outcome(true, [problemEvidence(hit)]);
    // 語がないこと：おすすめでは「成り立たない」（not で除外の語を書ける）。ほかでは「分からない」（プロブレムにないことは、ないことの証拠にしない）
    return ctx.suggest ? outcome(false) : outcome(null, [], ['プロブレム・診断に語がない']);
  }
  if ('calc' in c) {
    const r = evalExpr(c.calc, ctx);
    if (r.v === null) return outcome(null, r.evidence, r.reasons.length > 0 ? r.reasons : ['式の値が分からない']);
    const a = compareInterval(r.v, c.op, c.value);
    return outcome(a, r.evidence, a === null ? [...r.reasons, `式の値（${spanText(r.v)}）が閾値（${opText(c.op)}${numberText(c.value)}）をまたぐ`] : []);
  }
  if ('preset' in c) {
    const n = nestedEvaluation(c.preset, ctx);
    if (n.evaluation === null) return outcome(null, [], [n.reason]);
    const e = n.evaluation;
    const name = n.name;
    if ('state' in c) {
      if (e.criteria === null || e.criteriaDetail === null) return outcome(null, [], [`${name} は基準でない`]);
      // met は rule の答え。near は「満たすか近い」（rule か near が成り立てば成り立つ、両方成り立たなければ成り立たない）
      const { rule, near } = e.criteriaDetail;
      const v: Tri = c.state === 'met' ? rule : triAny([rule, near]);
      return outcome(v, [`${name}：${CRITERIA_STATE_LABEL[e.criteria]}`], v === null ? [`${name} が決まらない`] : []);
    }
    const span = e.value ?? (e.total === null ? null : intervalOf(e.total.min, true, e.total.max, true));
    if (span === null) return outcome(null, [], [`${name} の値が分からない`]);
    const a = compareInterval(span, c.op, c.value);
    return outcome(a, [`${name} ${spanText(span)}`], a === null ? [`${name} の値が閾値（${opText(c.op)}${numberText(c.value)}）をまたぐ`] : []);
  }
  if ('count' in c) {
    const members = ctx.groups.get(c.count) ?? [];
    const sure = members.filter((m) => m.range.min > 0).length;
    const maybe = members.filter((m) => m.range.min <= 0 && m.range.max > 0).length;
    return outcome(sure >= c.atLeast ? true : sure + maybe < c.atLeast ? false : null);
  }
  if ('total' in c) {
    const t = totalOf(ctx);
    return outcome(compareInterval(intervalOf(t.min, true, t.max, true) ?? pointInterval(t.min), c.total.op, c.total.value));
  }
  const item = ctx.items?.get(c.item);
  if (item === undefined) return outcome(null, [], [`項目（${c.item}）がない`]);
  return outcome(item.range.min > 0 ? true : item.range.max <= 0 ? false : null);
}

export const CRITERIA_STATE_LABEL: Readonly<Record<CriteriaState, string>> = { met: '満たす', near: '近い', possible: '満たすかもしれない', 'not-met': '満たさない' };

// ---- 式 ----
const exprOut = (v: Interval | null, evidence: string[] = [], reasons: string[] = []): ExprOutcome => ({ v, evidence: uniq(evidence), reasons: uniq(reasons) });

function pickValues(values: readonly Valued[], pick: PresetPick, reason: string | null): ExprOutcome {
  if (values.length === 0) return exprOut(null, [], reason === null ? [] : [reason]);
  if (pick === 'latest' || pick === 'first') {
    const at = pick === 'latest' ? Math.max(...values.map((v) => v.pos)) : Math.min(...values.map((v) => v.pos));
    const same = values.filter((v) => v.pos === at);
    const span = same.slice(1).reduce((s, v) => hull(s, v.span), (same[0] as Valued).span);
    return exprOut(span, same.map((v) => v.evidence));
  }
  const fold = pick === 'max' ? maxInterval : minInterval;
  const span = values.slice(1).reduce((s, v) => fold(s, v.span), (values[0] as Valued).span);
  const best = extreme(values, pick === 'max' ? '>' : '<');
  return exprOut(span, best === undefined ? [] : [best.evidence]);
}

function exprWindow(ctx: Ctx, e: { pick?: PresetPick | undefined; from?: number | undefined; to?: number | undefined }) {
  return { pick: e.pick ?? 'latest', lo: ctx.pos + (e.from ?? -ctx.window), hi: ctx.pos + (e.to ?? 0) };
}

function combine(parts: readonly ExprOutcome[], f: (vs: Interval[]) => Interval | null): ExprOutcome {
  const vs = parts.map((p) => p.v);
  const evidence = parts.flatMap((p) => p.evidence);
  const reasons = parts.flatMap((p) => p.reasons);
  if (vs.some((v) => v === null)) return exprOut(null, evidence, reasons.length > 0 ? reasons : ['式の値が分からない']);
  const v = f(vs as Interval[]);
  return exprOut(v, evidence, v === null ? [...reasons, '式の値が計算できない（0 で割る・定義域の外）'] : reasons);
}

const fold2 = (f: (a: Interval, b: Interval) => Interval | null) => (vs: Interval[]) =>
  vs.slice(1).reduce<Interval | null>((acc, v) => (acc === null ? null : f(acc, v)), vs[0] ?? null);

function evalExpr(e: PresetExpr, ctx: Ctx): ExprOutcome {
  if (typeof e === 'number') return exprOut(pointInterval(e));
  if ('lab' in e) {
    const w = exprWindow(ctx, e);
    const { values, reason } = labValues(ctx, e.lab, e.unit, w.lo, w.hi);
    return pickValues(values, w.pick, reason);
  }
  if ('obs' in e) {
    const w = exprWindow(ctx, e);
    const { values, reason } = obsValues(ctx, e.obs, w.lo, w.hi);
    return pickValues(values, w.pick, reason);
  }
  if ('derived' in e) {
    const w = exprWindow(ctx, e);
    const { values, reason } = derivedValuesIn(ctx, e.derived, w.lo, w.hi);
    return pickValues(values, w.pick, reason);
  }
  if ('age' in e) return ctx.facts.age === null ? exprOut(null, [], ['年齢が分からない']) : exprOut(pointInterval(ctx.facts.age), [ageEvidence(ctx.facts.age)]);
  if ('preset' in e) {
    const n = nestedEvaluation(e.preset, ctx);
    if (n.evaluation === null) return exprOut(null, [], [n.reason]);
    const ev = n.evaluation;
    const span = ev.value ?? (ev.total === null ? null : intervalOf(ev.total.min, true, ev.total.max, true));
    return span === null ? exprOut(null, [], [`${n.name} の値が分からない`]) : exprOut(span, [`${n.name} ${spanText(span)}`]);
  }
  if ('item' in e) {
    const item = ctx.items?.get(e.item);
    if (item === undefined) return exprOut(null, [], [`項目（${e.item}）がない`]);
    return exprOut(intervalOf(item.range.min, true, item.range.max, true));
  }
  if ('add' in e) return combine(e.add.map((x) => evalExpr(x, ctx)), fold2(addInterval));
  if ('sub' in e) return combine(e.sub.map((x) => evalExpr(x, ctx)), fold2(subInterval));
  if ('mul' in e) return combine(e.mul.map((x) => evalExpr(x, ctx)), fold2(mulInterval));
  if ('div' in e) return combine(e.div.map((x) => evalExpr(x, ctx)), fold2(divInterval));
  if ('min' in e) return combine(e.min.map((x) => evalExpr(x, ctx)), fold2(minInterval));
  if ('max' in e) return combine(e.max.map((x) => evalExpr(x, ctx)), fold2(maxInterval));
  if ('ln' in e) return combine([evalExpr(e.ln, ctx)], ([a]) => (a === undefined ? null : lnInterval(a)));
  if ('log10' in e) return combine([evalExpr(e.log10, ctx)], ([a]) => (a === undefined ? null : log10Interval(a)));
  if ('sqrt' in e) return combine([evalExpr(e.sqrt, ctx)], ([a]) => (a === undefined ? null : sqrtInterval(a)));
  if ('pow' in e) {
    const [base, exponent] = e.pow;
    return combine([evalExpr(base, ctx)], ([a]) => (a === undefined ? null : powInterval(a, exponent)));
  }
  if ('clamp' in e) return combine(e.clamp.map((x) => evalExpr(x, ctx)), ([v, lo, hi]) => (v === undefined || lo === undefined || hi === undefined ? null : clampInterval(v, lo, hi)));
  const c = evalCondition(e.if, ctx);
  if (c.v === true) return withCondition(evalExpr(e.then, ctx), c);
  if (c.v === false) return withCondition(evalExpr(e.else, ctx), c);
  const r = combine([evalExpr(e.then, ctx), evalExpr(e.else, ctx)], ([a, b]) => (a === undefined || b === undefined ? null : hull(a, b)));
  return exprOut(r.v, [...c.evidence, ...r.evidence], [...c.reasons, ...r.reasons]);
}

const withCondition = (r: ExprOutcome, c: Outcome) => exprOut(r.v, [...c.evidence, ...r.evidence], r.reasons);

// ---- ほかの定義 ----
function nestedEvaluation(id: string, ctx: Ctx): { evaluation: PresetEvaluation; name: string } | { evaluation: null; reason: string } {
  const p = ctx.registry?.get(id) ?? null;
  if (p === null) return { evaluation: null, reason: `定義（${id}）がない` };
  if (ctx.stack.includes(id)) return { evaluation: null, reason: `定義の参照が輪になっている（${p.name}）` };
  if (!ctx.nested.cache.has(id)) {
    const e = evaluateWith(p, ctx.facts, {
      day: ctx.day,
      answers: ctx.nestedAnswers[id],
      registry: ctx.registry,
      nestedAnswers: ctx.nestedAnswers,
      autoOnly: ctx.autoOnly,
      recordAnswers: ctx.record,
      stack: [...ctx.stack, id],
      cache: ctx.nested.cache,
    });
    ctx.nested.cache.set(id, e);
  }
  const e = ctx.nested.cache.get(id) ?? null;
  if (e === null) return { evaluation: null, reason: `定義（${p.name}）が計算できない` };
  if (e.unconfirmed) ctx.nested.unconfirmed = true;
  return { evaluation: e, name: p.name };
}

// ---- 項目 ----
const isBinary = (item: PresetItem): item is Extract<PresetItem, { points: number }> => !('options' in item);

function itemResult(item: PresetItem, ctx: Ctx, answer: string | null, recorded?: PresetRecordAnswer): PresetItemResult {
  const base = { key: item.key, label: item.label, group: item.group ?? null };
  if (isBinary(item)) {
    const p = item.points;
    const range = (v: 'yes' | 'no' | 'unknown') => (v === 'yes' ? { min: p, max: p } : v === 'no' ? { min: 0, max: 0 } : { min: Math.min(0, p), max: Math.max(0, p) });
    const auto = item.when === undefined ? null : evalCondition(item.when, ctx);
    // 記録の答え：自動の条件がない 2択の項目だけ（P015a）
    const record = item.when === undefined ? recorded : undefined;
    const recordState = record === undefined || record.state === 'conflict' ? null : record.state;
    const autoState = auto === null ? recordState : auto.v === true ? 'yes' : auto.v === false ? 'no' : 'unknown';
    const evidence = [...(auto?.evidence ?? []), ...(record?.evidence ?? [])];
    if (answer === 'yes' || answer === 'no')
      return { ...base, kind: 'binary', state: answer, option: null, points: answer === 'yes' ? p : 0, range: range(answer), source: 'manual', auto: autoState, evidence, reason: null };
    if (auto === null && record !== undefined) {
      if (record.state === 'conflict') {
        return { ...base, kind: 'binary', state: 'unknown', option: null, points: null, range: range('unknown'), source: 'none', auto: null, evidence, reason: '記録の答えが食い違っている（手で選ぶと決まります）' };
      }
      const state = record.state;
      return { ...base, kind: 'binary', state, option: null, points: state === 'yes' ? p : 0, range: range(state), source: 'record', auto: state, evidence, reason: null };
    }
    if (auto === null || auto.v === null) {
      const reason = auto === null ? '手で選ぶ項目' : auto.reasons.length > 0 ? auto.reasons.join('、') : '自動で決まらない';
      return { ...base, kind: 'binary', state: 'unknown', option: null, points: null, range: range('unknown'), source: 'none', auto: autoState, evidence, reason };
    }
    const state = auto.v ? 'yes' : 'no';
    return { ...base, kind: 'binary', state, option: null, points: auto.v ? p : 0, range: range(state), source: 'auto', auto: autoState, evidence, reason: null };
  }
  const options = item.options;
  const decided = (o: (typeof options)[number], source: PresetItemSource, autoState: string | null, evidence: string[]): PresetItemResult => ({
    ...base,
    kind: 'options',
    state: o.key,
    option: { key: o.key, label: o.label },
    points: o.points,
    range: { min: o.points, max: o.points },
    source,
    auto: autoState,
    evidence,
    reason: null,
  });
  const unknown = (possible: readonly (typeof options)[number][], autoState: string | null, evidence: string[], reason: string): PresetItemResult => {
    const pts = (possible.length > 0 ? possible : options).map((o) => o.points);
    return { ...base, kind: 'options', state: 'unknown', option: null, points: null, range: { min: Math.min(...pts), max: Math.max(...pts) }, source: 'none', auto: autoState, evidence, reason };
  };
  // 自動の答え
  const conditioned = options.filter((o) => o.when !== undefined);
  let autoResult: { state: string; chosen: (typeof options)[number] | null; possible: (typeof options)[number][]; evidence: string[]; reason: string } | null = null;
  if (conditioned.length > 0) {
    const fallback = options.find((o) => o.when === undefined) ?? null;
    const rs = conditioned.map((o) => ({ o, r: evalCondition(o.when as PresetCondition, ctx) }));
    const yes = rs.filter((x) => x.r.v === true);
    const maybe = rs.filter((x) => x.r.v === null);
    if (yes.length > 0) {
      const best = yes.reduce((a, b) => (b.o.points > a.o.points ? b : a));
      const higher = maybe.filter((x) => x.o.points > best.o.points);
      autoResult =
        higher.length === 0
          ? { state: best.o.key, chosen: best.o, possible: [best.o], evidence: best.r.evidence, reason: '' }
          : {
              state: 'unknown',
              chosen: null,
              possible: [best.o, ...higher.map((x) => x.o)],
              evidence: [...best.r.evidence, ...higher.flatMap((x) => x.r.evidence)],
              reason: uniq(higher.flatMap((x) => x.r.reasons)).join('、') || '自動で決まらない',
            };
    } else if (maybe.length === 0) {
      autoResult =
        fallback === null
          ? { state: 'unknown', chosen: null, possible: [...options], evidence: rs.flatMap((x) => x.r.evidence), reason: 'どの選択肢の条件も成り立たない' }
          : { state: fallback.key, chosen: fallback, possible: [fallback], evidence: rs.flatMap((x) => x.r.evidence), reason: '' };
    } else {
      autoResult = {
        state: 'unknown',
        chosen: null,
        possible: [...maybe.map((x) => x.o), ...(fallback === null ? [] : [fallback])],
        evidence: maybe.flatMap((x) => x.r.evidence),
        reason: uniq(maybe.flatMap((x) => x.r.reasons)).join('、') || '自動で決まらない',
      };
    }
  }
  const evidence = uniq(autoResult?.evidence ?? []);
  const manual = answer === null ? undefined : options.find((o) => o.key === answer);
  if (manual !== undefined) return decided(manual, 'manual', autoResult?.state ?? null, evidence);
  if (autoResult === null) return unknown(options, null, [], '手で選ぶ項目');
  if (autoResult.chosen !== null) return decided(autoResult.chosen, 'auto', autoResult.state, evidence);
  return unknown(autoResult.possible, autoResult.state, evidence, autoResult.reason);
}

// ---- 合計・区分 ----
function totalOf(ctx: Pick<Ctx, 'items' | 'groups' | 'preset'>): PresetPointRange {
  const groups = new Map(ctx.preset.groups.map((g) => [g.key, g]));
  let min = 0;
  let max = 0;
  for (const r of ctx.items?.values() ?? []) {
    if (r.group !== null && groups.has(r.group)) continue;
    min += r.range.min;
    max += r.range.max;
  }
  for (const g of ctx.preset.groups) {
    const members = ctx.groups.get(g.key) ?? [];
    if (members.length === 0 || g.scoring === 'none') continue;
    if (g.scoring === 'sum') {
      min += members.reduce((n, m) => n + m.range.min, 0);
      max += members.reduce((n, m) => n + m.range.max, 0);
    } else {
      min += Math.max(...members.map((m) => m.range.min));
      max += Math.max(...members.map((m) => m.range.max));
    }
  }
  return { min: round(min), max: round(max) };
}

// 点の和の誤差（0.1 + 0.2）をそろえる
const round = (x: number) => Math.round(x * 1e6) / 1e6;

function pointBand(bands: readonly PresetBand[], total: PresetPointRange): PresetBand | null {
  const inBand = (x: number) => bands.find((b) => b.min !== undefined && b.max !== undefined && x >= b.min && x <= b.max);
  const a = inBand(total.min);
  return a !== undefined && a === inBand(total.max) ? a : null;
}

// 式の区分：min 以上 max 未満。値の区間がすべて1つの区分に入るときだけ
function formulaBand(bands: readonly PresetBand[], v: Interval): PresetBand | null {
  // 端は12桁にそろえてから比べる（compareInterval と同じ。1.4 − 1.1 が 0.3 の区分に入る）
  const [lo, hi] = [snap12(v.lo), snap12(v.hi)];
  return (
    bands.find((b) => {
      const aboveMin = b.min === undefined || lo >= b.min;
      const belowMax = b.max === undefined || hi < b.max || (hi === b.max && !v.hiIn);
      return aboveMin && belowMax;
    }) ?? null
  );
}

function groupsOf(preset: PresetDefinition, items: readonly PresetItemResult[]): Map<string, PresetItemResult[]> {
  const out = new Map<string, PresetItemResult[]>(preset.groups.map((g) => [g.key, []]));
  for (const r of items) if (r.group !== null) out.get(r.group)?.push(r);
  return out;
}

// 1つ以上の項目が確かにあてはまっていて、あと1項目があてはまれば rule が成り立つか（near のない基準の「近い」）。
// 1項目だけの基準や any の基準が、何もあてはまっていないのにいつも「近い」にならないように、あてはまる項目を1つ以上求める。
// 分からない項目を最も低い点にした rule がすでに成り立つときは近くない（下）
function defaultNear(preset: Extract<PresetDefinition, { kind: 'criteria' }>, ctx: Ctx, items: readonly PresetItemResult[]): Tri {
  const lowest = (r: PresetItemResult): PresetItemResult => ({ ...r, points: r.range.min, range: { min: r.range.min, max: r.range.min } });
  const highestOf = (item: PresetItem) => (isBinary(item) ? Math.max(0, item.points) : Math.max(...item.options.map((o) => o.points)));
  if (!items.some((r) => r.range.min > 0)) return false;
  const base = items.map((r) => (r.points === null ? lowest(r) : r));
  // 分からない項目を最も低い点にしても rule が成り立つ（入口・必須・除外の答えがないだけ）なら、あと1項目では変わらない。近いでなく、
  // 満たすかもしれない（rule の分からないが残る）。rule が分からないままでも同じ
  if (evalCondition(preset.rule, { ...ctx, items: new Map(base.map((b) => [b.key, b])), groups: groupsOf(preset, base) }).v !== false) return false;
  const answers: Tri[] = [];
  preset.items.forEach((item, i) => {
    const r = base[i];
    const top = highestOf(item);
    if (r === undefined || r.range.max > 0 || top <= 0) return;
    const flipped = base.map((b, j) => (j === i ? { ...b, points: top, range: { min: top, max: top } } : b));
    const map = new Map(flipped.map((b) => [b.key, b]));
    answers.push(evalCondition(preset.rule, { ...ctx, items: map, groups: groupsOf(preset, flipped) }).v);
  });
  return triAny(answers);
}

type InternalOptions = PresetEvaluationOptions & { stack: readonly string[]; cache: Map<string, PresetEvaluation | null> };

function evaluateWith(preset: PresetDefinition & { unconfirmed?: boolean }, facts: PresetFacts, opts: InternalOptions): PresetEvaluation {
  const nested = { unconfirmed: false, cache: opts.cache };
  const ctx0: Ctx = {
    facts,
    day: opts.day,
    pos: opts.day,
    window: preset.window,
    registry: opts.registry ?? null,
    nestedAnswers: opts.nestedAnswers ?? {},
    autoOnly: opts.autoOnly === true,
    record: opts.recordAnswers ?? {},
    suggest: false,
    stack: opts.stack,
    items: null,
    groups: new Map(),
    preset,
    nested,
  };
  const answers = opts.autoOnly === true ? {} : (opts.answers ?? {});
  const recorded = opts.recordAnswers?.[preset.id] ?? {};
  const items = preset.items.map((item) => {
    const a = Object.hasOwn(answers, item.key) ? answers[item.key] : undefined;
    return itemResult(item, ctx0, typeof a === 'string' ? a : null, Object.hasOwn(recorded, item.key) ? recorded[item.key] : undefined);
  });
  const ctx: Ctx = { ...ctx0, items: new Map(items.map((r) => [r.key, r])), groups: groupsOf(preset, items) };
  const unknownCount = items.filter((r) => r.points === null).length;
  const reasons: string[] = [];
  let total: PresetPointRange | null = null;
  let value: Interval | null = null;
  let band: PresetBand | null = null;
  let criteria: CriteriaState | null = null;
  let criteriaDetail: PresetEvaluation['criteriaDetail'] = null;
  let ruleEvidence: string[] = [];
  if (preset.kind === 'score' && preset.formula !== undefined) {
    const r = evalExpr(preset.formula, ctx);
    value = r.v;
    reasons.push(...r.reasons);
    band = value === null ? null : formulaBand(preset.bands, value);
  } else {
    total = totalOf(ctx);
    if (preset.kind === 'score') band = pointBand(preset.bands, total);
  }
  if (preset.kind === 'criteria') {
    const rule = evalCondition(preset.rule, ctx);
    ruleEvidence = rule.evidence;
    let near: Tri = false;
    if (rule.v !== true) near = preset.near === null ? defaultNear(preset, ctx, items) : evalCondition(preset.near, ctx).v;
    criteria = rule.v === true ? 'met' : near === true ? 'near' : rule.v === null ? 'possible' : 'not-met';
    criteriaDetail = { rule: rule.v, near: rule.v === true ? true : near };
    if (rule.v === null) reasons.push(...rule.reasons);
  }
  return {
    presetId: preset.id,
    kind: preset.kind,
    day: ctx.day,
    items,
    total,
    value,
    band,
    criteria,
    criteriaDetail,
    ruleEvidence,
    unknownCount,
    unconfirmed: preset.unconfirmed === true || nested.unconfirmed,
    reasons: uniq(reasons),
  };
}

// 定義を1つ計算する
export function evaluatePreset(preset: PresetDefinition & { unconfirmed?: boolean }, facts: PresetFacts, opts: PresetEvaluationOptions): PresetEvaluation {
  return evaluateWith(preset, facts, { ...opts, stack: [preset.id], cache: new Map() });
}

// 条件を1つだけ計算する（おすすめのきっかけなど。項目の条件と同じ書き方で、項目・まとまり・合計は指せない）。window は値の幅。
// suggest: true はおすすめ・きっかけの計算で、プロブレムの語の条件が2択になる（語があれば成り立つ、なければ成り立たない）。
// not・all・any の中でも同じで、除外の語を書ける（{ not: { problem: [院内肺炎] } }）。検査の値などは、値がなければ分からないまま
export function evaluatePresetCondition(
  c: PresetCondition,
  facts: PresetFacts,
  opts: { day: number; window?: number | undefined; registry?: PresetRegistry | null | undefined; suggest?: boolean | undefined },
): { value: Tri; evidence: string[]; reasons: string[] } {
  const preset: PresetDefinition = { id: '', name: '', kind: 'criteria', summary: '', window: opts.window ?? 0, default_day: 'today', suggest: null, items: [], groups: [], rule: c, near: null, alert: null, problem_text: null };
  const ctx: Ctx = {
    facts,
    day: opts.day,
    pos: opts.day,
    window: preset.window,
    registry: opts.registry ?? null,
    nestedAnswers: {},
    autoOnly: true,
    record: {},
    suggest: opts.suggest === true,
    stack: [],
    items: new Map(),
    groups: new Map(),
    preset,
    nested: { unconfirmed: false, cache: new Map() },
  };
  const r = evalCondition(c, ctx);
  return { value: r.v, evidence: r.evidence, reasons: r.reasons };
}

// 結果の短い文：点数のスコアは「3点」「2〜4点」、式のスコアは digits の桁（幅があれば「〜」）、基準は状態。区分があれば後ろに（中等症）。
// 段階のある項目1つだけの分類（JCS・NYHA・Killip・mRS など。点は段階の番号）は、「点」を付けずに区分の名前（区分がなければ選んだ段階の名前）を出す
export function presetResultText(preset: Pick<PresetDefinition, 'kind'> & { digits?: number | undefined }, e: PresetEvaluation): string {
  const band = e.band === null ? '' : `（${e.band.label}）`;
  if (e.criteria !== null) return `${CRITERIA_STATE_LABEL[e.criteria]}${band}`;
  const only = e.items.length === 1 ? e.items[0] : undefined;
  if (e.value === null && e.total !== null && only?.kind === 'options') return e.band?.label ?? only.option?.label ?? '未入力';
  if (e.value !== null) {
    const d = preset.digits ?? 1;
    const f = (x: number) => (Number.isFinite(x) ? fixed(x, d) : x > 0 ? '∞' : '−∞');
    return `${e.value.lo === e.value.hi ? f(e.value.lo) : `${f(e.value.lo)}〜${f(e.value.hi)}`}${band}`;
  }
  if (e.total !== null) return `${e.total.min === e.total.max ? numberText(e.total.min) : `${numberText(e.total.min)}〜${numberText(e.total.max)}`}点${band}`;
  return '未入力';
}

const fixed = (x: number, digits: number) => {
  const s = x.toFixed(digits);
  return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
};

