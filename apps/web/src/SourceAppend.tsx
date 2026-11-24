// 続きを足す（CA-050）：保存した記載の末尾に、文を足す。足す文だけを、入れるときと同じ選別（AI が識別情報の場所を指し、サーバーが置き換える）に通す。
// それまでの文は変えない。長い記載を、短く刻んで入れられるようにするため（打ちかけの文を端末に残さない決まりのかわり）。続けて、整理し直す。
import { TEXT_LIMIT } from '@clinical-carte/core';
import { useState } from 'react';

import { errorMessage } from './messages.ts';
import { appendSource, type Source } from './net/api.ts';
import { runOrganize } from './organizing.ts';
import { NextDayAsk, type NextDayAnswer, nextDayKey } from './NextDayAsk.tsx';

export function SourceAppend({ source, onChanged, onLeft }: { source: Source; onChanged: () => void; onLeft: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 日をまたいだかの答え（CA-047）：足したあとの文で聞く。前の文ですでに翌日と答えた場所なら、はじめから翌日
  const combined = text.trim() === '' ? source.text : `${source.text}\n${text}`;
  const turnKey = source.at === null ? null : nextDayKey(combined);
  const [answer, setAnswer] = useState<NextDayAnswer | null>(null);
  const initial = turnKey !== null && source.nextDayFrom !== null && nextDayKey(source.text) === turnKey ? { key: turnKey, next: true } : null;
  const current = answer?.key === turnKey ? answer : initial;
  const answered = turnKey === null || current !== null;
  const tooLong = combined.length > TEXT_LIMIT;

  const send = () => {
    if (busy || text.trim() === '' || !answered || tooLong) return;
    setBusy(true);
    setMessage(null);
    void (async () => {
      const r = await appendSource(source.id, text, turnKey === null ? undefined : (current?.next ?? false));
      if (!r.ok) {
        setBusy(false);
        // 打った文は、欄に残す（もう一度送れる）
        if (r.error === 'unregistered') onLeft();
        else setMessage(errorMessage(r.error));
        return;
      }
      setText('');
      setAnswer(null);
      // 足したあとの文を、続けて整理し直す（整理に失敗しても、文は保存されている）
      const organized = await runOrganize(source.id);
      setBusy(false);
      setMessage(organized.ok ? '続きを足し、整理し直しました。' : '続きを足しました（整理できなかったので、「整理する」で、もう一度整理できます）。');
      onChanged();
    })();
  };

  return (
    <details className="picker" data-testid="append">
      <summary>続きを足す</summary>
      <p className="note">この記載の末尾に、文を足します。足す文だけを、入れるときと同じく AI の選別に通してから保存し、続けて整理し直します（AI の2回）。それまでの文は変えません。</p>
      <textarea
        className="input area"
        value={text}
        rows={5}
        disabled={busy}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
        }}
        data-testid="append-text"
      />
      <NextDayAsk text={combined} day={source.at === null ? null : source.at.slice(0, 10)} answer={current} onAnswer={setAnswer} disabled={busy} />
      <p className={tooLong ? 'note over' : 'note'}>
        足したあと {String(combined.length)} / {String(TEXT_LIMIT)} 字
      </p>
      {message !== null && (
        <p className="note" role="status" data-testid="append-message">
          {message}
        </p>
      )}
      <button type="button" className="button small primary" disabled={busy || text.trim() === '' || !answered || tooLong} onClick={send} data-testid="append-save">
        {busy ? '選別しています…' : '続きを足す'}
      </button>
    </details>
  );
}
