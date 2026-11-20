// サーバーに合鍵がまだないときだけ出る、合鍵の作り方の案内（docs/05 の手順）。
// 合鍵は、この端末の中で、乱数から作る（どこにも送らない・保存しない。画面を閉じると消える）。
// 作った合鍵は、まだ「案」：Cloudflare の画面で、サーバーの秘密（CARTE_KEY）として置いたときに、はじめて合鍵になる。
import { useState } from 'react';

/** 32 バイトの乱数を、16進の 64 文字にする（サーバーが受け付ける長さ・字の種類を満たす） */
export function makeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function KeyMaker() {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');

  return (
    <section className="card" aria-labelledby="keymaker-title" data-testid="keymaker">
      <h2 id="keymaker-title">合鍵を作る</h2>
      <p className="note">合鍵は、端末を登録するときに1回ずつ入れる、長い文字列です。ここで作った合鍵は、この端末の中だけにあり、どこにも送られません。画面を閉じると消えます。</p>
      {key === null ? (
        <button
          className="button primary"
          type="button"
          onClick={() => {
            setKey(makeKey());
          }}
          data-testid="make-key"
        >
          合鍵を作る
        </button>
      ) : (
        <>
          <p className="key" data-testid="made-key">
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
              data-testid="copy-key"
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
            <li>「パスワード」アプリなどに、新しい項目として貼って、控える（ほかの端末を登録するときに、また使います）。</li>
            <li>Cloudflare の画面で、この Worker の秘密 CARTE_KEY の値として貼って、保存する。</li>
            <li>この画面を読み込み直すと、端末の登録の画面になります。同じ合鍵を貼って、登録します。</li>
          </ol>
          <p className="note">この画面を閉じる前に、1 と 2 を済ませてください。閉じたあとは、同じ合鍵を見られません（作り直せば、別の合鍵になります）。</p>
        </>
      )}
    </section>
  );
}
