// 問題の筋（段3a。CA-024・CA-025）：記載ごとの問題を、患者ごとの筋に束ねて並べる。POMR のプロブレムリストの形。
// 並べるだけ（判定しない）：確からしさと、解決・非活動は、いちばん新しい記載に書かれたとおり。問題ごとの A・P は、保存した文の、その区切りの字そのもの。
// 直す（つなぎ直す・分ける・統合・表示の名前）は本人の操作で、履歴が残る。名前は打たず、書かれた名前から選ぶ。
import {
  compareDateTime,
  EVENT_KIND_NAMES,
  labTrends,
  MEDICATION_ACTION_NAMES,
  medicationTimeline,
  nameKey,
  PROBLEM_ACTIVITY_NAMES,
  PROBLEM_STATUS_NAMES,
  type ProblemNote,
  problemNotes,
  relatedFacts,
  SEGMENT_LABEL_NAMES,
  SOURCE_KIND_LABELS,
  THREAD_GROUP_NAMES,
  type ThreadGroup,
  type ThreadView,
  threadViews,
} from '@clinical-carte/core';
import { useState } from 'react';

import { TrendGrid } from './charts/TrendGrid.tsx';
import { showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { type ClinicalEvent, type HistoryEntry, linkProblems, mergeThread, moveProblem, nameThread, type Medication, type Observation, type Problem, type ProblemThread, type Result, type Segment, type Source } from './net/api.ts';

const GROUPS: readonly ThreadGroup[] = ['current', 'closed', 'ruled_out'];
const ORIGIN_NAMES = { rule: '名前が同じ', ai: 'AI がつないだ', self: '本人が直した' } as const;

interface Props {
  readonly patientId: string;
  readonly problems: readonly Problem[];
  readonly threads: readonly ProblemThread[];
  readonly segments: readonly Segment[];
  readonly sources: readonly Source[];
  readonly history: readonly HistoryEntry[];
  /** 患者のすべての測定値・投薬・できごと（問題の記載に書かれたものを結ぶ。段3c） */
  readonly observations: readonly Observation[];
  readonly medications: readonly Medication[];
  readonly events: readonly ClinicalEvent[];
  readonly onChanged: () => void;
  readonly onLeft: () => void;
}

export function ProblemThreads({ patientId, problems, threads, segments, sources, history, observations, medications, events, onChanged, onLeft }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const views = threadViews(threads, problems);
  const notOrganized = sources.filter((s) => s.organized !== 'done').length;
  const sourceOf = (id: string): Source | undefined => sources.find((s) => s.id === id);

  /** 操作を1つずつ。終わったら読み込み直す */
  const run = (action: () => Promise<Result<null>>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    void action().then((r) => {
      setBusy(false);
      if (!r.ok) {
        if (r.error === 'unregistered') onLeft();
        else setMessage(errorMessage(r.error));
      }
      onChanged();
    });
  };

  const others = (id: string | null) => views.threads.filter((t) => t.id !== id);

  return (
    <div className="facts" data-testid="problems">
      {notOrganized > 0 && <p className="note">まだ整理していない記載が {String(notOrganized)} 件あります（「記録」の各記載の「整理する」で整理できます）。</p>}
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {views.threads.length === 0 && views.unlinked.length === 0 && <p className="note">この患者の記載から、問題は見つかっていません。</p>}

      {views.unlinked.length > 0 && (
        <section className="thread-unlinked" data-testid="unlinked">
          <h3 className="fact-title">まだ問題の筋につないでいない記載 {String(views.unlinked.length)} 件</h3>
          <p className="note">AI につなげなかった（1日の上限・つながらなかったなど）記載です。AI でつなぐか、1件ずつ行き先を選べます。</p>
          <button
            type="button"
            className="button small"
            disabled={busy}
            onClick={() => {
              run(() => linkProblems(patientId));
            }}
            data-testid="link-problems"
          >
            AI でつなぐ
          </button>
          <ul className="fact-list">
            {views.unlinked.map((m) => (
              <MentionRow key={m.id} mention={m as Problem} source={sourceOf(m.sourceId)} targets={views.threads} busy={busy} onMove={(to) => {
                run(() => moveProblem(m.id, to, m.threadId));
              }} />
            ))}
          </ul>
        </section>
      )}

      {GROUPS.map((group) => {
        const list = views.threads.filter((t) => t.group === group);
        if (list.length === 0) return null;
        return (
          <section key={group} className="thread-group" data-testid={`thread-group-${group}`}>
            <h3 className="sub-title">
              {THREAD_GROUP_NAMES[group]}（{String(list.length)}）
            </h3>
            <ul className="threads">
              {list.map((t) => (
                <ThreadCard
                  key={t.id}
                  view={t}
                  segments={segments}
                  facts={{ observations, medications, events }}
                  sourceOf={sourceOf}
                  others={others(t.id)}
                  busy={busy}
                  onName={(name) => {
                    run(() => nameThread(t.id, name));
                  }}
                  onMerge={(into) => {
                    run(() => mergeThread(t.id, into));
                  }}
                  onMove={(problem, to) => {
                    run(() => moveProblem(problem.id, to, problem.threadId));
                  }}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {views.threads.length > 0 && (
        <p className="note">
          確からしさと「解決・非活動」は、いちばん新しい記載に書かれたとおりです（判定ではありません）。同じ問題のつなぎは、名前が同じものと AI が付けたもので、「直す」で変えられます。
        </p>
      )}

      {history.length > 0 && <HistoryList history={history} problems={problems} views={views.threads} />}
    </div>
  );
}

function ThreadCard({
  view,
  segments,
  facts,
  sourceOf,
  others,
  busy,
  onName,
  onMerge,
  onMove,
}: {
  view: ThreadView;
  segments: readonly Segment[];
  facts: { observations: readonly Observation[]; medications: readonly Medication[]; events: readonly ClinicalEvent[] };
  sourceOf: (id: string) => Source | undefined;
  others: readonly ThreadView[];
  busy: boolean;
  onName: (name: string | null) => void;
  onMerge: (into: string) => void;
  onMove: (problem: Problem, to: string) => void;
}) {
  const [mergeTo, setMergeTo] = useState('');
  // 記載ごとにまとめる（1つの記載の A と P は一緒に出す）。いちばん新しい記載を開いて、ほかは畳む
  const groups: ProblemNote[][] = [];
  for (const n of problemNotes(view.mentions, segments)) {
    const last = groups.at(-1);
    if (last?.[0]?.sourceId === n.sourceId) last.push(n);
    else groups.push([n]);
  }
  const latest = groups.at(-1);
  const older = groups.slice(0, -1).reverse();

  return (
    <li className="thread" data-testid="problem-line" data-group={view.group}>
      <div className="thread-head">
        <strong className="thread-name" data-testid="thread-name">
          {view.name}
        </strong>
        <span className="tag">{PROBLEM_STATUS_NAMES[view.status]}</span>
        {view.activity !== null && <span className="tag">{PROBLEM_ACTIVITY_NAMES[view.activity]}</span>}
      </div>
      <p className="thread-sub">
        記載 {String(view.mentions.length)} 件・{showDateTime(view.first)}
        {view.last !== view.first && `〜${showDateTime(view.last)}`}
      </p>
      {view.names.length > 1 && (
        <p className="thread-names" data-testid="thread-names">
          名前の移り変わり：{view.names.map((n) => `${n.name}（${showDateTime(n.at)}）`).join(' → ')}
        </p>
      )}
      {view.earlierActivity !== null && (
        <p className="thread-sub">
          以前の記載（{showDateTime(view.earlierActivity.at)}）に「{PROBLEM_ACTIVITY_NAMES[view.earlierActivity.activity]}」。その後にも記載があります。
        </p>
      )}
      {latest !== undefined && <Note group={latest} sourceOf={sourceOf} />}
      {older.length > 0 && (
        <details className="thread-more">
          <summary>これまでの記載の A・P（{String(older.length)} 件）</summary>
          {older.map((g) => (
            <Note key={`${g[0]?.sourceId ?? ''}:${String(g[0]?.start ?? 0)}`} group={g} sourceOf={sourceOf} />
          ))}
        </details>
      )}

      <Related view={view} segments={segments} facts={facts} />

      <details className="thread-edit" data-testid="thread-edit">
        <summary>直す</summary>
        <div className="form">
          {view.names.length > 1 && (
            <label className="field">
              <span className="field-label">表示の名前（書かれた名前から選ぶ）</span>
              <select
                className="input"
                value={view.chosenName ? view.name : ''}
                disabled={busy}
                onChange={(e) => {
                  onName(e.target.value === '' ? null : e.target.value);
                }}
                data-testid="thread-display-name"
              >
                <option value="">いちばん新しい記載の名前</option>
                {view.names.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {others.length > 0 && (
            <div className="field">
              <span className="field-label">ほかの問題に統合する（この問題の記載が、すべて移ります）</span>
              <div className="field-row">
                <select
                  className="input"
                  value={mergeTo}
                  disabled={busy}
                  onChange={(e) => {
                    setMergeTo(e.target.value);
                  }}
                  data-testid="thread-merge-to"
                >
                  <option value="">統合先を選ぶ</option>
                  {others.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="button small"
                  disabled={busy || mergeTo === ''}
                  onClick={() => {
                    onMerge(mergeTo);
                  }}
                  data-testid="thread-merge"
                >
                  統合する
                </button>
              </div>
            </div>
          )}
          <div className="field">
            <span className="field-label">記載ごとに、行き先を直す</span>
            <ul className="fact-list">
              {view.mentions.map((m) => (
                <MentionRow
                  key={m.id}
                  mention={m as Problem}
                  source={sourceOf(m.sourceId)}
                  targets={others}
                  busy={busy}
                  allowNew={view.mentions.length > 1}
                  onMove={(to) => {
                    onMove(m as Problem, to);
                  }}
                />
              ))}
            </ul>
          </div>
        </div>
      </details>
    </li>
  );
}

/**
 * その問題の記載の中に書かれた、検査値・薬・できごと（段3c）。推し量らない：その問題の記載の範囲に書かれたものだけ。
 * 検査値は、書かれた名前の推移（この患者のすべての値）。薬は、薬ごとの最後の記載。
 */
function Related({ view, segments, facts }: { view: ThreadView; segments: readonly Segment[]; facts: { observations: readonly Observation[]; medications: readonly Medication[]; events: readonly ClinicalEvent[] } }) {
  const related = relatedFacts(view.mentions, segments, facts);
  if (related.valueNames.length === 0 && related.medicationNames.length === 0 && related.events.length === 0) return null;
  const names = new Set(related.valueNames);
  const trends = labTrends(facts.observations.filter((o) => names.has(o.name ?? o.nameRaw)));
  const vitals = related.valueNames.filter((n) => !trends.some((t) => t.name === n));
  const latestOf = (name: string) =>
    [...facts.observations].filter((o) => (o.name ?? o.nameRaw) === name && o.at !== null).sort((a, b) => compareDateTime(a.at, b.at)).at(-1);
  const meds = medicationTimeline(facts.medications).filter((line) => related.medicationNames.some((n) => nameKey(n) === nameKey(line.name)));
  return (
    <details className="thread-more" data-testid="thread-related">
      <summary>
        この問題の記載に書かれた値・薬（{[related.valueNames.length > 0 && `値 ${String(related.valueNames.length)}`, meds.length > 0 && `薬 ${String(meds.length)}`, related.events.length > 0 && `できごと ${String(related.events.length)}`].filter(Boolean).join('・')}）
      </summary>
      {trends.length > 0 && <TrendGrid trends={trends} />}
      {vitals.length > 0 && (
        <p className="thread-sub">
          {vitals
            .map((n) => {
              const o = latestOf(n);
              return o === undefined ? n : `${n} ${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}（${showDateTime(o.at)}）`;
            })
            .join('・')}
        </p>
      )}
      {meds.length > 0 && (
        <ul className="fact-list" data-testid="thread-related-meds">
          {meds.map((line) => {
            const dated = line.entries.filter((e) => e.at !== null);
            const last = dated.at(-1) ?? line.entries.at(-1);
            return (
              <li key={line.name} className="fact-row">
                <span className="fact-when">{showDateTime(last?.at ?? null)}</span>
                <span className="fact-main">
                  {line.name}
                  <span className="tag">{last?.action == null ? '動きの記載なし' : MEDICATION_ACTION_NAMES[last.action]}</span>
                  {last?.doseText != null && <span className="fact-dose">{last.doseText}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {related.events.length > 0 && (
        <ul className="fact-list">
          {related.events.map((e) => (
            <li key={e.id} className="fact-row">
              <span className="fact-when">{showDateTime(e.at)}</span>
              <span className="fact-main">
                <span className="tag">{EVENT_KIND_NAMES[e.kind]}</span>
                {e.title}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="note">その問題の記載（#問題の見出しの下や、問題名のある A・P）の中に書かれたものだけです。関係を推し量って足してはいません。値の推移は、書かれた名前の、この患者のすべての値です。</p>
    </details>
  );
}

/** 1つの記載の A・P（保存した文の、その区切りの字そのもの） */
function Note({ group, sourceOf }: { group: readonly ProblemNote[]; sourceOf: (id: string) => Source | undefined }) {
  return (
    <div className="thread-note" data-testid="thread-note">
      <span className="part-label">
        {showDateTime(group[0]?.at ?? null)}
        {group[0] !== undefined && `・${SOURCE_KIND_LABELS[sourceOf(group[0].sourceId)?.kind ?? 'unsorted']}`}
      </span>
      {group.map((n) => (
        <p key={n.start} className="source-text">
          <span className="sr-only">{SEGMENT_LABEL_NAMES[n.label]}：</span>
          {sourceOf(n.sourceId)?.text.slice(n.start, n.end).trim() ?? ''}
        </p>
      ))}
    </div>
  );
}

function MentionRow({
  mention,
  source,
  targets,
  busy,
  allowNew = true,
  onMove,
}: {
  mention: Problem;
  source: Source | undefined;
  targets: readonly ThreadView[];
  busy: boolean;
  allowNew?: boolean;
  onMove: (to: string) => void;
}) {
  const [to, setTo] = useState('');
  return (
    <li className="fact-row mention-row" data-testid="mention-row">
      <span className="fact-when">{showDateTime(mention.at)}</span>
      <span className="fact-main">
        {mention.name}
        <span className="tag">{PROBLEM_STATUS_NAMES[mention.status]}</span>
      </span>
      <span className="fact-from">
        {source === undefined ? '' : SOURCE_KIND_LABELS[source.kind]}
        {mention.threadOrigin !== null && `・${ORIGIN_NAMES[mention.threadOrigin]}`}
      </span>
      <span className="field-row mention-move">
        <select
          className="input compact"
          value={to}
          disabled={busy}
          onChange={(e) => {
            setTo(e.target.value);
          }}
          aria-label="移す先"
          data-testid="mention-move-to"
        >
          <option value="">移す先</option>
          {allowNew && <option value="new">新しい問題に分ける</option>}
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button small"
          disabled={busy || to === ''}
          onClick={() => {
            onMove(to);
          }}
          data-testid="mention-move"
        >
          移す
        </button>
      </span>
    </li>
  );
}

function HistoryList({ history, problems, views }: { history: readonly HistoryEntry[]; problems: readonly Problem[]; views: readonly ThreadView[] }) {
  const problemName = (id: string | null): string => problems.find((p) => p.id === id)?.name ?? '（いまはない記載）';
  const threadName = (id: string | null): string => (id === null ? '' : (views.find((v) => v.id === id)?.name ?? '（統合した・記載のない問題）'));
  const line = (h: HistoryEntry): string => {
    if (h.action === 'move') return `記載「${problemName(h.target)}」を、${h.before === null ? 'つないでいない記載' : `「${threadName(h.before)}」`}から「${threadName(h.after)}」へ移した`;
    if (h.action === 'merge') return `ある問題を「${threadName(h.after)}」に統合した`;
    return `「${threadName(h.target)}」の表示の名前を、${h.after === null ? 'いちばん新しい記載の名前' : `「${h.after}」`}にした`;
  };
  return (
    <details className="thread-history" data-testid="thread-history">
      <summary>直した記録（{String(history.length)}）</summary>
      <ul className="fact-list">
        {history.map((h) => (
          <li key={h.id} className="fact-row">
            <span className="fact-when">{showDateTime(h.at)}</span>
            <span className="fact-main">{line(h)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
