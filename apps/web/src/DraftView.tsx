// 草案（段4。CA-023）：入院後経過（問題ごと）の AI の草案。**保存しない**：画面のメモリだけに持ち、ほかのタブ・患者へ移ると消える。
// 文ごとに、根拠の引用（保存した文の字そのもの）を開ける。確かめ（数・根拠・識別情報の形）を通らなかった文は出さず、理由ごとの数だけ。
// 病院のカルテへ戻す向きは作らない（CA-001）ので、コピーのボタンは置かない。
import { DRAFT_REJECT_NAMES, type DraftRejectReason } from '@clinical-carte/core';
import { useState } from 'react';

import { showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { type DraftResult, requestDraft } from './net/api.ts';

export function DraftView({ encounterId, onLeft }: { encounterId: string; onLeft: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DraftResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const make = () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    void requestDraft(encounterId).then((r) => {
      setBusy(false);
      if (r.ok) setResult(r.value);
      else if (r.error === 'unregistered') onLeft();
      else setMessage(errorMessage(r.error).replace('文は保存していません。', ''));
    });
  };

  const rejected = result === null ? [] : (Object.entries(result.draft.rejected) as [DraftRejectReason, number][]).filter(([, n]) => n > 0);
  const rejectedTotal = rejected.reduce((n, [, v]) => n + v, 0);

  return (
    <div className="draft" data-testid="draft">
      <p className="draft-banner">AI の草案です。保存しません（ほかのタブや患者へ移ると消えます）。正本は病院のカルテで、この草案は記録ではありません。</p>
      <p className="note">
        入院後経過を、問題ごとに下書きします。材料は、この受診の記載のうち、問題ごとの A・P と、その問題の記載に書かれた投薬・できごとだけです。文ごとに根拠の引用を確かめ、引用にない数がある文・根拠のない文は出しません。AI を 1 回使います。
      </p>
      <button type="button" className="button primary" disabled={busy} onClick={make} data-testid="draft-make">
        {busy ? '作っています…（30 秒ほどかかることがあります）' : result === null ? '入院後経過の草案を作る' : 'もう一度作る'}
      </button>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {result !== null && (
        <>
          {result.draft.sections.length === 0 ? (
            <p className="note">確かめを通った文がありませんでした。</p>
          ) : (
            result.draft.sections.map((section) => (
              <section key={section.problem.ref} className="draft-section" data-testid="draft-section">
                <h3 className="sub-title">{section.problem.name}</h3>
                <ol className="draft-sentences">
                  {section.sentences.map((s, i) => (
                    <li key={i} className="draft-sentence" data-testid="draft-sentence">
                      <details>
                        <summary>
                          {s.text}
                          <span className="draft-cites">（根拠 {String(s.cites.length)}）</span>
                        </summary>
                        <ul className="draft-quotes">
                          {s.cites.map((q) => (
                            <li key={q.id} data-testid="draft-quote">
                              <span className="part-label">
                                {showDateTime(q.at)}
                                {q.day !== null && `・${String(q.day)}病日`}・{q.from}
                              </span>
                              <span className="source-text">{q.text}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  ))}
                </ol>
              </section>
            ))
          )}
          <p className="note" data-testid="draft-report">
            材料にした引用 {String(result.quotes)} 件
            {result.dropped > 0 && `（長すぎるため、古い引用 ${String(result.dropped)} 件を除いた）`}。
            {rejectedTotal > 0 ? `確かめを通らず出さなかった文 ${String(rejectedTotal)}（${rejected.map(([k, n]) => `${DRAFT_REJECT_NAMES[k]} ${String(n)}`).join('・')}）。` : '確かめを通らなかった文はありません。'}
          </p>
        </>
      )}
    </div>
  );
}
