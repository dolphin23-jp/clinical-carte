// 画面の全体。帯は、どの状態でも出す。登録していない端末には、登録の画面だけを出す。
import { useCallback, useEffect, useState } from 'react';

import { Banner } from './Banner.tsx';
import { Devices } from './Devices.tsx';
import { BookKey } from './BookKey.tsx';
import { KeyMaker } from './KeyMaker.tsx';
import { errorMessage } from './messages.ts';
import { type ApiError, type DeviceView, getSession } from './net/api.ts';
import { PatientPage } from './PatientPage.tsx';
import { Patients } from './Patients.tsx';
import { Register } from './Register.tsx';
import { SelfCheck } from './SelfCheck.tsx';

type State =
  | { readonly at: 'loading' }
  | { readonly at: 'register' }
  | { readonly at: 'in'; readonly device: DeviceView }
  | { readonly at: 'problem'; readonly error: ApiError };

export function App() {
  const [state, setState] = useState<State>({ at: 'loading' });
  /** 開いている患者（一覧なら null）。画面のメモリだけに持つ（読み込み直すと、一覧に戻る） */
  const [patientId, setPatientId] = useState<string | null>(null);
  const [showDevices, setShowDevices] = useState(false);
  const [showBooks, setShowBooks] = useState(false);
  const [showSelfCheck, setShowSelfCheck] = useState(false);
  const toList = useCallback(() => {
    setPatientId(null);
  }, []);

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
          {state.error === 'no_key' && <KeyMaker />}
        </main>
      )}
      {state.at === 'register' && (
        <Register
          onRegistered={(device) => {
            setState({ at: 'in', device });
          }}
        />
      )}
      {state.at === 'in' && patientId !== null && <PatientPage key={patientId} patientId={patientId} onBack={toList} onLeft={toRegister} />}
      {state.at === 'in' && patientId === null && (
        <main className="page" data-testid="home">
          <Patients onOpen={setPatientId} onLeft={toRegister} />
          {showSelfCheck ? (
            <SelfCheck onLeft={toRegister} />
          ) : (
            <button
              className="button link"
              type="button"
              onClick={() => {
                setShowSelfCheck(true);
              }}
              data-testid="show-selfcheck"
            >
              選別の評価（架空の文で、AI の落とし漏れを数える）
            </button>
          )}
          {showBooks ? (
            <BookKey onLeft={toRegister} />
          ) : (
            <button
              className="button link"
              type="button"
              onClick={() => {
                setShowBooks(true);
              }}
              data-testid="show-bookkey"
            >
              書籍の参照元（clinical-RAG）の設定
            </button>
          )}
          {showDevices ? (
            <Devices onLeft={toRegister} />
          ) : (
            <button
              className="button link"
              type="button"
              onClick={() => {
                setShowDevices(true);
              }}
              data-testid="show-devices"
            >
              登録した端末を見る
            </button>
          )}
        </main>
      )}
    </div>
  );
}
