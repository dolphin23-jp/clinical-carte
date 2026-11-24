// 予定と実施（段K9。CA-058 の B2・CA-071。CA-026 の改訂）：A/P に書いた予定の行ごとに、その後の記録に、行ったことの記載が見つかったかを並べる。
// - 警告ではなく、記録の状態の一覧（画面の外への知らせ・音・ポップアップは作らない）。「AI の整理」の印。判定の語（遅れ・漏れなど）は使わない
// - 予定の字は記録に書かれたまま。押すと元の字が開く。日時・病日・種類の札・状態の札（字と色）
// - 先生の印は、ボタンだけ（実施を確かめた・中止・不要・外す・戻す）。組み直しても、同じ記載の同じ場所の行に引き継ぐ
// - 記録が増えた・整理し直したら、開いたときに自動で1回だけ組み直す（AI の 1 回。予定の行がなければ呼ばない）
import {
  hasPlanCandidates,
  hospitalDay,
  PLAN_ITEM_KIND_NAMES,
  PLAN_MARK_NAMES,
  PLAN_REJECT_NAMES,
  PLAN_REJECT_REASONS,
  planBasis,
  type PlanDone,
  type PlanItem,
  type PlanMark,
  type PlanStatus,
  planStatus,
  SOURCE_KIND_LABELS,
  RESUME_GRACE_MS,
} from '@clinical-carte/core';
import { useEffect, useRef, useState } from 'react';

import { afterReturn } from './lifecycle.ts';
import { showDateTime } from './format.ts';
import { Icon } from './Icon.tsx';
import { errorMessage } from './messages.ts';
import { type ApiError, generatePlans, markPlan, type PatientRecord } from './net/api.ts';

const say = (error: ApiError): string => errorMessage(error).replace('文は保存していません。', '');

export interface PlanBuild {
  readonly busy: boolean;
  readonly message: string | null;
  readonly build: () => void;
}

const candidatesIn = (record: PatientRecord): boolean => hasPlanCandidates({ encounters: record.encounters, sources: record.sources, segments: record.segments });

