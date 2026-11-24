// AI の臨床支援（段K5。CA-059・CA-064）：AI のプロブレムリストの活動中の問題ごとに、疑う疾患（根拠と、足りない情報）・確かめる検査の候補・
// ガイドライン・標準治療との照合（沿っている・差がある・分からない）・表にない基準の補い（出典つきだけ）を出す。
// - いつも「臨床支援」「AI」の印と、「臨床支援の草案です。最終判断は先生です。」を出す（写した事実と分ける）。画面の外への知らせは作らない
// - 記録が増えて、プロブレムリストが組み直されたら、開いたときに自動で1回だけ組み直す（AI の 1 回。ネットを選んでいれば、もう 1 回）。失敗したら、押して組み直す
// - 資料・出典に見つからない数には下線と「※」（サーバーが core の markNumbers で付けた場所）。記録だけからの推し量りには「（推論）」
// - 出典は、書籍の題と頁、ネットの題と URL を字で出す（本文は残していない）。出さなかったものは、理由ごとの数で出す（黙って捨てない）
import {
  type ApRef,
  GUIDELINE_STATUS_NAMES,
  listBasis,
  type MarkedText,
  SUPPORT_FOCUS_NAMES,
  SUPPORT_REJECT_NAMES,
  SUPPORT_REJECT_REASONS,
  type SupportPoint,
  type SupportProblem,
  supportBasis,
  RESUME_GRACE_MS,
} from '@clinical-carte/core';
import { Fragment, useEffect, useRef, useState } from 'react';

import { afterReturn } from './lifecycle.ts';
import { showDateTime } from './format.ts';
import { Icon } from './Icon.tsx';
import { errorMessage } from './messages.ts';
import { type ApiError, generateSupport, type PatientRecord } from './net/api.ts';

const say = (error: ApiError): string => errorMessage(error).replace('文は保存していません。', '');

export interface SupportBuild {
  readonly busy: boolean;
  readonly message: string | null;
  /** ネットの出典も探す（画面のメモリだけ。既定は探す） */
  readonly web: boolean;
  readonly setWeb: (web: boolean) => void;
  readonly build: () => void;
}

/** 活動中の問題が、プロブレムリストにあるか */
const hasActive = (record: PatientRecord): boolean => (record.problemList?.items ?? []).some((i) => !i.hidden && i.activity === 'active');

/**
 * 臨床支援を組む係（患者の画面に1つ）。記録の印とプロブレムリストを組んだ日時が変わり、プロブレムリストが記録に追いついていれば、
 * 自動で1回だけ組み直す（同じ印では、二度と自動では呼ばない）。listBusy は、プロブレムリストを組み直している最中
 */
export function useSupport(patientId: string, record: PatientRecord | null, listBusy: boolean, onChanged: () => void, onLeft: () => void): SupportBuild {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [web, setWeb] = useState(true);
  const tried = useRef<string | null>(null);
  const build = () => {
    setBusy(true);
    setMessage(null);
    void generateSupport(patientId, web).then((r) => {
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
      else if (r.error !== 'support_empty') setMessage(`臨床支援を組み直せませんでした（${say(r.error)}）`);
    });
  };
  const list = record?.problemList ?? null;
  const basis = record === null ? null : supportBasis(record.sources, list?.madeAt ?? null);
  useEffect(() => {
    if (record === null || basis === null || list === null || busy || listBusy || tried.current === basis || !hasActive(record)) return;
    // プロブレムリストが記録に追いついてから（リストを組み直すと、支援の印も変わる）
    const listFresh = list.basis === listBasis(record.sources);
    const organizing = record.sources.some((s) => s.organized === null);
    const stale = record.support === null || record.support.basis !== basis;
    if (!listFresh || organizing || !stale) return;
    tried.current = basis;
    build();
  });
  return { busy, message, web, setWeb, build };
}

/** 印のついた文：資料・出典にない数に下線と「※」、「（推論）」を目立たせる（字は変えない） */
export function Marked({ value }: { value: MarkedText }) {
  const out: React.ReactNode[] = [];
  let at = 0;
  const plain = (s: string, key: string) => {
    s.split(/(（推論）)/u).forEach((p, i) => {
      if (p === '') return;
      out.push(
        p === '（推論）' ? (
          <span key={`${key}-${String(i)}`} className="doc-inference">
            {p}
          </span>
        ) : (
          <Fragment key={`${key}-${String(i)}`}>{p}</Fragment>
        ),
      );
    });
  };
  [...value.marks]
    .sort((a, b) => a.start - b.start)
    .forEach((m, i) => {
      if (m.start < at || m.end > value.text.length) return;
      if (m.start > at) plain(value.text.slice(at, m.start), `t${String(i)}`);
      out.push(
        <span key={`m${String(i)}`} className="num-unbacked" title="記録・出典に見つからない数" data-testid="support-num-mark">
          {value.text.slice(m.start, m.end)}
          <sup aria-label="記録・出典に見つからない">※</sup>
        </span>,
      );
      at = m.end;
    });
  if (at < value.text.length) plain(value.text.slice(at), 'end');
  return <>{out}</>;
}

