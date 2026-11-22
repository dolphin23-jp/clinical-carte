// 記録に聞く（段K6。CA-058 の A4・CA-066）：この患者の記録について問いを打つと、記録だけから AI が答え、答えの文ごとに、記録のどこに書かれているかを付ける。
// - 問いと答えは、保存しない（画面のメモリだけ。閉じる・読み込み直すと消える）。カルテ記載の相談と同じ
// - 問いに電話番号・メールなどの形があれば、送らない（core の findShapes。サーバーも同じ関数で断る）
// - 根拠の札を押すと、元の字（どの記載の・いつの・どこか）が開く。記録に見つからない数には下線と「※」。根拠を確かめられなかった文は出さず、理由ごとの数を出す
// - いつも「記録だけから答えます。書かれていないことは答えません」を出す
import { ASK_QUESTION_MAX, ASK_REJECT_NAMES, ASK_REJECT_REASONS, type AskRef, type AskReply, findShapes, SOURCE_KIND_LABELS } from '@clinical-carte/core';
import { useState } from 'react';

import { showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { askRecord, type PatientRecord } from './net/api.ts';
import { Marked } from './SupportView.tsx';

export function AskPanel({ patientId, record, onLeft }: { patientId: string; record: PatientRecord; onLeft: () => void }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 答えは、画面のメモリだけ（保存しない）
  const [answered, setAnswered] = useState<{ question: string; reply: AskReply } | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const ask = () => {
    const q = question.trim();
    if (q === '') return;
    // 識別情報の形があれば、送らない（相談の頼みと同じ）
    if (findShapes(q).length > 0) {
      setMessage(errorMessage('shape').replace('記載か頼みに', '問いに'));
      return;
    }
    setBusy(true);
    setMessage(null);
    void askRecord(patientId, q).then((r) => {
      setBusy(false);
      if (r.ok) {
        setAnswered({ question: q, reply: r.value });
        setOpen(null);
      } else if (r.error === 'unregistered') onLeft();
      else setMessage(errorMessage(r.error).replace('文は保存していません。', '').replace('記載か頼みに', '問いに'));
    });
  };

  const quote = (ref: AskRef): { from: string; text: string } => {
    const s = record.sources.find((x) => x.id === ref.sourceId);
    return s === undefined ? { from: '', text: '' } : { from: `${SOURCE_KIND_LABELS[s.kind]}・${showDateTime(s.at)}`, text: s.text.slice(ref.start, ref.end) };
  };
  const reply = answered?.reply ?? null;
  const rejected = reply === null ? [] : ASK_REJECT_REASONS.flatMap((r) => ((reply.rejected[r] ?? 0) > 0 ? [`${ASK_REJECT_NAMES[r]} ${String(reply.rejected[r] ?? 0)} 件`] : []));
  const marks = reply === null ? 0 : reply.answer.reduce((n, s) => n + s.marks.length, 0);
  const dropped = reply === null ? 0 : reply.dropped.records + reply.dropped.shortened + reply.dropped.values + reply.dropped.course;

  return (
    <section className="state-section ask" data-testid="ask" aria-labelledby="ask-title">
      <h3 id="ask-title" className="sub-title">
        記録に聞く <span className="tag ai-tag">AI</span>
      </h3>
      <p className="support-caution" data-testid="ask-caution">
        記録だけから答えます。書かれていないことは答えません。
      </p>
      <label className="ask-label" htmlFor="ask-question">
        問い（例：K をいつ、どれだけ補正した？・抗菌薬を変えた理由は？・家族への説明は何回？）
      </label>
      <textarea
        id="ask-question"
        rows={2}
        maxLength={ASK_QUESTION_MAX}
        value={question}
        onChange={(e) => {
          setQuestion(e.target.value);
        }}
        data-testid="ask-question"
      />
      <div className="ask-actions">
        <button type="button" className="button" disabled={busy || question.trim() === ''} onClick={ask} data-testid="ask-send">
          {busy ? '記録を読んでいます…' : '聞く'}
        </button>
        <span className="note">問いと答えは保存しません（画面を閉じると消えます）。</span>
      </div>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {answered !== null && reply !== null && (
        <div className="ask-answer" data-testid="ask-answer">
          <p className="thread-sub" data-testid="ask-asked">
            問い：{answered.question}
          </p>
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
      )}
    </section>
  );
}
