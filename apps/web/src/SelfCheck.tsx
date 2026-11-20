// 選別の評価（docs/03 の 3、docs/05 の作業 8）：架空の文に、その場で組み立てた架空の氏名・番号・施設名を混ぜ、
// 配ってあるサーバーの鍵・指示・モデルで、AI の選別を通して、漏れを数える。実際の記録は使わない・保存しない。
// 出すのは、数と、文の id だけ（文そのもの・混ぜた名前は、画面にも出さない）。
import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from './messages.ts';
import { getSelfCheck, runSelfCheck, type SelfCheckInfo, type SelfCheckResult } from './net/api.ts';

/** 架空の名前を組み立てる種（押すたびに変わる） */
function newSeed(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % 1_000_000_000 || 1;
}

export interface SelfCheckSummary {
  readonly cases: number;
  readonly leakedCases: number;
  readonly leaked: number;
  readonly failed: number;
  readonly lost: number;
  readonly inexact: number;
}

export function summarize(results: readonly SelfCheckResult[]): SelfCheckSummary {
  return {
    cases: results.length,
    leakedCases: results.filter((r) => r.leaked > 0).length,
    leaked: results.reduce((n, r) => n + r.leaked, 0),
    failed: results.filter((r) => r.failed !== null).length,
    lost: results.filter((r) => r.lost > 0).length,
    inexact: results.filter((r) => r.exact === false).length,
  };
}

/** 1つの文の結果の、短い説明（なければ null＝問題なし） */
export function noteOf(r: SelfCheckResult): string | null {
  const notes = [
    r.leaked > 0 ? `漏れ ${String(r.leaked)} か所` : null,
    r.failed !== null ? `通らず（${r.failed}）` : null,
    r.lost > 0 ? `残すべき語が消えた ${String(r.lost)}` : null,
    r.exact === false ? `混ぜた場所のほかも置き換えた（変わった部分：${r.altered.map((a) => `「${a}」`).join('')}）` : null,
  ].filter((n): n is string => n !== null);
  return notes.length === 0 ? null : notes.join('、');
}

export function SelfCheck({ onLeft }: { onLeft: () => void }) {
  const [info, setInfo] = useState<SelfCheckInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SelfCheckResult[] | null>(null);
  const [stopped, setStopped] = useState(false);

  const load = useCallback(() => {
    void getSelfCheck().then((result) => {
      if (result.ok) setInfo(result.value);
      else if (result.error === 'unregistered') onLeft();
      else setMessage(errorMessage(result.error));
    });
  }, [onLeft]);
  useEffect(load, [load]);

  const run = async (cases: SelfCheckInfo['cases']) => {
    setRunning(true);
    setStopped(false);
    setMessage(null);
    setResults([]);
    const seed = newSeed();
    const done: SelfCheckResult[] = [];
    for (const [i, c] of cases.entries()) {
      const result = await runSelfCheck(c.id, seed + i);
      if (!result.ok) {
        if (result.error === 'unregistered') onLeft();
        else setMessage(errorMessage(result.error));
        setStopped(true);
        break;
      }
      done.push(result.value);
      setResults([...done]);
    }
    setRunning(false);
  };

  const total = info?.cases.length ?? 0;
  const finished = results !== null && !running && !stopped && results.length === total && total > 0;
  const summary = results === null ? null : summarize(results);
  const problems = (results ?? []).map((r) => ({ id: r.id, note: noteOf(r) })).filter((p) => p.note !== null);

  return (
    <section className="card" aria-labelledby="selfcheck-title" data-testid="selfcheck">
      <h2 id="selfcheck-title">選別の評価</h2>
      <p className="note">
        作りものの文（{String(total)} 種）に、その場で組み立てた架空の氏名・番号・連絡先・施設名を混ぜて、AI の選別を通し、残ったものを数えます。実際の記録は使いません。文も結果も、保存しません。AI を {String(total)} 回呼びます（1〜2 分）。
      </p>
      {info !== null && (
        <p className="note" data-testid="selfcheck-config">
          モデル：{info.model}・指示の版：{info.promptVersion}
        </p>
      )}
      {info !== null && !info.ready && (
        <p className="alert" role="alert">
          サーバーに、AI の鍵が設定されていません。鍵を置いてから、動かしてください。
        </p>
      )}
      {message !== null && (
        <p className="alert" role="alert" data-testid="selfcheck-error">
          {message}
        </p>
      )}
      <div className="actions">
        <button
          className="button primary"
          type="button"
          disabled={running || info === null || !info.ready}
          onClick={() => {
            if (info !== null) void run(info.cases);
          }}
          data-testid="run-selfcheck"
        >
          {running ? `動かしています… ${String(results?.length ?? 0)} / ${String(total)}` : results === null ? '評価を動かす' : 'もう一度（別の名前で）'}
        </button>
      </div>
      {summary !== null && results !== null && results.length > 0 && (
        <div className="result" data-testid="selfcheck-result">
          <p className="result-line">
            <strong>
              漏れ（識別情報が残った）：{String(summary.leakedCases)} 件・{String(summary.leaked)} か所
            </strong>
            （目標は 0）
          </p>
          <p className="result-line">選別が通らなかった（保存されない）：{String(summary.failed)} 件</p>
          <p className="result-line">残すべき語が消えた（指しすぎ）：{String(summary.lost)} 件</p>
          <p className="result-line">混ぜた場所のほかも置き換えた：{String(summary.inexact)} 件</p>
          <p className="result-line">
            調べた文：{String(results.length)} / {String(total)}
          </p>
          {problems.length > 0 && (
            <ul className="result-list">
              {problems.map((p) => (
                <li key={p.id}>
                  {p.id}：{p.note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {finished && summary !== null && summary.leaked === 0 && summary.failed === 0 && (
        <p className="done" role="status" data-testid="selfcheck-verdict">
          この回は、漏れが 0 でした。別の名前でも、もう 2 回動かして、0 が続くことを確かめてください。漏れが 0 でも、実際の文で必ず落とせる保証ではありません（氏名・ID は、打たないのが主の守りです）。
        </p>
      )}
      {finished && summary !== null && (summary.leaked > 0 || summary.failed > 0) && (
        <p className="alert" role="alert" data-testid="selfcheck-verdict">
          {summary.leaked > 0 ? '漏れがありました。実際の患者の文は、まだ入れないでください。' : '通らなかった文がありました。'}
          上の数と、文の id を、エージェントに知らせてください（AI への指示を直します）。
        </p>
      )}
      {stopped && (
        <p className="note">途中で止まりました。上の誤りを確かめて、もう一度動かしてください。</p>
      )}
    </section>
  );
}
