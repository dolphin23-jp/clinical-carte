// 受け持ちから探す（段K8。CA-070。CA-058 の A8）：すべての患者の、保存した文（識別情報を置き換えた後）・問題の名前・薬・できごと・
// 経過の出来事の要約・値の項目の名前から、打った字を探す。AI は使わない。
// - 問いは保存しない（画面のメモリだけ。サーバーも保存・ログをしない）。外へは送らない
// - 問いに電話番号・メールなどの形があれば、送らない（core の searchQueryProblem。サーバーも同じ関数で断る）
// - 当たりは患者ごとにまとめ、押すと、その患者の記録のタブで、その記載を開く（AI のプロブレムリストの項目は、問題のタブ）
import { SEARCH_HIT_KIND_LABELS, SEARCH_HIT_MAX, SEARCH_HITS_PER_PATIENT, SEARCH_QUERY_MAX, type SearchHit, searchQueryProblem, SOURCE_KIND_LABELS } from '@clinical-carte/core';
import { useState } from 'react';

import { showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { searchAll, type SearchReply } from './net/api.ts';

/** 患者の画面を開くときの行き先（画面のメモリだけ） */
export type OpenFocus =
  | { readonly kind: 'source'; readonly sourceId: string; readonly encounterId: string | null; readonly hit: SearchHit }
  | { readonly kind: 'problems'; readonly hit: SearchHit };

/** 当たりの前後の字（改行は「／」にして1行で見せる。字は変えない） */
export function Snippet({ hit }: { hit: SearchHit }) {
  const flat = (t: string) => t.replace(/\n+/gu, ' ／ ');
  return (
    <span className="search-snippet">
      {hit.clippedBefore && '…'}
      {flat(hit.before)}
      <mark data-testid="search-match">{flat(hit.match)}</mark>
      {flat(hit.after)}
      {hit.clippedAfter && '…'}
    </span>
  );
}

export function SearchPanel({ onOpen, onLeft }: { onOpen: (patientId: string, focus: OpenFocus) => void; onLeft: () => void }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 答えは、画面のメモリだけ（保存しない）
  const [found, setFound] = useState<{ q: string; reply: SearchReply } | null>(null);

  const run = () => {
    const query = q.trim();
    const problem = searchQueryProblem(query);
    if (problem === 'shape') {
      setMessage('探す字に、電話番号・メールなどの形があるので、探しませんでした（送っていません）。消してから、もう一度探してください。');
      return;
    }
    if (problem !== null) return;
    setBusy(true);
    setMessage(null);
    void searchAll(query).then((r) => {
      setBusy(false);
      if (r.ok) setFound({ q: query, reply: r.value });
      else if (r.error === 'unregistered') onLeft();
      else setMessage(errorMessage(r.error).replace('記載か頼みに', '探す字に'));
    });
  };

  const open = (patientId: string, hit: SearchHit) => {
    if (hit.anchor === null) onOpen(patientId, { kind: 'problems', hit });
    else onOpen(patientId, { kind: 'source', sourceId: hit.anchor.sourceId, encounterId: hit.encounterId, hit });
  };

  return (
    <section className="search" aria-labelledby="search-title" data-testid="search">
      <h3 id="search-title" className="sub-title">
        受け持ちから探す
      </h3>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input
          className="input"
          type="search"
          aria-labelledby="search-title"
          maxLength={SEARCH_QUERY_MAX}
          value={q}
          placeholder="例：CTRX・血培・腎盂腎炎・Cr"
          onChange={(e) => {
            setQ(e.target.value);
          }}
          data-testid="search-input"
        />
        <button type="submit" className="button" disabled={busy || q.trim() === ''} data-testid="search-send">
          {busy ? '探しています…' : '探す'}
        </button>
      </form>
      <p className="note">保存した記録（名前などを置き換えた後の文と、整理した事実）から探します。AI は使いません。探す字は保存しません。全角・半角・大文字と小文字・空白の違いはそろえて探します。</p>
      {message !== null && (
        <p className="alert" role="alert" data-testid="search-message">
          {message}
        </p>
      )}
      {found !== null && (
        <div className="search-results" data-testid="search-results">
          <p className="row-sub" data-testid="search-count">
            「{found.q}」：{found.reply.total === 0 ? '見つかりませんでした' : `${String(found.reply.patients.length)} 人・${String(found.reply.total)} か所`}
            {found.reply.shown < found.reply.total && `（出しているのは ${String(found.reply.shown)} か所。1人 ${String(SEARCH_HITS_PER_PATIENT)} か所・全体で ${String(SEARCH_HIT_MAX)} か所まで。字を足して絞ってください）`}
          </p>
          {found.reply.patients.map((p) => (
            <article key={p.patientId} className="search-patient" data-testid="search-patient">
              <h4 className="search-patient-head">
                {p.headline}
                <span className="row-sub">（{String(p.total)} か所{p.hits.length < p.total ? `・うち ${String(p.hits.length)} か所を出しています` : ''}）</span>
              </h4>
              <ul className="search-hits">
                {p.hits.map((h, i) => (
                  <li key={`${h.kind}-${h.anchor?.sourceId ?? 'list'}-${String(h.anchor?.start ?? i)}-${String(i)}`}>
                    <button
                      type="button"
                      className="search-hit"
                      onClick={() => {
                        open(p.patientId, h);
                      }}
                      data-testid="search-hit"
                    >
                      <span className="search-where">
                        <span className={h.kind === 'course' || h.kind === 'list' ? 'tag ai-tag' : 'tag'}>{SEARCH_HIT_KIND_LABELS[h.kind]}</span>
                        {h.sourceKind !== null && `${SOURCE_KIND_LABELS[h.sourceKind]}・`}
                        {h.anchor === null ? '問題のタブで開く' : showDateTime(h.at)}
                        {h.count !== undefined && h.count > 1 && `（この項目の値 ${String(h.count)} 件。いちばん新しいもの）`}
                      </span>
                      <Snippet hit={h} />
                    </button>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
