// スコア・診断基準（段K4。CA-059・CA-063）：取り込んだ表（clinical-playbook の定義。出典つき）から、記録の値で決定論で計算して、いつも出す。
// AI は使わない。値のない項目は「未入力」（あてはまらないとしない）。定義が「未確認」の間は、そう出す。
// 手で選ぶ答えは、この画面のメモリだけ（useState。保存しない・送らない）。印と色は、必ず字と、基準（項目）と出典を添える。画面の外への知らせは作らない。
import {
  type ClinicalPreset,
  evaluateForRecord,
  itemAnswerText,
  itemPointsText,
  latestDay,
  type PresetAnswers,
  presetAnswerChoices,
  type PresetItemResult,
  type PresetRecordInput,
  type PresetResult,
  PRESETS,
  presetsByArea,
  presetSources,
  resultView,
  suggestedPresets,
  windowText,
} from '@clinical-carte/core';
import { useMemo, useState } from 'react';

/** 結果の印の種類（色は style.css の --score-* の組。字と一緒に出す） */
function resultClass(r: PresetResult): string {
  const e = r.evaluation;
  if (e.criteria !== null) return { met: 'score-tag score-met', near: 'score-tag score-near', possible: 'score-tag score-open', 'not-met': 'score-tag score-not' }[e.criteria];
  return e.band === null ? 'score-tag score-open' : 'score-tag score-band';
}

/** 結果の短い文（基準は状態、スコアは点と区分） */
function resultText(r: PresetResult): string {
  return resultView(r.preset, r.evaluation).headline;
}

/** 項目の答えの印：未入力は破線、2択の「あてはまる」は色、ほか（あてはまらない・段階の選択肢）は地の色 */
function itemClass(r: PresetItemResult): string {
  if (r.state === 'unknown') return 'item-state item-open';
  return r.kind === 'binary' && r.state === 'yes' ? 'item-state item-yes' : 'item-state item-plain';
}

/** 項目の出どころの文 */
function itemSource(r: PresetItemResult): string {
  if (r.source === 'auto') return '記録の値から';
  if (r.source === 'manual') return '手で選んだ（この画面だけ）';
  if (r.source === 'record') return '記録から';
  if (r.auto === null) return '手で選ぶ項目（未入力）';
  return `未入力：${r.reason ?? '記録の値では決まらない'}`;
}

