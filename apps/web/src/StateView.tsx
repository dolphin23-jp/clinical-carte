// 「いまの状態」（段3b。CA-023・CA-026・CA-027）：患者の現在地を1画面に。作文しない：1行の要約は決定論のひな形、
// ほかは整理した事実と、保存した文の区切りの字そのもの。「いま」は記録の上での最後の日時で、端末の時計ではない。判定しない。
import { EVENT_KIND_NAMES, LIST_ACTIVITY_NAMES, LIST_CERTAINTY_NAMES, type ListItem, MEDICATION_ACTION_NAMES, PROBLEM_ACTIVITY_NAMES, PROBLEM_STATUS_NAMES, type PatientState, type RecentItem, recentGroups, SEGMENT_LABEL_NAMES } from '@clinical-carte/core';
import { useState } from 'react';

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
      return { tag: '検査', text: `${item.name} ${item.comparator ?? ''}${item.valueText}${item.unit === null ? '' : ` ${item.unit}`}` };
  }
}

const labText = (item: Extract<RecentItem, { type: 'lab' }>): string => `${item.name} ${item.comparator ?? ''}${item.valueText}${item.unit === null ? '' : ` ${item.unit}`}`;

/** 1つのまとまりで、はじめに見せる数（残りは畳む） */
const FIRST = 3;

