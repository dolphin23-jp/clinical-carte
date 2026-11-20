// 画面の全体。帯は、どの状態でも出す。登録していない端末には、登録の画面だけを出す。
import { useCallback, useEffect, useState } from 'react';

import { Banner } from './Banner.tsx';
import { Devices } from './Devices.tsx';
import { errorMessage } from './messages.ts';
import { type ApiError, type DeviceView, getSession } from './net/api.ts';
import { Register } from './Register.tsx';

type State =
  | { readonly at: 'loading' }
  | { readonly at: 'register' }
  | { readonly at: 'in'; readonly device: DeviceView }
  | { readonly at: 'problem'; readonly error: ApiError };

export function App() {
  const [state, setState] = useState<State>({ at: 'loading' });

  const check = useCallback(() => {
    setState({ at: 'loading' });
    void getSession().then((result) => {
      if (result.ok) setState({ at: 'in', device: result.value });
      else if (result.error === 'unregistered') setState({ at: 'register' });
      else setState({ at: 'problem', error: result.error });
    });
  }, []);

  useEffect(check, [check]);

  const toRegister = useCallback(() => {
    setState({ at: 'register' });
  }, []);

  return (
    <div className="app">
      <header className="top">
        <span className="brand">carte</span>
        <Banner />
      </header>
      {state.at === 'loading' && (
        <main className="page narrow">
          <p className="note">確かめています…</p>
        </main>
      )}
      {state.at === 'problem' && (
        <main className="page narrow">
          <p className="alert" role="alert" data-testid="problem">
            {errorMessage(state.error)}
          </p>
          <button className="button" type="button" onClick={check}>
            もう一度
          </button>
        </main>
      )}
      {state.at === 'register' && (
        <Register
          onRegistered={(device) => {
            setState({ at: 'in', device });
          }}
        />
      )}
      {state.at === 'in' && (
        <main className="page" data-testid="home">
          <section className="card" aria-labelledby="patients-title">
            <h2 id="patients-title">患者</h2>
            <p className="note">まだ入れられません。いまあるのは、入口（端末の登録）だけです。患者・受診・取り込みは、次の段で作ります。</p>
          </section>
          <Devices onLeft={toRegister} />
        </main>
      )}
    </div>
  );
}
