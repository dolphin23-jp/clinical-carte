// 端末の登録（CA-019）：端末ごとに最初の1回、合鍵を入れる。以後、この画面は出ない。
// 合鍵は、送るときに使うだけ。画面の状態からも、送ったあとに消す。端末の保存先には置かない。
import { DEVICE_KIND_LABELS, DEVICE_KINDS, type DeviceKind } from '@clinical-carte/core';
import { type SyntheticEvent, useState } from 'react';

import { errorMessage } from './messages.ts';
import { type DeviceView, registerDevice } from './net/api.ts';

/** 端末の種類の、最初の選択。iPad は Mac と名乗ることがあるので、タッチの有無も見る */
export function guessKind(userAgent: string, maxTouchPoints: number): DeviceKind {
  if (/iPhone|iPod/.test(userAgent)) return 'iphone';
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return 'ipad';
  if (/Android|Mobile/.test(userAgent)) return 'other';
  return 'pc';
}

export function Register({ onRegistered }: { onRegistered: (device: DeviceView) => void }) {
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<DeviceKind>(() => guessKind(navigator.userAgent, navigator.maxTouchPoints));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || key === '') return;
    setBusy(true);
    setMessage(null);
    void registerDevice(key, kind).then((result) => {
      setBusy(false);
      setKey('');
      if (result.ok) onRegistered(result.value);
      else setMessage(errorMessage(result.error, result.left));
    });
  };

  return (
    <main className="page narrow">
      <h1>この端末を登録する</h1>
      <p className="lead">最初の1回だけ、合鍵を入れます。登録すると、この端末では、次からこの画面は出ません。</p>
      <form className="card" onSubmit={submit}>
        <label className="field">
          <span className="field-label">合鍵</span>
          <input
            className="input"
            type="password"
            name="carte-key"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
            }}
            disabled={busy}
            data-testid="key"
          />
        </label>
        <fieldset className="field">
          <legend className="field-label">端末の種類</legend>
          <div className="choices">
            {DEVICE_KINDS.map((k) => (
              <label key={k} className="choice">
                <input
                  type="radio"
                  name="kind"
                  value={k}
                  checked={kind === k}
                  onChange={() => {
                    setKind(k);
                  }}
                  disabled={busy}
                />
                <span>{DEVICE_KIND_LABELS[k]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {message !== null && (
          <p className="alert" role="alert" data-testid="register-error">
            {message}
          </p>
        )}
        <button className="button primary" type="submit" disabled={busy || key === ''} data-testid="register">
          {busy ? '確かめています…' : '登録する'}
        </button>
      </form>
      <p className="note">端末をなくしたときは、登録済みの別の端末から、その端末を外せます。日々の守りは、端末のロック（Face ID・パスコード）です。</p>
    </main>
  );
}
