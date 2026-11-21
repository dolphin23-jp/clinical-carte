// 書籍の参照元（clinical-RAG）の鍵（2026-11-21。RAG の docs/clinical-use.md の 1i）：A/P の案・議論で、先生の clinical-RAG の書籍を根拠に使うための鍵。
// 鍵は、この端末の中で乱数から作る（どこにも送らない・保存しない。画面を閉じると消える）。Cloudflare の2か所の Secret に同じ値を置いたときに、はじめて鍵になる。
// RAG の側では、この鍵は書籍の検索（POST /api/search）しか開けない。carte が送るのは問題の名前だけ。
import { useState } from 'react';

import { makeKey } from './KeyMaker.tsx';
import { errorMessage } from './messages.ts';
import { type BookStatus, getReferences } from './net/api.ts';

const STATUS_TEXT: Readonly<Record<BookStatus, string>> = {
  off: '設定されていません（書籍は根拠に使いません。記録とネットだけで動きます）。',
  ok: 'つながっています。A/P の案・議論で、書籍を根拠に使います。',
  unauthorized: 'clinical-RAG が鍵を断りました。2 か所に貼った値が同じか、clinical-RAG の新しい版が配られているかを確かめてください。',
  unavailable: 'clinical-RAG につながりませんでした。少し待って、もう一度確かめてください。',
};

export function BookKey({ onLeft }: { onLeft: () => void }) {
  const [status, setStatus] = useState<BookStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');

  const check = () => {
    setChecking(true);
    setMessage(null);
    void getReferences().then((r) => {
      setChecking(false);
      if (r.ok) setStatus(r.value);
      else if (r.error === 'unregistered') onLeft();
      else setMessage(errorMessage(r.error));
    });
  };

  return (
    <section className="card" aria-labelledby="bookkey-title" data-testid="bookkey">
      <h2 id="bookkey-title">書籍の参照元（clinical-RAG）</h2>
      <p className="note">A/P の案と AI との議論で、先生の clinical-RAG の書籍を根拠に使うための設定です（任意）。carte が clinical-RAG に送るのは、問題の名前だけです。ここで作る鍵は、clinical-RAG の書籍の検索しか開けません。</p>
      <div className="actions">
        <button type="button" className="button" disabled={checking} onClick={check} data-testid="bookkey-check">
          {checking ? '確かめています…' : 'つながりを確かめる'}
        </button>
      </div>
      {status !== null && (
        <p className={status === 'ok' ? 'done' : 'note'} role="status" data-testid="bookkey-status">
          {STATUS_TEXT[status]}
        </p>
      )}
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {key === null ? (
        <button
          type="button"
          className="button primary"
          onClick={() => {
            setKey(makeKey());
            setCopied('no');
          }}
          data-testid="bookkey-make"
        >
          鍵を作る
        </button>
      ) : (
        <>
          <p className="key" data-testid="bookkey-key">
            {key}
          </p>
          <div className="actions">
            <button
              className="button primary"
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(key).then(
                  () => {
                    setCopied('yes');
                  },
                  () => {
                    setCopied('failed');
                  },
                );
              }}
              data-testid="bookkey-copy"
            >
              コピーする
            </button>
          </div>
          {copied === 'yes' && (
            <p className="done" role="status">
              コピーしました。
            </p>
          )}
          {copied === 'failed' && (
            <p className="alert" role="alert">
              コピーできませんでした。上の文字を長押しして、すべて選んでコピーしてください。
            </p>
          )}
          <ol className="steps">
            <li>Cloudflare：Workers &amp; Pages → medbook-rag → Settings → Variables and Secrets → Add。Type は Secret、名前は CARTE_SEARCH_TOKEN、値に貼って、Deploy。</li>
            <li>Cloudflare：Workers &amp; Pages → clinical-carte → Settings → Variables and Secrets → Add。Type は Secret、名前は RAG_TOKEN、値に同じものを貼って、Deploy。</li>
            <li>この画面に戻り、「つながりを確かめる」を押す。</li>
          </ol>
          <p className="note">この画面を閉じる前に、1 と 2 を済ませてください。閉じたあとは、同じ鍵を見られません（作り直せば別の鍵になり、2 か所とも貼り直します）。鍵は、この会話や、ほかの人に送らないでください。</p>
        </>
      )}
    </section>
  );
}
