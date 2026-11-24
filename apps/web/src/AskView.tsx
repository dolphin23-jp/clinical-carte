// 記録だけからの答え（段K6。CA-058 の A4・CA-066）の見せ方。問いを打つ欄は、相談の窓口（段M。CA-081。ConsultPanel.tsx）に1つにまとめた：
// 窓口の「記録だけから答える」を選ぶと、これまでどおり、記録だけから AI が答え、答えの文ごとに、記録のどこに書かれているかを付ける（答え方・確かめ方は変えていない）。
// - 根拠の札を押すと、元の字（どの記載の・いつの・どこか）が開く。記録に見つからない数には下線と「※」。根拠を確かめられなかった文は出さず、理由ごとの数を出す
import { ASK_REJECT_NAMES, ASK_REJECT_REASONS, type AskRef, type AskReply, SOURCE_KIND_LABELS } from '@clinical-carte/core';
import { useState } from 'react';

import { showDateTime } from './format.ts';
import type { PatientRecord } from './net/api.ts';
import { Marked } from './SupportView.tsx';

export function AskAnswerView({ record, reply }: { record: PatientRecord; reply: AskReply }) {
  const [open, setOpen] = useState<string | null>(null);
  const quote = (ref: AskRef): { from: string; text: string } => {
    const s = record.sources.find((x) => x.id === ref.sourceId);
    return s === undefined ? { from: '', text: '' } : { from: `${SOURCE_KIND_LABELS[s.kind]}・${showDateTime(s.at)}`, text: s.text.slice(ref.start, ref.end) };
  };
  const rejected = ASK_REJECT_REASONS.flatMap((r) => ((reply.rejected[r] ?? 0) > 0 ? [`${ASK_REJECT_NAMES[r]} ${String(reply.rejected[r] ?? 0)} 件`] : []));
  const marks = reply.answer.reduce((n, s) => n + s.marks.length, 0);
  const dropped = reply.dropped.records + reply.dropped.shortened + reply.dropped.values + reply.dropped.course;

  return (
    <div className="ask-answer" data-testid="ask-answer">
      {reply.answer.length > 0 && (
        <ul className="support-list">
          {reply.answer.map((s, i) => (
            <li key={String(i)} data-testid="ask-statement">
              <p className="support-text">
                <Marked value={{ text: s.text, marks: [...s.marks] }} />
              </p>
              <div className="chips ask-refs">
                {s.refs.map((ref, j) => {
                  const id = `${String(i)}-${String(j)}`;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={open === id ? 'chip small on' : 'chip small'}
                      aria-expanded={open === id}
                      onClick={() => {
                        setOpen(open === id ? null : id);
                      }}
                      data-testid="ask-ref"
                    >
                      {ref.label}
                    </button>
                  );
                })}
              </div>
              {s.refs.map((ref, j) =>
                open === `${String(i)}-${String(j)}` ? (
                  <div key={`q-${String(j)}`} className="tl-quote" data-testid="ask-quote">
                    <span className="part-label">
                      元の文（{quote(ref).from}
                      {ref.quoted ? '・引用の場所' : ''}）
                    </span>
                    <p className="source-text">{quote(ref).text}</p>
                  </div>
                ) : null,
              )}
            </li>
          ))}
        </ul>
      )}
      {reply.notFound !== '' && (
        <p className="note" data-testid="ask-not-found">
          {reply.notFound}
        </p>
      )}
      {reply.answer.length === 0 && reply.notFound === '' && <p className="note">根拠を確かめられる答えは、ありませんでした。</p>}
      {marks > 0 && <p className="note">下線と「※」の数は、記録に見つかりませんでした。確かめてください。</p>}
      {rejected.length > 0 && (
        <p className="note" data-testid="ask-rejected">
          出さなかったもの：{rejected.join('・')}
        </p>
      )}
      {reply.shapes > 0 && <p className="note">電話番号・メールなどの形 {String(reply.shapes)} 個を伏せました。</p>}
      {dropped > 0 && (
        <p className="note" data-testid="ask-dropped">
          資料の長さのため、古い記載 {String(reply.dropped.records)} 件・評価と方針だけにした記載 {String(reply.dropped.shortened)} 件・値 {String(reply.dropped.values)} 件・経過の出来事 {String(reply.dropped.course)} 件は、AI に全文を渡していません。
        </p>
      )}
    </div>
  );
}
