// AI のプロブレムリスト（段J。CA-057）：記録全体から AI が組んだ #1… のリストを、問題のタブの主な見方にする。
// - 記録が増えた・整理し直した（listBasis が変わった）ら、開いたときに自動で組み直す（AI の 1 回。先生の直しは引き継ぐ）
// - 名前は AI が整えたもの。結びつけた「記録に書かれた問題」の名前と、経過の出来事を並べて出す。「AI の整理」の印
// - 先生は直せる：名前（選別を通す）・確からしさ・状態・並べ替え・外す（外したものは下で戻せる）
// - 判定しない：色を付けない。確からしさ・状態は、書かれたこと（と AI の整理）を語で出すだけ
import { COURSE_CATEGORY_NAMES, LIST_ACTIVITIES, LIST_ACTIVITY_NAMES, LIST_CERTAINTIES, LIST_CERTAINTY_NAMES, LIST_NAME_MAX, type ListItem, listBasis, type ListPatch, numberedList, threadViews } from '@clinical-carte/core';
import { useEffect, useRef, useState } from 'react';

import { showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { type ApiError, type CourseItem, generateProblemList, patchProblemList, type PatientRecord } from './net/api.ts';

const say = (error: ApiError): string => errorMessage(error).replace('文は保存していません。', '');

export interface ListBuild {
  readonly busy: boolean;
  readonly message: string | null;
  readonly build: () => void;
}

/**
 * プロブレムリストを組む係（患者の画面に1つ）。記録の印が変わったら、自動で1回だけ組み直す（記載の整理がすべて終わってから）。
 * 失敗したら、押して組み直す
 */
export function useProblemList(patientId: string, record: PatientRecord | null, onChanged: () => void, onLeft: () => void): ListBuild {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const tried = useRef<string | null>(null);
  const build = () => {
    setBusy(true);
    setMessage(null);
    void generateProblemList(patientId).then((r) => {
      setBusy(false);
      if (r.ok) onChanged();
      else if (r.error === 'unregistered') onLeft();
      else if (r.error !== 'list_empty') setMessage(`プロブレムリストを組み直せませんでした（${say(r.error)}）`);
    });
  };
  const basis = record === null ? null : listBasis(record.sources);
  useEffect(() => {
    // 組む材料（記録に書かれた問題・経過の出来事）がなければ、呼ばない（サーバーも断る）
    if (record === null || basis === null || busy || tried.current === basis || (record.problems.length === 0 && record.course.length === 0)) return;
    const stale = record.problemList === null || record.problemList.basis !== basis;
    const organizing = record.sources.some((s) => s.organized === null);
    if (!stale || organizing) return;
    tried.current = basis;
    build();
  });
  return { busy, message, build };
}

export function ProblemListView({ patientId, record, builder, onChanged, onLeft }: { patientId: string; record: PatientRecord; builder: ListBuild; onChanged: () => void; onLeft: () => void }) {
  const list = record.problemList;
  const stale = list === null || list.basis !== listBasis(record.sources);
  const { busy, build } = builder;
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ key: string; text: string } | null>(null);

  const patch = (p: ListPatch) => {
    setMessage(null);
    void patchProblemList(patientId, p).then((r) => {
      if (r.ok) onChanged();
      else if (r.error === 'unregistered') onLeft();
      else setMessage(say(r.error));
    });
  };

  const threads = threadViews(record.problemThreads, record.problems).threads;
  const items = list?.items ?? [];
  // 番号は core の numberedList の1か所（いま・1行の要約・回診リストと同じ）
  const shown = numberedList(items);
  const hidden = items.filter((i) => i.hidden);
  const courseOf = (item: ListItem): CourseItem[] => item.course.map((p) => record.course.find((c) => c.sourceId === p.sourceId && c.start === p.start)).filter((c): c is CourseItem => c !== undefined);

  return (
    <section className="plist" data-testid="plist" aria-labelledby="plist-title">
      <div className="plist-head">
        <h3 id="plist-title" className="sub-title">
          プロブレムリスト <span className="tag ai-tag">AI の整理</span>
        </h3>
        <button type="button" className="button small" disabled={busy} onClick={build} data-testid="plist-build">
          {busy ? '組んでいます…' : 'AI で組み直す'}
        </button>
      </div>
      <p className="note" data-testid="plist-state">
        {busy
          ? '記録全体から、プロブレムリストを組んでいます。'
          : list === null
            ? '記録から、AI がプロブレムリストを組みます。'
            : `${showDateTime(list.madeAt)} に組みました${stale ? '（そのあと記録が増えました）' : ''}。名前は AI が整えたもので、下に記録に書かれた名前を出します。`}
      </p>
      {(message ?? builder.message) !== null && (
        <p className="alert" role="alert">
          {message ?? builder.message}
        </p>
      )}
      {shown.length > 0 && (
        <ol className="plist-items">
          {shown.map(({ item, no }, i) => {
            const on = open === item.key;
            const written = item.threadIds.map((id) => threads.find((t) => t.id === id)?.name).filter((n): n is string => n !== undefined);
            return (
              <li key={item.key} className={on ? 'plist-item open' : 'plist-item'} data-testid="plist-item">
                <button
                  type="button"
                  className="thread-head thread-toggle"
                  aria-expanded={on}
                  onClick={() => {
                    setOpen(on ? null : item.key);
                  }}
                  data-testid="plist-item-head"
                >
                  <span className="fold-mark" aria-hidden="true">
                    {on ? '▾' : '▸'}
                  </span>
                  <strong className="thread-name">
                    #{String(no)} {item.name}
                  </strong>
                  <span className="tag">{LIST_CERTAINTY_NAMES[item.certainty]}</span>
                  {item.activity !== 'active' && <span className="tag">{LIST_ACTIVITY_NAMES[item.activity]}</span>}
                  {item.since !== null && <span className="thread-when">{showDateTime(item.since)}〜</span>}
                </button>
                {on && (
                  <div className="plist-body">
                    {item.basis !== '' && (
                      <p className="thread-sub" data-testid="plist-basis">
                        <span className="tag ai-tag">AI</span>
                        {item.basis}
                      </p>
                    )}
                    {written.length > 0 && <p className="thread-sub">記録に書かれた名前：{written.join('・')}</p>}
                    {courseOf(item).length > 0 && (
                      <ul className="fact-list">
                        {courseOf(item).map((c) => (
                          <li key={c.id} className="fact-row">
                            <span className="fact-when">
                              {showDateTime(c.at)}
                              {c.atApprox !== null && `（${c.atApprox}）`}
                            </span>
                            <span className="fact-main">
                              <span className="tag">{COURSE_CATEGORY_NAMES[c.category]}</span>
                              {c.summary}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {item.self.length > 0 && <p className="note">先生が直したところ：{item.self.map((f) => ({ name: '名前', certainty: '確からしさ', activity: '状態' })[f]).join('・')}</p>}
                    <div className="plist-edit">
                      {naming?.key === item.key ? (
                        <span className="row-actions">
                          <input
                            className="input compact"
                            value={naming.text}
                            maxLength={LIST_NAME_MAX}
                            aria-label="名前を直す"
                            onChange={(e) => {
                              setNaming({ key: item.key, text: e.target.value });
                            }}
                            data-testid="plist-name-input"
                          />
                          <button
                            type="button"
                            className="button small"
                            disabled={naming.text.trim() === ''}
                            onClick={() => {
                              patch({ key: item.key, name: naming.text.trim() });
                              setNaming(null);
                            }}
                            data-testid="plist-name-save"
                          >
                            決める
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="button small"
                          onClick={() => {
                            setNaming({ key: item.key, text: item.name });
                          }}
                          data-testid="plist-name"
                        >
                          名前を直す
                        </button>
                      )}
                      <select
                        value={item.certainty}
                        aria-label="確からしさ"
                        onChange={(e) => {
                          patch({ key: item.key, certainty: e.target.value as ListItem['certainty'] });
                        }}
                        data-testid="plist-certainty"
                      >
                        {LIST_CERTAINTIES.map((c) => (
                          <option key={c} value={c}>
                            {LIST_CERTAINTY_NAMES[c]}
                          </option>
                        ))}
                      </select>
                      <select
                        value={item.activity}
                        aria-label="状態"
                        onChange={(e) => {
                          patch({ key: item.key, activity: e.target.value as ListItem['activity'] });
                        }}
                        data-testid="plist-activity"
                      >
                        {LIST_ACTIVITIES.map((a) => (
                          <option key={a} value={a}>
                            {LIST_ACTIVITY_NAMES[a]}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="button small" disabled={i === 0} onClick={() => { patch({ key: item.key, move: 'up' }); }}>
                        ↑
                      </button>
                      <button type="button" className="button small" disabled={i === shown.length - 1} onClick={() => { patch({ key: item.key, move: 'down' }); }}>
                        ↓
                      </button>
                      <button type="button" className="button small" onClick={() => { patch({ key: item.key, hidden: true }); }} data-testid="plist-hide">
                        外す
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {list !== null && shown.length === 0 && !busy && <p className="note">プロブレムリストに入れた問題はありません。</p>}
      {hidden.length > 0 && (
        <details className="plist-hidden" data-testid="plist-hidden">
          <summary>外した問題（{String(hidden.length)}）</summary>
          <ul className="fact-list">
            {hidden.map((item) => (
              <li key={item.key} className="fact-row">
                <span className="fact-main">{item.name}</span>
                <button type="button" className="button small" onClick={() => { patch({ key: item.key, hidden: false }); }}>
                  戻す
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