function PresetCard({ result, answers, onAnswer, onClose }: { result: PresetResult; answers: PresetAnswers; onAnswer: (key: string, value: string | null) => void; onClose?: (() => void) | undefined }) {
  const { preset, evaluation } = result;
  const view = resultView(preset, evaluation);
  const lines = view.lines.filter((l) => !l.includes('（未確認）'));
  const sources = presetSources(preset);
  return (
    <details className="preset-card" data-testid="preset-card" data-preset={preset.id}>
      <summary className="preset-head">
        <strong className="preset-name">{preset.name}</strong>
        <span className={resultClass(result)} data-testid="preset-result">
          {resultText(result)}
        </span>
        {preset.unconfirmed && <span className="tag unconfirmed-tag">未確認（原典と照らしていない）</span>}
      </summary>
      <div className="preset-body">
        {preset.summary !== '' && <p className="thread-sub">{preset.summary}</p>}
        {result.why.length > 0 && <p className="thread-sub" data-testid="preset-why">勧めた理由：{result.why.join('・')}</p>}
        <p className="thread-sub">
          評価の日：{result.day}（{preset.default_day === 'first' ? '受診の始まりの日。' : '記録の上で最後の測定値の日。'}
          {windowText(preset)}）
        </p>
        {lines.map((l) => (
          <p key={l} className="thread-sub">
            {l}
          </p>
        ))}
        {evaluation.criteria !== null && evaluation.reasons.length > 0 && <p className="thread-sub">決まらない理由：{evaluation.reasons.join('、')}</p>}
        <ul className="preset-items">
          {evaluation.items.map((r) => {
            const item = preset.items.find((i) => i.key === r.key);
            const editable = item !== undefined && r.source !== 'auto';
            const chosen = answers[r.key] ?? null;
            const state = itemAnswerText(item, r);
            return (
              <li key={r.key} className="preset-item" data-testid="preset-item">
                <div className="preset-item-head">
                  <span className="preset-item-label">{r.label}</span>
                  <span className={itemClass(r)} data-testid="preset-item-state">
                    {state}
                  </span>
                  <span className="preset-points">{itemPointsText(r)}</span>
                </div>
                <p className="preset-item-from">
                  {itemSource(r)}
                  {r.evidence.length > 0 && `：${r.evidence.join('・')}`}
                </p>
                {editable && (
                  <div className="row-actions">
                    {presetAnswerChoices(item).map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        className={chosen === c.key ? 'chip small on' : 'chip small'}
                        aria-pressed={chosen === c.key}
                        onClick={() => {
                          onAnswer(r.key, chosen === c.key ? null : c.key);
                        }}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="note" data-testid="preset-sources">
          出典：{sources.map((s) => s.title).join('／')}
        </p>
        {onClose !== undefined && (
          <button type="button" className="button small" onClick={onClose}>
            この定義を閉じる
          </button>
        )}
      </div>
    </details>
  );
}

export function ScoresView({ input, fallbackDay }: { input: PresetRecordInput; fallbackDay: string | null }) {
  // 手で選んだ答え（定義の id → 項目の key → 答え）と、一覧から開いた定義。どちらも画面のメモリだけ
  const [answers, setAnswers] = useState<ReadonlyMap<string, PresetAnswers>>(new Map());
  const [extra, setExtra] = useState<readonly string[]>([]);
  const latest = latestDay(input, fallbackDay);
  const suggested = useMemo(() => suggestedPresets(input, latest), [input, latest]);
  const answersOf = (id: string): PresetAnswers => answers.get(id) ?? {};
  // 手で選んだ答えがある定義は、その答えで計算し直す（勧めた理由はそのまま）
  const withAnswers = (r: PresetResult): PresetResult => (answers.has(r.preset.id) ? { ...evaluateForRecord(r.preset, input, latest, answersOf(r.preset.id)), why: r.why } : r);
  const shown = suggested.map(withAnswers);
  const suggestedIds = new Set(suggested.map((r) => r.preset.id));
  const opened = extra.flatMap((id) => {
    const p: ClinicalPreset | null = PRESETS.get(id);
    return p === null || suggestedIds.has(id) ? [] : [evaluateForRecord(p, input, latest, answersOf(id))];
  });
  const answer = (id: string) => (key: string, value: string | null) => {
    const next = new Map(answers);
    const current = { ...answersOf(id) };
    if (value === null) Reflect.deleteProperty(current, key);
    else current[key] = value;
    next.set(id, current);
    setAnswers(next);
  };
  const summary = shown.length === 0 ? '問題の名前から勧められるものなし' : shown.map((r) => `${r.preset.name} ${resultText(r)}`).join('・');

  return (
    <details className="state-section folded" data-testid="state-scores">
      <summary className="sub-title">
        スコア・診断基準（臨床支援）：<span className="scores-summary">{summary}</span>
      </summary>
      <p className="note" data-testid="scores-note">
        <span className="tag">臨床支援・表から計算</span> clinical-playbook から取り込んだ定義（出典つき）を、この受診の記録の値で計算しています（AI は使っていません）。評価の日は {latest}
        。値のない項目は「未入力」で、あてはまらないとはしていません。手で選んだ答えはこの画面のメモリだけで、保存も送信もしません。最終判断は先生です。
      </p>
      {shown.length === 0 && <p className="note">いまの問題の名前・記録の値から勧められるスコア・基準はありません。下の一覧から開けます。</p>}
      {shown.map((r) => (
        <PresetCard key={r.preset.id} result={r} answers={answersOf(r.preset.id)} onAnswer={answer(r.preset.id)} />
      ))}
      {opened.map((r) => (
        <PresetCard
          key={r.preset.id}
          result={r}
          answers={answersOf(r.preset.id)}
          onAnswer={answer(r.preset.id)}
          onClose={() => {
            setExtra(extra.filter((id) => id !== r.preset.id));
          }}
        />
      ))}
      <details className="preset-picker" data-testid="preset-picker">
        <summary>ほかのスコア・基準を見る（{String(PRESETS.list.length)}）</summary>
        {presetsByArea().map(({ area, presets }) => (
          <div key={area.id} className="preset-area">
            <h4 className="part-label">{area.name}</h4>
            <div className="row-actions">
              {presets.map((p) => {
                const on = suggestedIds.has(p.id) || extra.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={on ? 'chip small on' : 'chip small'}
                    aria-pressed={on}
                    disabled={suggestedIds.has(p.id)}
                    onClick={() => {
                      setExtra(extra.includes(p.id) ? extra.filter((id) => id !== p.id) : [...extra, p.id]);
                    }}
                    data-testid="preset-pick"
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </details>
    </details>
  );
}