/** 予定と実施を組む係（患者の画面に1つ）。記録の印が変わり、整理が終わっていれば、自動で1回だけ組み直す（同じ印では二度と自動では呼ばない） */
export function usePlans(patientId: string, record: PatientRecord | null, onChanged: () => void, onLeft: () => void): PlanBuild {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const tried = useRef<string | null>(null);
  const build = () => {
    setBusy(true);
    setMessage(null);
    void generatePlans(patientId).then((r) => {
      setBusy(false);
      if (r.ok) onChanged();
      else if (r.error === 'unregistered') onLeft();
      else if (r.error === 'network') {
        // つながりが切れた（画面を離れたなど。CA-086）：サーバーが仕上げる猶予を待ってから読み直し、まだ古ければ、自動でもう一度組む
        setMessage('つながりが切れました。画面に戻ったら、続きを自動で組み直します。');
        afterReturn(() => {
          tried.current = null;
          setMessage(null);
          onChanged();
        }, RESUME_GRACE_MS);
      }
      else setMessage(`予定と実施を組み直せませんでした（${say(r.error)}）`);
    });
  };
  const basis = record === null ? null : planBasis(record.sources);
  useEffect(() => {
    if (record === null || basis === null || busy || tried.current === basis || !candidatesIn(record)) return;
    const stale = record.plans === null || record.plans.basis !== basis;
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
    <div className="tl-quote" data-testid="plan-quote">
      <span className="part-label">元の文（{s === undefined ? '' : `${SOURCE_KIND_LABELS[s.kind]}・${showDateTime(s.at)}`}）</span>
      <p className="source-text">{s === undefined ? '' : s.text.slice(p.start, p.end)}</p>
    </div>
  );
}

/** 実施の記載へのつなぎ（押すと、その字が開く） */
function DoneLinks({ done, sources }: { done: readonly PlanDone[]; sources: PatientRecord['sources'] }) {
  const [shown, setShown] = useState<number | null>(null);
  const hit = shown === null ? undefined : done[shown];
  return (
    <div className="pending-results" data-testid="plan-done">
      <span className="part-label">実施の記載</span>
      <div className="chips">
        {done.map((d, i) => (
          <button
            key={`${d.sourceId}:${String(d.start)}`}
            type="button"
            className={shown === i ? 'chip small on' : 'chip small'}
            aria-expanded={shown === i}
            onClick={() => {
              setShown(shown === i ? null : i);
            }}
            data-testid="plan-done-link"
          >
            {d.label}
            {d.at === null ? '' : `（${showDateTime(d.at)}）`}
          </button>
        ))}
      </div>
      {hit !== undefined && <Quote p={hit} sources={sources} />}
    </div>
  );
}

const shortDay = (at: string): string => `${String(Number(at.slice(5, 7)))}/${String(Number(at.slice(8, 10)))}`;

/** 状態の札の字（色は、見分けのための印。良い・悪いの判定ではない） */
function statusText(item: PlanItem, status: PlanStatus): string {
  if (status === 'done') {
    const first = item.done[0]?.at ?? null;
    return `実施の記載あり（${first === null ? '日時不明' : shortDay(first)}${item.done.length > 1 ? ' ほか' : ''}）`;
  }
  if (status === 'past_due') return `予定の日（${shortDay(item.due ?? '')}）を過ぎて、その後の記載に見つからない`;
  if (status === 'open') return 'その後の記載に見つからない';
  return '振り分けられなかった';
}

function Row({
  item,
  status,
  when,
  sources,
  open,
  onToggle,
  onMark,
  actions,
}: {
  item: PlanItem;
  status: PlanStatus;
  when: string;
  sources: PatientRecord['sources'];
  open: boolean;
  onToggle: () => void;
  onMark: (value: PlanMark) => void;
  actions: readonly (readonly [PlanMark, string])[];
}) {
  return (
    <li className={open ? 'thread open' : 'thread'} data-testid="plan-item">
      <button type="button" className="thread-head thread-toggle plan-head" aria-expanded={open} onClick={onToggle}>
        <span className="fold-mark" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <strong className="thread-name" data-testid="plan-text">
          {item.text}
        </strong>
        {item.kind !== null && <span className="tag">{PLAN_ITEM_KIND_NAMES[item.kind]}</span>}
        <span className={`plan-status plan-${status}`} data-testid="plan-status">
          {item.mark === 'none' ? statusText(item, status) : `${PLAN_MARK_NAMES[item.mark]}（先生）`}
        </span>
        <span className="thread-when" data-testid="plan-when">
          {when}
        </span>
      </button>
      {open && (
        <>
          {item.problem !== '' && <p className="thread-sub">{item.problem}</p>}
          <Quote p={item} sources={sources} />
          {item.done.length > 0 && <DoneLinks done={item.done} sources={sources} />}
          <div className="chips">
            {actions.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="chip small"
                onClick={() => {
                  onMark(value);
                }}
                data-testid={`plan-mark-${value}`}
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

export function PlansPanel({ patientId, record, builder, asOf, onChanged, onLeft }: { patientId: string; record: PatientRecord; builder: PlanBuild; asOf: string | null; onChanged: () => void; onLeft: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const plans = record.plans;
  const body = plans?.body ?? null;
  const stale = plans === null || plans.basis !== planBasis(record.sources);
  const current = record.encounters.at(-1) ?? null;
  if (body === null && !builder.busy && builder.message === null && !candidatesIn(record)) return null;

  const mark = (key: string, value: PlanMark) => {
    setMessage(null);
    void markPlan(patientId, key, value).then((r) => {
      if (r.ok) onChanged();
      else if (r.error === 'unregistered') onLeft();
      else setMessage(say(r.error));
    });
  };
  const when = (item: PlanItem): string => {
    if (item.at === null) return '日時不明';
    const hd = current?.kind === 'inpatient' ? hospitalDay(current.start, item.at) : null;
    const due = item.due === null ? null : `予定の日 ${shortDay(item.due)}${item.dueApprox === null ? '' : `（${item.dueApprox}）`}`;
    return [`${showDateTime(item.at)} の記載`, hd === null ? null : `第${String(hd)}病日`, due].filter((x) => x !== null).join('・');
  };
  const items = body?.items ?? [];
  const live = items.filter((i) => i.mark === 'none');
  const open_ = live.filter((i) => i.state === 'open');
  const done = live.filter((i) => i.state === 'done');
  const unsorted = live.filter((i) => i.state === 'unsorted');
  const marked = items.filter((i) => i.mark !== 'none');
  const rowProps = (item: PlanItem) => ({
    item,
    status: planStatus(item, asOf),
    when: when(item),
    sources: record.sources,
    open: open === item.key,
    onToggle: () => {
      setOpen(open === item.key ? null : item.key);
    },
    onMark: (value: PlanMark) => {
      mark(item.key, value);
    },
  });
  const marks: readonly (readonly [PlanMark, string])[] = [
    ['confirmed', '実施を確かめた'],
    ['cancelled', '中止・不要'],
    ['hidden', '外す'],
  ];
  const rejected = body === null ? [] : PLAN_REJECT_REASONS.flatMap((r) => ((body.rejected[r] ?? 0) > 0 ? [`${PLAN_REJECT_NAMES[r]} ${String(body.rejected[r] ?? 0)} 件`] : []));

  return (
    <section className="state-section pending plans" data-testid="plans" aria-labelledby="plans-title">
      <div className="plist-head">
        <h3 id="plans-title" className="sub-title with-icon">
          <Icon name="check" />
          予定と実施（A/P に書いた予定と、その後の記録） <span className="tag ai-tag">AI の整理</span>
        </h3>
        <button type="button" className="button small" disabled={builder.busy} onClick={builder.build} data-testid="plans-build">
          {builder.busy ? '組んでいます…' : 'AI で組み直す'}
        </button>
      </div>
      <p className="note" data-testid="plans-state">
        {builder.busy
          ? 'A/P に書いた予定の行ごとに、その後の記録に行ったことの記載があるかを、AI が整理しています。'
          : plans === null
            ? 'A/P に書いた予定の行ごとに、その後の記録に行ったことの記載があるかを、AI が整理します。'
            : `${showDateTime(plans.madeAt)} に整理しました${stale ? '（そのあと記録が増えました）' : ''}。記録の状態の一覧で、判定ではありません。記録に写していないことは「見つからない」に出ます。開いて印を付けてください。`}
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
      {body !== null && open_.length === 0 && <p className="note">その後の記載に見つからない予定は、ありません。</p>}
      {open_.length > 0 && (
        <ul className="threads compact" data-testid="plans-open">
          {open_.map((item) => (
            <Row key={item.key} {...rowProps(item)} actions={marks} />
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <details className="fact-more" data-testid="plans-done">
          <summary>実施の記載が見つかった予定（{String(done.length)}）</summary>
          <ul className="threads compact">
            {done.map((item) => (
              <Row key={item.key} {...rowProps(item)} actions={marks} />
            ))}
          </ul>
        </details>
      )}
      {unsorted.length > 0 && (
        <details className="fact-more" data-testid="plans-unsorted">
          <summary>振り分けられなかった予定の行（{String(unsorted.length)}。実施の記載があるかは確かめていません）</summary>
          <ul className="threads compact">
            {unsorted.map((item) => (
              <Row key={item.key} {...rowProps(item)} actions={marks} />
            ))}
          </ul>
        </details>
      )}
      {marked.length > 0 && (
        <details className="fact-more" data-testid="plans-marked">
          <summary>印を付けた予定（{String(marked.length)}）</summary>
          <ul className="threads compact">
            {marked.map((item) => (
              <Row key={item.key} {...rowProps(item)} actions={[['none', `戻す（${PLAN_MARK_NAMES[item.mark]}）`]]} />
            ))}
          </ul>
        </details>
      )}
      {body !== null && (body.notPlan > 0 || rejected.length > 0 || body.dropped.candidates + body.dropped.done > 0) && (
        <p className="note" data-testid="plans-counts">
          {body.notPlan > 0 && `評価・所見・すでに行ったことの行など、予定ではないと整理した ${String(body.notPlan)} 行は出していません。`}
          {rejected.length > 0 && `確かめで通らなかったもの：${rejected.join('・')}。`}
          {body.dropped.candidates > 0 && `古い予定の行 ${String(body.dropped.candidates)} 行は、数の上限のため AI に渡していません。`}
          {body.dropped.done > 0 && `資料の長さのため、古い記録 ${String(body.dropped.done)} 件は、実施の照らし合わせに使っていません。`}
        </p>
      )}
    </section>
  );
}