/** 出典の字（書籍は題と頁、ネットは題と URL。外へのリンクにはしない） */
function citeText(ref: ApRef): string {
  if (ref.k === 'book') return `書籍 ${ref.title}${ref.page === null ? '' : ` ${ref.page}`}`;
  if (ref.k === 'web') return `ネット ${ref.title || ref.url}（${ref.url}）`;
  return '記録';
}

function Points({ label, points }: { label: string; points: readonly SupportPoint[] }) {
  if (points.length === 0) return null;
  return (
    <p className="thread-sub support-points">
      {label}：{points.map((p) => p.label).join('・')}
    </p>
  );
}

function Cites({ refs }: { refs: readonly ApRef[] }) {
  if (refs.length === 0) return null;
  return (
    <p className="doc-refs" data-testid="support-cite">
      出典：{refs.map(citeText).join('／')}
    </p>
  );
}

function ProblemBlock({ p }: { p: SupportProblem }) {
  const counts = [
    p.differentials.length > 0 ? `疑う疾患 ${String(p.differentials.length)}` : null,
    p.tests.length > 0 ? `検査 ${String(p.tests.length)}` : null,
    p.guideline.length > 0 ? `照合 ${String(p.guideline.length)}` : null,
    p.criteria.length > 0 ? `基準の補い ${String(p.criteria.length)}` : null,
  ].filter((x): x is string => x !== null);
  return (
    <details className="support-problem" data-testid="support-problem">
      <summary className="support-problem-head">
        <strong className="thread-name">
          #{String(p.no)} {p.name}
        </strong>
        <span className="tag">{SUPPORT_FOCUS_NAMES[p.focus]}</span>
        {counts.length > 0 && <span className="note">{counts.join('・')}</span>}
      </summary>
      <div className="support-body">
        {p.differentials.length > 0 && (
          <div className="support-part" data-testid="support-differentials">
            <h4 className="part-label">疑う疾患（根拠と、足りない情報）</h4>
            <ul className="support-list">
              {p.differentials.map((d, i) => (
                <li key={`${d.name}-${String(i)}`} data-testid="support-differential">
                  <strong>{d.name}</strong>
                  {d.reasoning.text !== '' && (
                    <p className="support-text">
                      <Marked value={d.reasoning} />
                    </p>
                  )}
                  <Points label="根拠" points={d.support} />
                  <Points label="合わない点" points={d.against} />
                  {d.missing.text !== '' && (
                    <p className="thread-sub">
                      足りない情報：<Marked value={d.missing} />
                    </p>
                  )}
                  <Cites refs={d.citations} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {p.tests.length > 0 && (
          <div className="support-part" data-testid="support-tests">
            <h4 className="part-label">確かめる検査の候補</h4>
            <ul className="support-list">
              {p.tests.map((t, i) => (
                <li key={`${t.name}-${String(i)}`} data-testid="support-test">
                  <strong>{t.name}</strong>
                  {t.why.text !== '' && (
                    <p className="support-text">
                      <Marked value={t.why} />
                    </p>
                  )}
                  <Points label="根拠" points={t.support} />
                  <Cites refs={t.citations} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {p.guideline.length > 0 && (
          <div className="support-part" data-testid="support-guideline">
            <h4 className="part-label">ガイドライン・標準治療との照合</h4>
            <ul className="support-list">
              {p.guideline.map((g, i) => (
                <li key={String(i)} data-testid="support-guideline-item">
                  <span className={`support-status support-${g.status}`} data-testid="support-status">
                    {GUIDELINE_STATUS_NAMES[g.status]}
                  </span>
                  <p className="support-text">
                    <Marked value={g.statement} />
                  </p>
                  <Points label="照らした記録" points={g.support} />
                  <Cites refs={g.citations} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {p.criteria.length > 0 && (
          <div className="support-part" data-testid="support-criteria">
            <h4 className="part-label">表にない基準の補い（出典の引用つき。点数は計算していません）</h4>
            <ul className="support-list">
              {p.criteria.map((c, i) => (
                <li key={`${c.name}-${String(i)}`}>
                  <strong>{c.name}</strong>
                  <p className="support-text">
                    <Marked value={c.statement} />
                  </p>
                  <Cites refs={c.citations} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {p.notes.text !== '' && (
          <p className="thread-sub">
            補足：<Marked value={p.notes} />
          </p>
        )}
      </div>
    </details>
  );
}

/** 1つの問題の、印（※）の数 */
const marksIn = (p: SupportProblem): number =>
  [...p.differentials.flatMap((d) => [d.reasoning, d.missing]), ...p.tests.map((t) => t.why), ...p.guideline.map((g) => g.statement), ...p.criteria.map((c) => c.statement), p.notes].reduce((n, m) => n + m.marks.length, 0);

export function SupportPanel({ record, builder }: { record: PatientRecord; builder: SupportBuild }) {
  const support = record.support;
  const stale = support === null || support.basis !== supportBasis(record.sources, record.problemList?.madeAt ?? null);
  const { busy, build, web, setWeb } = builder;
  const body = support?.body ?? null;
  const rejected = body === null ? [] : SUPPORT_REJECT_REASONS.flatMap((r) => ((body.rejected[r] ?? 0) > 0 ? [`${SUPPORT_REJECT_NAMES[r]} ${String(body.rejected[r] ?? 0)} 件`] : []));
  const marks = body === null ? 0 : body.problems.reduce((n, p) => n + marksIn(p), 0);

  return (
    <section className="state-section support" data-testid="support" aria-labelledby="support-title">
      <div className="plist-head">
        <h3 id="support-title" className="sub-title with-icon">
          <Icon name="finding" />
          AI の臨床支援 <span className="tag support-tag">臨床支援</span> <span className="tag ai-tag">AI</span>
        </h3>
        <button type="button" className="button small" disabled={busy} onClick={build} data-testid="support-build">
          {busy ? '組んでいます…' : 'AI で組み直す'}
        </button>
      </div>
      <p className="support-caution" data-testid="support-caution">
        臨床支援の草案です。最終判断は先生です。
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={web}
          onChange={(e) => {
            setWeb(e.target.checked);
          }}
          data-testid="support-web"
        />
        ネットの出典も探す（検索に渡すのは問題の名前だけ）
      </label>
      <p className="note" data-testid="support-state">
        {busy
          ? '活動中の問題ごとに、書籍・ネットの出典を探し、臨床支援を組んでいます。'
          : support === null
            ? 'プロブレムリストの活動中の問題について、AI が臨床支援を組みます。'
            : `${showDateTime(support.madeAt)} に組みました${stale ? '（そのあと記録が増えました）' : ''}。資料にした出典：書籍 ${String(support.body.research.books)} 件・ネット ${String(support.body.research.web)} 件${support.body.research.webFailed ? '（ネットの検索はできませんでした）' : ''}。`}
      </p>
      {builder.message !== null && (
        <p className="alert" role="alert">
          {builder.message}
        </p>
      )}
      {body !== null && body.problems.length === 0 && !busy && <p className="note">AI が書いた臨床支援は、ありませんでした。</p>}
      {body !== null && body.problems.map((p) => <ProblemBlock key={p.key} p={p} />)}
      {body !== null && (
        <p className="note" data-testid="support-legend">
          根拠は記録の記載・経過の出来事・値・薬・スコアの表です。「（推論）」は、出典の引用に基づかない、記録だけからの推し量りです。
          {marks > 0 && '下線と「※」の数は、記録・出典に見つかりませんでした。確かめてください。'}
          診断・点数・用量は決めていません（スコア・診断基準の点数は、「スコア・診断基準」の節で表から計算したものです）。
        </p>
      )}
      {rejected.length > 0 && (
        <p className="note" data-testid="support-rejected">
          出さなかったもの：{rejected.join('・')}
        </p>
      )}
      {body !== null && body.shapes > 0 && <p className="note">電話番号・メールなどの形 {String(body.shapes)} 個を伏せました。</p>}
      {body !== null && body.dropped.course + body.dropped.values > 0 && (
        <p className="note">
          資料の長さのため、古い経過の出来事 {String(body.dropped.course)} 件・値 {String(body.dropped.values)} 項目は、AI に渡していません。
        </p>
      )}
    </section>
  );
}
