// 「いまの状態」（段3b。CA-023・CA-026・CA-027）：患者の現在地を1画面に。作文しない：1行の要約は決定論のひな形、
// ほかは整理した事実と、保存した文の区切りの字そのもの。「いま」は記録の上での最後の日時で、端末の時計ではない。判定しない。
import { EVENT_KIND_NAMES, MEDICATION_ACTION_NAMES, PROBLEM_ACTIVITY_NAMES, PROBLEM_STATUS_NAMES, type PatientState, type RecentItem, SEGMENT_LABEL_NAMES } from '@clinical-carte/core';

import { showDateTime } from './format.ts';
import type { Source } from './net/api.ts';

function recentText(item: RecentItem): { tag: string; text: string } {
  switch (item.type) {
    case 'problem_new':
      return { tag: '問題', text: `${item.name}（はじめて書かれた）` };
    case 'problem_activity':
      return { tag: '問題', text: `${item.name}（${PROBLEM_ACTIVITY_NAMES[item.activity]}）` };
    case 'medication':
      return { tag: `投薬・${MEDICATION_ACTION_NAMES[item.action]}`, text: item.doseText === null ? item.name : `${item.name} ${item.doseText}` };
    case 'event':
      return { tag: EVENT_KIND_NAMES[item.kind], text: item.title };
    case 'lab':
      return { tag: '検査', text: `${item.name} ${item.valueText}${item.unit === null ? '' : ` ${item.unit}`}` };
  }
}

export function StateView({ state, sources, onProblems }: { state: PatientState; sources: readonly Source[]; onProblems: () => void }) {
  const textOf = (sourceId: string, start: number, end: number): string => sources.find((s) => s.id === sourceId)?.text.slice(start, end).trim() ?? '';

  return (
    <div className="state" data-testid="state">
      <p className="one-liner" data-testid="one-liner">
        {state.oneLiner}
      </p>
      <p className="state-asof" data-testid="state-asof">
        {state.asOf === null ? 'この受診には、まだ記録がありません。' : `記録の上で最後：${showDateTime(state.asOf)}`}
        {state.lastEntered !== null && `（最後に入れた日時：${showDateTime(state.lastEntered)}）`}
        。病院のカルテの写しで、最新とは限りません。
      </p>

      <section className="state-section" data-testid="state-problems">
        <h3 className="sub-title">いまの問題（{String(state.current.length)}）</h3>
        {state.current.length === 0 ? (
          <p className="note">いまの問題として書かれたものはありません。</p>
        ) : (
          <ul className="threads">
            {state.current.map(({ thread, notes, values, medications }) => (
              <li key={thread.id} className="thread" data-testid="state-problem">
                <div className="thread-head">
                  <strong className="thread-name">{thread.name}</strong>
                  <span className="tag">{PROBLEM_STATUS_NAMES[thread.status]}</span>
                </div>
                {notes.length > 0 ? (
                  <div className="thread-note" data-testid="state-note">
                    <span className="part-label">{showDateTime(notes[0]?.at ?? null)}</span>
                    {notes.map((n) => (
                      <p key={`${n.sourceId}:${String(n.start)}`} className="source-text">
                        <span className="sr-only">{SEGMENT_LABEL_NAMES[n.label]}：</span>
                        {textOf(n.sourceId, n.start, n.end)}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="thread-sub">A・P の区切りは見つかっていません（最後の記載 {showDateTime(thread.last)}）。</p>
                )}
                {values.length > 0 && (
                  <p className="thread-sub" data-testid="state-problem-values">
                    記載に書かれた値：{values.map((o) => `${o.name ?? o.nameRaw} ${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}（${showDateTime(o.at)}）`).join('・')}
                  </p>
                )}
                {medications.length > 0 && (
                  <p className="thread-sub" data-testid="state-problem-meds">
                    記載に書かれた薬：
                    {medications.map((m) => `${m.name} ${m.action === null ? '動きの記載なし' : MEDICATION_ACTION_NAMES[m.action]}（${showDateTime(m.at)}）`).join('・')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {(state.closed.length > 0 || state.ruledOut.length > 0) && (
          <p className="thread-sub" data-testid="state-closed">
            {state.closed.length > 0 && `解決・非活動と書かれたもの：${state.closed.map((t) => t.name).join('、')}。`}
            {state.ruledOut.length > 0 && `否定的と書かれたもの：${state.ruledOut.map((t) => t.name).join('、')}。`}
          </p>
        )}
        {state.unlinked > 0 && <p className="note">問題の筋につないでいない記載が {String(state.unlinked)} 件あります。</p>}
        <button type="button" className="button small" onClick={onProblems} data-testid="state-to-problems">
          問題のタブで、くわしく見る・直す
        </button>
      </section>

      {state.recent !== null && (
        <section className="state-section" data-testid="state-recent">
          <h3 className="sub-title">
            最後の記録までの24時間（{showDateTime(state.recent.from)}〜{showDateTime(state.recent.to)}）
          </h3>
          {state.recent.items.length === 0 ? (
            <p className="note">この間に、問題・投薬の動き・できごと・検査値の記載はありません（バイタルは上の帯と経過表）。</p>
          ) : (
            <ul className="fact-list">
              {state.recent.items.map((item, i) => {
                const t = recentText(item);
                return (
                  <li key={i} className="fact-row" data-testid="state-recent-item">
                    <span className="fact-when">{showDateTime(item.at)}</span>
                    <span className="fact-main">
                      <span className="tag">{t.tag}</span>
                      {t.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {(state.medications.length > 0 || state.stoppedMedications.length > 0) && (
        <section className="state-section" data-testid="state-medications">
          <h3 className="sub-title">投薬（薬ごとの最後の記載）</h3>
          <ul className="fact-list">
            {state.medications.map((m) => (
              <li key={m.name} className="fact-row">
                <span className="fact-when">{showDateTime(m.at)}</span>
                <span className="fact-main">
                  {m.name}
                  <span className="tag">{m.action === null ? '動きの記載なし' : MEDICATION_ACTION_NAMES[m.action]}</span>
                  {m.doseText !== null && <span className="fact-dose">{m.doseText}</span>}
                </span>
              </li>
            ))}
          </ul>
          {state.stoppedMedications.length > 0 && <p className="thread-sub">中止と書かれたもの：{state.stoppedMedications.map((m) => `${m.name}（${showDateTime(m.at)}）`).join('、')}</p>}
          <p className="note">いま続いているかは、書かれていないので補っていません。</p>
        </section>
      )}

      {state.background.length > 0 && (
        <section className="state-section" data-testid="state-background">
          <h3 className="sub-title">背景（いちばん新しい記載の、その区切り）</h3>
          {state.background.map((b) => (
            <div key={b.label} className="thread-note" data-testid="state-background-part">
              <span className="part-label">
                {b.name}・{showDateTime(b.at)}
                {b.others > 0 && `（ほかの記載にも ${String(b.others)} 件）`}
              </span>
              <p className="source-text">{textOf(b.sourceId, b.start, b.end)}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
