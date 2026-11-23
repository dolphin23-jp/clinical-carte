// 画面の全体。帯は、どの状態でも出す。登録していない端末には、登録の画面だけを出す。
import { useCallback, useEffect, useState } from 'react';

import { Banner } from './Banner.tsx';
import { Devices } from './Devices.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { BookKey } from './BookKey.tsx';
import { KeyMaker } from './KeyMaker.tsx';
import { errorMessage } from './messages.ts';
import { type ApiError, type DeviceView, getSession } from './net/api.ts';
import { PatientPage } from './PatientPage.tsx';
import { Patients } from './Patients.tsx';
import { Register } from './Register.tsx';
import { OrganizeCheck } from './OrganizeCheck.tsx';
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
  const [showOrganizeCheck, setShowOrganizeCheck] = useState(false);
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
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="notes" />
          </span>
          <span className="brand-name">carte</span>
        </span>
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
          <section className="card tools" aria-labelledby="tools-title">
            <h2 id="tools-title" className="section-head">
              <Icon name="settings" />
              道具と設定
            </h2>
            <div className="tool-grid">
              {!showSelfCheck && (
                <Tool
                  icon="shield"
                  title="選別の評価"
                  sub="架空の文で、AI の落とし漏れを数える"
                  testid="show-selfcheck"
                  onOpen={() => {
                    setShowSelfCheck(true);
                  }}
                />
              )}
              {!showOrganizeCheck && (
                <Tool
                  icon="ai"
                  title="整理の評価"
                  sub="架空の文で、AI の整理の拾いすぎ・拾い漏れを数える"
                  testid="show-organizecheck"
                  onOpen={() => {
                    setShowOrganizeCheck(true);
                  }}
                />
              )}
              {!showBooks && (
                <Tool
                  icon="book"
                  title="書籍の参照元"
                  sub="clinical-RAG の設定"
                  testid="show-bookkey"
                  onOpen={() => {
                    setShowBooks(true);
                  }}
                />
              )}
              {!showDevices && (
                <Tool
                  icon="device"
                  title="登録した端末"
                  sub="端末を見る・外す"
                  testid="show-devices"
                  onOpen={() => {
                    setShowDevices(true);
                  }}
                />
              )}
            </div>
          </section>
          {showSelfCheck && <SelfCheck onLeft={toRegister} />}
          {showOrganizeCheck && <OrganizeCheck onLeft={toRegister} />}
          {showBooks && <BookKey onLeft={toRegister} />}
          {showDevices && <Devices onLeft={toRegister} />}
        </main>
      )}
    </div>
  );
}

/** 道具と設定の1つ（押すと、その欄が下に開く。開いたものは画面のメモリだけ） */
function Tool({ icon, title, sub, testid, onOpen }: { icon: IconName; title: string; sub: string; testid: string; onOpen: () => void }) {
  return (
    <button className="tool" type="button" onClick={onOpen} data-testid={testid}>
      <span className="tool-icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="tool-text">
        <strong>{title}</strong>
        <span>{sub}</span>
      </span>
      <Icon name="chevron" className="tool-go" />
    </button>
  );
}
