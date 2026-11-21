// 整理の評価（docs/03 の 3。CD-018）：作りものの文を、配ってあるサーバーの鍵・モデルで、いまの版か前の版の整理の指示で整理し、
// 記録に入る行（確かめの網を通った後）を、文ごとの決まりで数える。いまの版と前の版を、同じ文で並べて比べられる。
// 実際の記録は使わない・保存しない。出すのは、数と、決まりの説明だけ（決まりは架空の文のもの。AI の答えの文は出さない）。
import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from './messages.ts';
import { getOrganizeCheck, type OrganizeCheckInfo, type OrganizeCheckResult, type OrganizePrompt, runOrganizeCheck } from './net/api.ts';

export interface OrganizeSummary {
  readonly cases: number;
  /** 決まりを超えた（拾いすぎ）数の合計 */
  readonly extra: number;
  /** 足りない（拾い漏れ）数の合計 */
  readonly missing: number;
  readonly failed: number;
}

export function summarizeOrganize(results: readonly OrganizeCheckResult[]): OrganizeSummary {
  return {
    cases: results.length,
    extra: results.reduce((n, r) => n + r.extra.length, 0),
    missing: results.reduce((n, r) => n + r.missing.length, 0),
    failed: results.filter((r) => r.failed !== null).length,
  };
}

const PROMPTS: readonly OrganizePrompt[] = ['current', 'previous'];
const PROMPT_NAMES: Readonly<Record<OrganizePrompt, string>> = { current: 'いまの版', previous: '前の版' };

export function OrganizeCheck({ onLeft }: { onLeft: () => void }) {
  const [info, setInfo] = useState<OrganizeCheckInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState<OrganizePrompt | null>(null);
  const [results, setResults] = useState<Partial<Record<OrganizePrompt, OrganizeCheckResult[]>>>({});

  const load = useCallback(() => {
    void getOrganizeCheck().then((result) => {
      if (result.ok) setInfo(result.value);
      else if (result.error === 'unregistered') onLeft();
      else setMessage(errorMessage(result.error));
    });
  }, [onLeft]);
  useEffect(load, [load]);

  const run = async (prompt: OrganizePrompt, cases: OrganizeCheckInfo['cases']) => {
    setRunning(prompt);
    setMessage(null);
    const done: OrganizeCheckResult[] = [];
    setResults((r) => ({ ...r, [prompt]: [] }));
    for (const c of cases) {
      const result = await runOrganizeCheck(c.id, prompt);
      if (!result.ok) {
        if (result.error === 'unregistered') onLeft();
        else setMessage(errorMessage(result.error));
        break;
      }
      done.push(result.value);
      setResults((r) => ({ ...r, [prompt]: [...done] }));
    }
    setRunning(null);
  };

  const total = info?.cases.length ?? 0;
  const labelOf = (caseId: string, ruleId: string): string => info?.cases.find((c) => c.id === caseId)?.rules.find((r) => r.id === ruleId)?.label ?? ruleId;

  return (
    <section className="card" aria-labelledby="organizecheck-title" data-testid="organizecheck">
      <h2 id="organizecheck-title">整理の評価</h2>
      <p className="note">
        作りものの文（{String(total)} 種）を AI に整理させ、記録に入る行を、文ごとの決まりで数えます。「余分」は拾いすぎ（所見を問題にする・言い直しを二重に入れる など）、「欠け」は拾い漏れです。いまの版と前の版の指示を、同じ文で比べられます。実際の記録は使いません。文も結果も、保存しません。1回につき AI を {String(total)} 回呼びます。
      </p>
      {info !== null && (
        <p className="note" data-testid="organizecheck-config">
          モデル：{info.model}・いまの版：{info.versions.current}・前の版：{info.versions.previous}
        </p>
      )}
      {info !== null && !info.ready && (
        <p className="alert" role="alert">
          サーバーに、AI の鍵が設定されていません。鍵を置いてから、動かしてください。
        </p>
      )}
      {message !== null && (
        <p className="alert" role="alert" data-testid="organizecheck-error">
          {message}
        </p>
      )}
      <div className="actions">
        {PROMPTS.map((prompt) => (
          <button
            key={prompt}
            className={prompt === 'current' ? 'button primary' : 'button'}
            type="button"
            disabled={running !== null || info === null || !info.ready}
            onClick={() => {
              if (info !== null) void run(prompt, info.cases);
            }}
            data-testid={`run-organizecheck-${prompt}`}
          >
            {running === prompt
              ? `動かしています… ${String(results[prompt]?.length ?? 0)} / ${String(total)}`
              : `${PROMPT_NAMES[prompt]}（${info?.versions[prompt] ?? ''}）で動かす`}
          </button>
        ))}
      </div>
      {PROMPTS.map((prompt) => {
        const list = results[prompt];
        if (list === undefined || list.length === 0) return null;
        const s = summarizeOrganize(list);
        return (
          <div key={prompt} className="result" data-testid={`organizecheck-result-${prompt}`}>
            <p className="result-line">
              <strong>
                {PROMPT_NAMES[prompt]}（{info?.versions[prompt] ?? ''}）：余分 {String(s.extra)}・欠け {String(s.missing)}
              </strong>
              （どちらも目標は 0）
            </p>
            <p className="result-line">
              整理が通らなかった：{String(s.failed)} 件・調べた文：{String(list.length)} / {String(total)}
            </p>
            <ul className="result-list">
              {list.map((r) => (
                <li key={r.id}>
                  {r.id}：
                  {r.failed !== null
                    ? `通らず（${r.failed}）`
                    : r.extra.length === 0 && r.missing.length === 0
                      ? '決まりどおり'
                      : [...r.extra.map((id) => `余分「${labelOf(r.id, id)}」`), ...r.missing.map((id) => `欠け「${labelOf(r.id, id)}」`)].join('、')}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {results.current !== undefined && results.previous !== undefined && running === null && results.current.length === total && results.previous.length === total && total > 0 && (
        <p className="note" role="status" data-testid="organizecheck-compare">
          同じ文で、いまの版は余分 {String(summarizeOrganize(results.current).extra)}・欠け {String(summarizeOrganize(results.current).missing)}、前の版は余分 {String(summarizeOrganize(results.previous).extra)}・欠け{' '}
          {String(summarizeOrganize(results.previous).missing)}
          でした。AI の答えは毎回少し揺れるので、それぞれ 2〜3 回動かして比べてください。数と文の id を、エージェントに知らせてください。
        </p>
      )}
    </section>
  );
}