function RecentRows({ items }: { items: readonly RecentItem[] }) {
  return (
    <>
      {items.map((item, i) => {
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
    </>
  );
}

/** 24時間の一覧を、種類ごとのまとまりで出す（中身は同じ。1日の濃い記録でも読めるように、新しいものから少しずつ見せる） */
function RecentList({ items }: { items: readonly RecentItem[] }) {
  const g = recentGroups(items);
  const groups: readonly (readonly [string, string, readonly RecentItem[]])[] = [
    ['problems', '問題', g.problems],
    ['medications', '投薬の動き', g.medications],
    ['events', 'できごと', g.events],
  ];
  return (
    <>
      {groups.map(([id, name, list]) =>
        list.length === 0 ? null : (
          <div key={id} className="recent-group" data-testid={`state-recent-${id}`}>
            <h4 className="part-label">
              {name}（{String(list.length)}）
            </h4>
            <ul className="fact-list">
              <RecentRows items={list.slice(0, FIRST)} />
            </ul>
            {list.length > FIRST && (
              <details>
                <summary>ほか {String(list.length - FIRST)} 件</summary>
                <ul className="fact-list">
                  <RecentRows items={list.slice(FIRST)} />
                </ul>
              </details>
            )}
          </div>
        ),
      )}
      {g.labs.length > 0 && (
        <div className="recent-group" data-testid="state-recent-labs">
          <h4 className="part-label">検査値（項目ごとのいちばん新しい値。{String(g.labs.length)} 項目）</h4>
          {g.repeatedLabs.length > 0 && (
            <p className="thread-sub" data-testid="state-recent-labs-repeated">
              この間に2回以上：{g.repeatedLabs.map((l) => `${labText(l.latest)}（${showDateTime(l.latest.at)}・${String(l.count)} 件）`).join('　')}
            </p>
          )}
          {g.singleLabs.length > 0 && (
            <details data-testid="state-recent-labs-single">
              <summary>この間に1回だけの項目（{String(g.singleLabs.length)}）</summary>
              <p className="thread-sub">{g.singleLabs.map((l) => `${labText(l.latest)}（${showDateTime(l.latest.at)}）`).join('　')}</p>
            </details>
          )}
        </div>
      )}
    </>
  );
}

/** 24時間の動きの数（見出しに出す。畳んでいても、何があったかの数が分かる） */
function recentCounts(items: readonly RecentItem[]): string {
  if (items.length === 0) return '記載なし';
  const g = recentGroups(items);
  return [
    g.problems.length > 0 ? `問題 ${String(g.problems.length)}` : null,
    g.medications.length > 0 ? `投薬の動き ${String(g.medications.length)}` : null,
    g.events.length > 0 ? `できごと ${String(g.events.length)}` : null,
    g.labs.length > 0 ? `検査 ${String(g.labs.length)} 項目` : null,
  ]
    .filter((x): x is string => x !== null)
    .join('・');
}

export function StateView({
  state,
  sources,
  onProblems,
  list = [],
  listBusy = false,
}: {
  state: PatientState;
  sources: readonly Source[];
  onProblems: () => void;
  /** AI のプロブレムリスト（CA-057。外したものを除いた項目）。あれば、いまの問題の主な見方にする */
  list?: readonly ListItem[];
  listBusy?: boolean;
}) {
  const textOf = (sourceId: string, start: number, end: number): string => sources.find((s) => s.id === sourceId)?.text.slice(start, end).trim() ?? '';
  // いまの問題は、名前の1行だけ。押すと、最後の A・P と、その問題の記載に書かれた値・薬が開く（段I。「いま」を1〜2画面に）。開いたものは画面のメモリだけ
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

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

      <div className="state-cols">
      <div className="state-col">
      {list.length > 0 && (
        <section className="state-section" data-testid="state-plist">
          <h3 className="sub-title">
            プロブレムリスト <span className="tag ai-tag">AI の整理</span>
            {listBusy && <span className="note">（組み直しています）</span>}
          </h3>
          <ul className="threads compact">
            {list
              .filter((item) => item.activity === 'active')
              .map((item, i) => {
                const on = open.has(`plist-${item.key}`);
                const linked = [...state.current, ...state.closed.map((thread) => ({ thread, notes: [], values: [], medications: [] }))].filter((e) => item.threadIds.includes(e.thread.id));
                return (
                  <li key={item.key} className={on ? 'thread open' : 'thread'} data-testid="state-plist-item">
                    <button
                      type="button"
                      className="thread-head thread-toggle"
                      aria-expanded={on}
                      onClick={() => {
                        toggle(`plist-${item.key}`);
                      }}
                    >
                      <span className="fold-mark" aria-hidden="true">
                        {on ? '▾' : '▸'}
                      </span>
                      <strong className="thread-name">
                        #{String(i + 1)} {item.name}
                      </strong>
                      <span className="tag">{LIST_CERTAINTY_NAMES[item.certainty]}</span>
                      {item.since !== null && <span className="thread-when">{showDateTime(item.since)}〜</span>}
                    </button>
                    {on && (
                      <>
                        {item.basis !== '' && <p className="thread-sub">{item.basis}</p>}
                        {linked.map((e) =>
                          e.notes.length > 0 ? (
                            <div key={e.thread.id} className="thread-note" data-testid="state-plist-note">
                              <span className="part-label">{e.thread.name}</span>
                              {e.notes.map((n) => (
                                <p key={`${n.sourceId}:${String(n.start)}`} className="source-text">
                                  {textOf(n.sourceId, n.start, n.end)}
                                </p>
                              ))}
                            </div>
                          ) : null,
                        )}
                      </>
                    )}
                  </li>
                );
              })}
          </ul>
          {list.some((item) => item.activity !== 'active') && (
            <p className="thread-sub">
              {list
                .filter((item) => item.activity !== 'active')
                .map((item) => `${item.name}（${LIST_ACTIVITY_NAMES[item.activity]}）`)
                .join('、')}
            </p>
          )}
        </section>
      )}

      <section className="state-section" data-testid="state-problems">
        <h3 className="sub-title">いまの問題（{String(state.current.length)}）</h3>
        {state.current.length === 0 ? (
          <p className="note">いまの問題として書かれたものはありません。</p>
        ) : (
          <>
            <div className="row-actions">
              <button
                type="button"
                className="chip small"
                onClick={() => {
                  const all = state.current.every(({ thread }) => open.has(thread.id));
                  setOpen(all ? new Set() : new Set([...state.current.map(({ thread }) => thread.id), ...(state.sharedPlan === null ? [] : ['shared'])]));
                }}
                data-testid="state-open-all"
              >
                {state.current.every(({ thread }) => open.has(thread.id)) ? 'すべて畳む' : 'すべて開く'}
              </button>
            </div>
            <ul className="threads compact">
              {state.current.map(({ thread, notes, values, medications }) => {
                const on = open.has(thread.id);
                return (
                  <li key={thread.id} className={on ? 'thread open' : 'thread'} data-testid="state-problem">
                    <button
                      type="button"
                      className="thread-head thread-toggle"
                      aria-expanded={on}
                      onClick={() => {
                        toggle(thread.id);
                      }}
                      data-testid="state-problem-head"
                    >
                      <span className="fold-mark" aria-hidden="true">
                        {on ? '▾' : '▸'}
                      </span>
                      <strong className="thread-name">{thread.name}</strong>
                      <span className="tag">{PROBLEM_STATUS_NAMES[thread.status]}</span>
                      <span className="thread-when">{showDateTime(notes[0]?.at ?? thread.last)}</span>
                    </button>
                    {on && (
                      <>
                        {notes.length > 0 ? (
                          <div className="thread-note" data-testid="state-note">
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
                            記載に書かれた値：{values.map((o) => `${o.name ?? o.nameRaw} ${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}（${showDateTime(o.at)}）`).join('・')}
                          </p>
                        )}
                        {medications.length > 0 && (
                          <p className="thread-sub" data-testid="state-problem-meds">
                            記載に書かれた薬：
                            {medications.map((m) => `${m.name} ${m.action === null ? '動きの記載なし' : MEDICATION_ACTION_NAMES[m.action]}（${showDateTime(m.at)}）`).join('・')}
                          </p>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {state.sharedPlan !== null && (
          <div className={open.has('shared') ? 'thread open' : 'thread'} data-testid="state-shared">
            <button
              type="button"
              className="thread-head thread-toggle"
              aria-expanded={open.has('shared')}
              onClick={() => {
                toggle('shared');
              }}
              data-testid="state-shared-head"
            >
              <span className="fold-mark" aria-hidden="true">
                {open.has('shared') ? '▾' : '▸'}
              </span>
              <strong className="thread-name">記載全体の方針</strong>
              <span className="tag">問題に分けて書かれていない P</span>
              <span className="thread-when">{showDateTime(state.sharedPlan.at)}</span>
            </button>
            {open.has('shared') && (
              <div className="thread-note" data-testid="state-shared-plan">
                {state.sharedPlan.parts.map((n) => (
                  <p key={`${n.sourceId}:${String(n.start)}`} className="source-text">
                    <span className="sr-only">{SEGMENT_LABEL_NAMES[n.label]}：</span>
                    {textOf(n.sourceId, n.start, n.end)}
                  </p>
                ))}
              </div>
            )}
          </div>
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
      </div>
      <div className="state-col">

      {state.recent !== null && (
        <details className="state-section folded" data-testid="state-recent">
          <summary className="sub-title">
            最後の記録までの24時間（{showDateTime(state.recent.from)}〜{showDateTime(state.recent.to)}）：{recentCounts(state.recent.items)}
          </summary>
          {state.recent.items.length === 0 ? (
            <p className="note">この間に、問題・投薬の動き・できごと・検査値の記載はありません（バイタルは上の帯と経過表）。</p>
          ) : (
            <RecentList items={state.recent.items} />
          )}
        </details>
      )}

      {(state.medications.length > 0 || state.stoppedMedications.length > 0) && (
        <details className="state-section folded" data-testid="state-medications">
          <summary className="sub-title">
            投薬（薬ごとの最後の記載。{String(state.medications.length)} 種{state.stoppedMedications.length > 0 && `・中止と書かれたもの ${String(state.stoppedMedications.length)}`}）
          </summary>
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
        </details>
      )}

      {state.background.length > 0 && (
        <details className="state-section folded" data-testid="state-background">
          <summary className="sub-title">背景（{state.background.map((b) => b.name).join('・')}）</summary>
          {state.background.map((b) => (
            <div key={b.label} className="thread-note" data-testid="state-background-part">
              <span className="part-label">
                {b.name}・{showDateTime(b.at)}
                {b.others > 0 && `（ほかの記載にも ${String(b.others)} 件）`}
              </span>
              <p className="source-text">{textOf(b.sourceId, b.start, b.end)}</p>
            </div>
          ))}
        </details>
      )}
      </div>
      </div>
    </div>
  );
}
