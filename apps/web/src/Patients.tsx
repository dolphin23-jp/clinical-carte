// 患者の一覧と、新しい患者（CA-014：自動の見出しで見分ける。氏名・ID・呼び名・病室の欄はない）。
import { AGE_MAX, ENCOUNTER_KIND_LABELS, ENCOUNTER_KINDS, type EncounterKind, headline, SEX_LABELS, SEXES, type Sex } from '@clinical-carte/core';
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';

import { joinDateTime, nowLocal } from './format.ts';
import { errorMessage } from './messages.ts';
import { createPatient, listPatients, type PatientSummary } from './net/api.ts';

export function Patients({ onOpen, onLeft }: { onOpen: (patientId: string) => void; onLeft: () => void }) {
  const [list, setList] = useState<{ patients: readonly PatientSummary[]; today: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
      {list === null ? (
        <p className="note">読み込んでいます…</p>
      ) : list.patients.length === 0 ? (
        <p className="note">まだ、患者はいません。</p>
      ) : (
        <ul className="rows" data-testid="patients">
          {list.patients.map(({ patient, latest, sources }) => (
            <li key={patient.id} className="row">
              <button
                className="row-button"
                type="button"
                onClick={() => {
                  onOpen(patient.id);
                }}
                data-testid="patient"
              >
                <span className="row-title">{headline({ ...patient, encounter: latest }, list.today)}</span>
                <span className="row-sub">記録 {String(sources)} 件</span>
              </button>
            </li>
          ))}
        </ul>
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
