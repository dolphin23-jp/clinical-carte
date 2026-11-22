// 患者の一覧（回診リスト。段3d・CA-028）と、新しい患者（CA-014：自動の見出しで見分ける。氏名・ID・呼び名・病室の欄はない）。
// 回診リストの行は、自動の見出し・記録の上での病日・いまの問題の名前・記録の上で最後の日時だけ（作文しない。判定しない）。
// 受け持ち全員の申し送り（段K7。CA-067）：患者ごとに、1行の要約と、残した申し送りのいちばん新しいもの（先生が選んだ重症度・日）を読むだけ。
// AI は呼ばない（全員の分を自動で出さない）。申し送りを出す・直すのは、患者の画面の「記載」。
// 受け持ちから探す（段K8。CA-070）：保存した記録から字で探す（AI を使わない。探す字は保存しない）。当たりを押すと、その患者の記載を開く。
import { AGE_MAX, DOC_ORIGIN_NAMES, DOC_SECTIONS, dayOnRecord, ENCOUNTER_KIND_LABELS, ENCOUNTER_KINDS, type EncounterKind, headline, oneLinerOf, SEX_LABELS, SEXES, type SavedHandoff, type Sex } from '@clinical-carte/core';
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';

import { SeverityTag } from './DocumentView.tsx';
import { joinDateTime, nowLocal, showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { createPatient, listHandoffs, listPatients, type PatientSummary } from './net/api.ts';
import { type OpenFocus, SearchPanel } from './SearchView.tsx';

export function Patients({ onOpen, onLeft }: { onOpen: (patientId: string, focus?: OpenFocus) => void; onLeft: () => void }) {
  const [list, setList] = useState<{ patients: readonly PatientSummary[]; today: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // 受け持ち全員の申し送り（開いたときだけ読む。画面のメモリだけ）
  const [handoffs, setHandoffs] = useState<ReadonlyMap<string, SavedHandoff> | 'loading' | null>(null);

  const load = useCallback(() => {
    void listPatients().then((result) => {
      if (result.ok) setList(result.value);
      else if (result.error === 'unregistered') onLeft();
      else setMessage(errorMessage(result.error));
    });
  }, [onLeft]);
  useEffect(load, [load]);

  return (
    <section className="card" aria-labelledby="patients-title">
      <div className="card-head">
        <h2 id="patients-title">患者</h2>
        {list !== null && list.patients.length > 0 && (
          <button
            className="button"
            type="button"
            aria-expanded={handoffs !== null}
            onClick={() => {
              if (handoffs !== null) {
                setHandoffs(null);
                return;
              }
              setHandoffs('loading');
              void listHandoffs().then((r) => {
                if (r.ok) setHandoffs(new Map(r.value.map((x) => [x.patientId, x.handoff])));
                else {
                  setHandoffs(null);
                  if (r.error === 'unregistered') onLeft();
                  else setMessage(errorMessage(r.error));
                }
              });
            }}
            data-testid="handoff-all-toggle"
          >
            {handoffs === null ? '受け持ち全員の申し送り' : '申し送りを閉じる'}
          </button>
        )}
        {!adding && (
          <button
            className="button primary"
            type="button"
            onClick={() => {
              setAdding(true);
            }}
            data-testid="new-patient"
          >
            新しい患者
          </button>
        )}
      </div>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {adding && (
        <NewPatientForm
          onCancel={() => {
            setAdding(false);
          }}
          onCreated={onOpen}
          onLeft={onLeft}
        />
      )}
      {list !== null && list.patients.length > 0 && <SearchPanel onOpen={onOpen} onLeft={onLeft} />}
      {list !== null && handoffs !== null && <HandoffAll patients={list.patients.filter((p) => p.latest !== null && p.latest.end === null)} today={list.today} handoffs={handoffs} onOpen={onOpen} />}
      {list === null ? (
        <p className="note">読み込んでいます…</p>
      ) : list.patients.length === 0 ? (
        <p className="note">まだ、患者はいません。</p>
      ) : (
        <>
          {(['active', 'ended'] as const).map((which) => {
            const rows = list.patients.filter((p) => (which === 'active') === (p.latest !== null && p.latest.end === null));
            if (rows.length === 0) return null;
            return (
              <section key={which} className="round-group" data-testid={`round-${which}`}>
                <h3 className="sub-title">
                  {which === 'active' ? '受け持ち中（受診の終わりが入っていない）' : '受診が終わった患者'}（{String(rows.length)}）
                </h3>
                <ul className="rows" data-testid="patients">
                  {rows.map((summary) => (
                    <RoundRow key={summary.patient.id} summary={summary} today={list.today} onOpen={onOpen} />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}

function RoundRow({ summary, today, onOpen }: { summary: PatientSummary; today: string; onOpen: (patientId: string) => void }) {
  const { patient, latest, sources, round } = summary;
  const day = latest === null ? null : dayOnRecord(latest, round.asOf);
  return (
    <li className="row">
      <button
        className="row-button"
        type="button"
        onClick={() => {
          onOpen(patient.id);
        }}
        data-testid="patient"
      >
        <span className="row-title">{headline({ ...patient, encounter: latest }, today)}</span>
        <span className="round-problems" data-testid="round-problems">
          {day !== null && <span className="tag">{`${String(day)}病日（記録の上で）`}</span>}
          {round.listed && <span className="tag ai-tag">AI の整理</span>}
          {round.problems.length === 0 ? 'いまの問題の記載なし' : round.problems.join('、')}
        </span>
        {summary.handoff !== null && (
          <span className="round-handoff" data-testid="round-handoff">
            <span className="tag">申し送り {summary.handoff.day.slice(5).replace('-', '/')}</span>
            <SeverityTag severity={summary.handoff.severity} />
          </span>
        )}
        <span className="row-sub">
          {round.asOf === null ? '記録の上の日時なし' : `記録の上で最後：${showDateTime(round.asOf)}`}・記録 {String(sources)} 件
          {round.otherProblems > 0 && `・解決などと書かれた問題 ${String(round.otherProblems)}`}
          {round.unlinked > 0 && `・つないでいない問題の記載 ${String(round.unlinked)}`}
        </span>
      </button>
    </li>
  );
}

/** 受け持ち全員の申し送り（読むだけ）：1行の要約（決定論）と、残した申し送りのいちばん新しいもの */
function HandoffAll({ patients, today, handoffs, onOpen }: { patients: readonly PatientSummary[]; today: string; handoffs: ReadonlyMap<string, SavedHandoff> | 'loading'; onOpen: (patientId: string) => void }) {
  return (
    <section className="handoff-all" aria-label="受け持ち全員の申し送り" data-testid="handoff-all">
      <h3 className="sub-title">受け持ち全員の申し送り（{String(patients.length)}）</h3>
      <p className="note">残した申し送りのうち、いちばん新しいものを読むだけです（ここでは AI を使いません）。重症度は、先生が選んだものです。出す・直すのは、患者の画面の「記載」からです。</p>
      {handoffs === 'loading' ? (
        <p className="note">読み込んでいます…</p>
      ) : patients.length === 0 ? (
        <p className="note">受け持ち中の患者はいません。</p>
      ) : (
        patients.map((summary) => {
          const h = handoffs.get(summary.patient.id) ?? null;
          const encounter = summary.latest;
          return (
            <article key={summary.patient.id} className="handoff-card" data-testid="handoff-card">
              <div className="handoff-card-head">
                <button
                  type="button"
                  className="button link"
                  onClick={() => {
                    onOpen(summary.patient.id);
                  }}
                >
                  {headline({ ...summary.patient, encounter }, today)}
                </button>
                {h !== null && <SeverityTag severity={h.severity} />}
                {h !== null && <span className="tag">{`${h.day.slice(5).replace('-', '/')} の申し送り・${DOC_ORIGIN_NAMES[h.origin]}`}</span>}
              </div>
              {encounter !== null && (
                <p className="handoff-oneliner" data-testid="handoff-oneliner">
                  {oneLinerOf({ patient: summary.patient, encounter, today, asOf: summary.round.asOf, problems: summary.round.problems, listed: summary.round.listed })}
                </p>
              )}
              {h === null ? (
                <p className="note" data-testid="handoff-none">
                  残した申し送りはありません。
                </p>
              ) : (
                DOC_SECTIONS.handoff.map((d) => {
                  const text = h.sections.find((x) => x.key === d.key)?.text ?? '';
                  return (
                    <div key={d.key}>
                      <h4 className="doc-heading">【{d.heading}】</h4>
                      {text === '' ? <p className="doc-empty">（書かれていません）</p> : <p className="doc-text">{text}</p>}
                    </div>
                  );
                })
              )}
            </article>
          );
        })
      )}
    </section>
  );
}

function NewPatientForm({ onCancel, onCreated, onLeft }: { onCancel: () => void; onCreated: (patientId: string) => void; onLeft: () => void }) {
  const [age, setAge] = useState('');
  const [sex, setSex] = useState<Sex | null>(null);
  const [kind, setKind] = useState<EncounterKind>('inpatient');
  const [day, setDay] = useState(() => nowLocal().day);
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const ageNumber = /^\d{1,3}$/.test(age) ? Number(age) : null;
  const ready = ageNumber !== null && ageNumber <= AGE_MAX && sex !== null && day !== '';

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || ageNumber === null || sex === null || !ready) return;
    setBusy(true);
    setMessage(null);
    void createPatient({ age: ageNumber, ageOn: nowLocal().day, sex, encounter: { kind, start: joinDateTime(day, time) } }).then((result) => {
      setBusy(false);
      if (result.ok) onCreated(result.value.id);
      else if (result.error === 'unregistered') onLeft();
      else setMessage(errorMessage(result.error));
    });
  };

  return (
    <form className="form" onSubmit={submit} data-testid="new-patient-form">
      <p className="note">氏名・ID・生年月日は、入れる欄がありません。患者は、年齢・性別・受診の日で見分けます。</p>
      <label className="field">
        <span className="field-label">年齢（歳。乳児は 0）</span>
        <input
          className="input short"
          inputMode="numeric"
          autoComplete="off"
          value={age}
          onChange={(e) => {
            setAge(e.target.value.trim());
          }}
          disabled={busy}
          data-testid="age"
        />
      </label>
      <fieldset className="field">
        <legend className="field-label">性別</legend>
        <div className="choices">
          {SEXES.map((s) => (
            <label key={s} className="choice">
              <input
                type="radio"
                name="sex"
                checked={sex === s}
                onChange={() => {
                  setSex(s);
                }}
                disabled={busy}
              />
              <span>{SEX_LABELS[s]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend className="field-label">受診</legend>
        <div className="choices">
          {ENCOUNTER_KINDS.map((k) => (
            <label key={k} className="choice">
              <input
                type="radio"
                name="encounter-kind"
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                }}
                disabled={busy}
              />
              <span>{ENCOUNTER_KIND_LABELS[k]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field-row">
        <label className="field">
          <span className="field-label">開始の日</span>
          <input
            className="input"
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
            }}
            disabled={busy}
            data-testid="start-day"
          />
        </label>
        <label className="field">
          <span className="field-label">時刻（分かれば）</span>
          <input
            className="input"
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
            }}
            disabled={busy}
          />
        </label>
      </div>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      <div className="actions">
        <button className="button primary" type="submit" disabled={busy || !ready} data-testid="create-patient">
          {busy ? '作っています…' : '作る'}
        </button>
        <button className="button" type="button" onClick={onCancel} disabled={busy}>
          やめる
        </button>
      </div>
    </form>
  );
}
