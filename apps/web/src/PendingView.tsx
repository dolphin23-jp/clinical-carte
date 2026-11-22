// 結果待ち（段K6。CA-058 の A3・CA-065）：「提出した・依頼した」と書かれた検査のうち、結果の記載がまだ記録にないものの一覧。
// - 警告ではなく、記録の状態の一覧（画面の外への知らせ・音・ポップアップは作らない）。「AI の整理」の印
// - 名前・日時は記録に書かれたもの（できごとの題・経過の出来事の要約）。押すと元の字が開く。病日と「提出から N 日目」（暦の日。記録の上で最後の日まで）
// - 先生の印は、ボタンだけ（結果を確かめた・外す・戻す）。組み直しても、同じ記載の同じ場所の項目に引き継ぐ
// - 記録が増えた・整理し直したら、開いたときに自動で1回だけ組み直す（AI の 1 回。提出の候補がなければ呼ばない）
import {
  dayNumber,
  hasPendingCandidates,
  hospitalDay,
  PENDING_REJECT_NAMES,
  PENDING_REJECT_REASONS,
  pendingBasis,
  type PendingItem,
  type PendingMark,
  type PendingResult,
  SOURCE_KIND_LABELS,
} from '@clinical-carte/core';
import { useEffect, useRef, useState } from 'react';

import { showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { type ApiError, generatePending, markPending, type PatientRecord } from './net/api.ts';

const say = (error: ApiError): string => errorMessage(error).replace('文は保存していません。', '');

export interface PendingBuild {
  readonly busy: boolean;
  readonly message: string | null;
  readonly build: () => void;
}

const candidatesIn = (record: PatientRecord): boolean => hasPendingCandidates({ encounters: record.encounters, events: record.events.filter((e) => !e.excluded), course: record.course });

/** 結果待ちを組む係（患者の画面に1つ）。記録の印が変わり、整理が終わっていれば、自動で1回だけ組み直す（同じ印では二度と自動では呼ばない） */
export function usePending(patientId: string, record: PatientRecord | null, onChanged: () => void, onLeft: () => void): PendingBuild {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const tried = useRef<string | null>(null);
  const build = () => {
    setBusy(true);
    setMessage(null);
    void generatePending(patientId).then((r) => {
      setBusy(false);
      if (r.ok) onChanged();
      else if (r.error === 'unregistered') onLeft();
      else setMessage(`結果待ちを組み直せませんでした（${say(r.error)}）`);
    });
  };
  const basis = record === null ? null : pendingBasis(record.sources);
  useEffect(() => {
    if (record === null || basis === null || busy || tried.current === basis || !candidatesIn(record)) return;
    const stale = record.pending === null || record.pending.basis !== basis;
    const organizing = record.sources.some((s) => s.organized === null);
    if (!stale || organizing) return;
    tried.current = basis;
    build();
  });
  return { busy, message, build };
}

type Span = { readonly sourceId: string; readonly start: number; readonly end: number };

/** 元の字（どの記載の、どこか） */
function Quote({ p, sources }: { p: Span; sources: PatientRecord['sources'] }) {
  const s = sources.find((x) => x.id === p.sourceId);
  return (
    <div className="tl-quote" data-testid="pending-quote">
      <span className="part-label">元の文（{s === undefined ? '' : `${SOURCE_KIND_LABELS[s.kind]}・${showDateTime(s.at)}`}）</span>
      <p className="source-text">{s === undefined ? '' : s.text.slice(p.start, p.end)}</p>
    </div>
  );
}

/** 結果の記載へのつなぎ（押すと、その字が開く） */
function ResultLinks({ results, sources }: { results: readonly PendingResult[]; sources: PatientRecord['sources'] }) {
  const [shown, setShown] = useState<number | null>(null);
  const hit = shown === null ? undefined : results[shown];
  return (
    <div className="pending-results" data-testid="pending-results">
      <span className="part-label">結果の記載</span>
      <div className="chips">
        {results.map((r, i) => (
          <button
            key={`${r.sourceId}:${String(r.start)}`}
            type="button"
            className={shown === i ? 'chip small on' : 'chip small'}
            aria-expanded={shown === i}
            onClick={() => {
              setShown(shown === i ? null : i);
            }}
            data-testid="pending-result"
          >
            {r.label}
            {r.at === null ? '' : `（${showDateTime(r.at)}）`}
          </button>
        ))}
      </div>
      {hit !== undefined && <Quote p={hit} sources={sources} />}
    </div>
  );
}

function Row({
  item,
  when,
  sources,
  open,
  onToggle,
  onMark,
  actions,
}: {
  item: PendingItem;
  when: string;
  sources: PatientRecord['sources'];
  open: boolean;
  onToggle: () => void;
  onMark: (value: PendingMark) => void;
  actions: readonly (readonly [PendingMark, string])[];
}) {
  return (
    <li className={open ? 'thread open' : 'thread'} data-testid="pending-item">
      <button type="button" className="thread-head thread-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="fold-mark" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <strong className="thread-name">{item.name}</strong>
        <span className="tag ai-tag">AI の整理</span>
        <span className="thread-when" data-testid="pending-when">
          {when}
        </span>
      </button>
      {open && (
        <>
          <Quote p={item} sources={sources} />
          {item.results.length > 0 && <ResultLinks results={item.results} sources={sources} />}
          <div className="chips">
            {actions.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="chip small"
                onClick={() => {
                  onMark(value);
                }}
                data-testid={`pending-mark-${value}`}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </li>
  );
}

export function PendingPanel({ patientId, record, builder, asOf, onChanged, onLeft }: { patientId: string; record: PatientRecord; builder: PendingBuild; asOf: string | null; onChanged: () => void; onLeft: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pending = record.pending;
  const body = pending?.body ?? null;
  const stale = pending === null || pending.basis !== pendingBasis(record.sources);
  const current = record.encounters.at(-1) ?? null;
  if (body === null && !builder.busy && builder.message === null && !candidatesIn(record)) return null;

  const mark = (key: string, value: PendingMark) => {
    setMessage(null);
    void markPending(patientId, key, value).then((r) => {
      if (r.ok) onChanged();
      else if (r.error === 'unregistered') onLeft();
      else setMessage(say(r.error));
    });
  };
  const when = (item: PendingItem): string => {
    if (item.at === null) return '日時不明';
    const hd = current?.kind === 'inpatient' ? hospitalDay(current.start, item.at) : null;
    const since = asOf === null ? null : dayNumber(item.at, asOf);
    return [`${showDateTime(item.at)}${item.atApprox === null ? '' : `（${item.atApprox}）`}`, hd === null ? null : `第${String(hd)}病日`, since === null ? null : `提出から ${String(since)} 日目`].filter((x) => x !== null).join('・');
  };
  const items = body?.items ?? [];
  const waiting = items.filter((i) => i.state === 'pending' && i.mark === 'none');
  const resulted = items.filter((i) => i.state === 'resulted' && i.mark === 'none');
  const unsorted = items.filter((i) => i.state === 'unsorted' && i.mark === 'none');
  const marked = items.filter((i) => i.mark !== 'none');
  const rowProps = (item: PendingItem) => ({
    item,
    when: when(item),
    sources: record.sources,
    open: open === item.key,
    onToggle: () => {
      setOpen(open === item.key ? null : item.key);
    },
    onMark: (value: PendingMark) => {
      mark(item.key, value);
    },
  });
  const rejected = body === null ? [] : PENDING_REJECT_REASONS.flatMap((r) => ((body.rejected[r] ?? 0) > 0 ? [`${PENDING_REJECT_NAMES[r]} ${String(body.rejected[r] ?? 0)} 件`] : []));

  return (
    <section className="state-section pending" data-testid="pending" aria-labelledby="pending-title">
      <div className="plist-head">
        <h3 id="pending-title" className="sub-title">
          結果待ち（提出の記載があり、結果の記載がまだないもの） <span className="tag ai-tag">AI の整理</span>
        </h3>
        <button type="button" className="button small" disabled={builder.busy} onClick={builder.build} data-testid="pending-build">
          {builder.busy ? '組んでいます…' : 'AI で組み直す'}
        </button>
      </div>
      <p className="note" data-testid="pending-state">
        {builder.busy
          ? '提出・依頼と書かれた検査ごとに、記録に結果の記載があるかを、AI が整理しています。'
          : pending === null
            ? '提出・依頼と書かれた検査ごとに、記録に結果の記載があるかを、AI が整理します。'
            : `${showDateTime(pending.madeAt)} に整理しました${stale ? '（そのあと記録が増えました）' : ''}。警告ではなく、記録の状態の一覧です。結果が記録の外にあるときは、開いて「結果を確かめた」を押してください。`}
      </p>
      {builder.message !== null && (
        <p className="alert" role="alert">
          {builder.message}
        </p>
      )}
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {body !== null && waiting.length === 0 && <p className="note">結果待ちとして整理されたものは、ありません。</p>}
      {waiting.length > 0 && (
        <ul className="threads compact" data-testid="pending-waiting">
          {waiting.map((item) => (
            <Row key={item.key} {...rowProps(item)} actions={[['checked', '結果を確かめた'], ['hidden', '外す']]} />
          ))}
        </ul>
      )}
      {resulted.length > 0 && (
        <details className="fact-more" data-testid="pending-resulted">
          <summary>結果の記載があるもの（{String(resulted.length)}）</summary>
          <ul className="threads compact">
            {resulted.map((item) => (
              <Row key={item.key} {...rowProps(item)} actions={[['hidden', '外す']]} />
            ))}
          </ul>
        </details>
      )}
      {unsorted.length > 0 && (
        <details className="fact-more" data-testid="pending-unsorted">
          <summary>振り分けられなかった提出の記載（{String(unsorted.length)}。結果があるかは確かめていません）</summary>
          <ul className="threads compact">
            {unsorted.map((item) => (
              <Row key={item.key} {...rowProps(item)} actions={[['checked', '結果を確かめた'], ['hidden', '外す']]} />
            ))}
          </ul>
        </details>
      )}
      {marked.length > 0 && (
        <details className="fact-more" data-testid="pending-marked">
          <summary>確かめた・外したもの（{String(marked.length)}）</summary>
          <ul className="threads compact">
            {marked.map((item) => (
              <Row key={item.key} {...rowProps(item)} actions={[['none', `戻す（${item.mark === 'checked' ? '結果を確かめた' : '外した'}）`]]} />
            ))}
          </ul>
        </details>
      )}
      {body !== null && (body.notSubmission > 0 || rejected.length > 0 || body.dropped.candidates + body.dropped.results > 0) && (
        <p className="note" data-testid="pending-counts">
          {body.notSubmission > 0 && `その場で結果まで書かれた検査など、提出ではないと整理したもの ${String(body.notSubmission)} 件は出していません。`}
          {rejected.length > 0 && `確かめで通らなかったもの：${rejected.join('・')}。`}
          {body.dropped.candidates > 0 && `古い提出の記載 ${String(body.dropped.candidates)} 件は、数の上限のため AI に渡していません。`}
          {body.dropped.results > 0 && `資料の長さのため、古い記録 ${String(body.dropped.results)} 件は、結果の照らし合わせに使っていません。`}
        </p>
      )}
    </section>
  );
}
