// スケールのテンプレ（段K11。CA-075）：先生が自分の施設の内容で作る（名前・薬・濃度・投与量の単位・段・注）。全患者に共通で、患者の情報は書かない。
// carte は、見本の数を入れない（空の欄から作る）。字は選別を通さず、識別情報の形（電話・メールなど）があればサーバーが断る（CA-079）。
// 体重を入れると、段ごとの流量を、決定論で計算して式とともに出す（判定しない）。
import {
  SCALE_AMOUNT_UNITS,
  SCALE_DOSE_UNITS,
  SCALE_DRUG_MAX,
  SCALE_NAME_MAX,
  SCALE_NOTE_MAX,
  SCALE_STEP_LABEL_MAX,
  SCALE_STEP_NOTE_MAX,
  SCALE_STEPS_MAX,
  type ScaleAmountUnit,
  type ScaleDoseUnit,
  type ScaleTemplate,
  ScaleTemplateBody,
  concentrationText,
  numberText,
  RATE_PROBLEM_NAMES,
  scaleRates,
} from '@clinical-carte/core';
import { type SyntheticEvent, useState } from 'react';

import { errorMessage } from './messages.ts';
import { addTemplate, patchTemplate, removeTemplate } from './net/api.ts';

/** 段ごとの流量の表（決定論の計算。式つき。判定しない） */
export function ScaleTable({ scale, weightKg, selected }: { scale: ScaleTemplateBody; weightKg: number | null; selected: number | null }) {
  const rates = scaleRates(scale, weightKg);
  return (
    <div className="scale-table" data-testid="scale-table">
      <p className="row-sub">
        {scale.drug === '' ? '' : `${scale.drug}・`}濃度 {concentrationText(scale)}・投与量の単位 {scale.doseUnit}
        {weightKg === null ? '' : `・体重 ${numberText(weightKg)} kg`}
      </p>
      <ul className="scale-steps">
        {rates.map(({ step, rate }, i) => (
          <li key={i} className={selected === i ? 'scale-step on' : 'scale-step'} data-testid="scale-step-row">
            <div className="scale-step-head">
              <strong>{step.label === '' ? `段${String(i + 1)}` : step.label}</strong>
              <span>{step.dose === null ? '量の記載なし' : `${numberText(step.dose)} ${scale.doseUnit}`}</span>
              <span className="scale-rate" data-testid="scale-rate">
                {rate.ok ? `→ ${numberText(rate.shown)} mL/h` : RATE_PROBLEM_NAMES[rate.problem]}
              </span>
              {selected === i && <span className="tag">いまの段</span>}
            </div>
            {step.note !== '' && <p className="row-sub">{step.note}</p>}
            {rate.ok && (
              <details className="scale-formula" data-testid="scale-formula">
                <summary>式</summary>
                {rate.formula.map((line) => (
                  <p key={line} className="row-sub">
                    {line}
                  </p>
                ))}
              </details>
            )}
          </li>
        ))}
      </ul>
      <p className="note">流量は、テンプレの数と体重から carte が計算したものです（AI は計算していません）。判定はしていません。病院の指示とポンプの設定は、先生が確かめてください。</p>
    </div>
  );
}

interface StepDraft {
  readonly label: string;
  readonly dose: string;
  readonly note: string;
}
interface Draft {
  readonly name: string;
  readonly drug: string;
  readonly amount: string;
  readonly amountUnit: ScaleAmountUnit;
  readonly volume: string;
  readonly doseUnit: ScaleDoseUnit;
  readonly steps: readonly StepDraft[];
  readonly note: string;
}

/** 新しいテンプレは、空の欄から（carte は臨床の数を入れない） */
const EMPTY: Draft = { name: '', drug: '', amount: '', amountUnit: 'mg', volume: '', doseUnit: 'μg/kg/min', steps: [{ label: '', dose: '', note: '' }], note: '' };

const draftOf = (t: ScaleTemplate): Draft => ({
  name: t.body.name,
  drug: t.body.drug,
  amount: t.body.amount === null ? '' : numberText(t.body.amount),
  amountUnit: t.body.amountUnit,
  volume: t.body.volume === null ? '' : numberText(t.body.volume),
  doseUnit: t.body.doseUnit,
  steps: t.body.steps.map((s) => ({ label: s.label, dose: s.dose === null ? '' : numberText(s.dose), note: s.note })),
  note: t.body.note,
});

const num = (s: string): number | null => {
  const t = s.normalize('NFKC').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** 下書きを、送る形にする（数が読めない欄があれば null） */
function bodyOf(d: Draft): ScaleTemplateBody | null {
  const parsed = ScaleTemplateBody.safeParse({
    name: d.name,
    drug: d.drug,
    amount: num(d.amount),
    amountUnit: d.amountUnit,
    volume: num(d.volume),
    doseUnit: d.doseUnit,
    steps: d.steps.map((s) => ({ label: s.label, dose: num(s.dose), note: s.note })),
    note: d.note,
  });
  return parsed.success ? parsed.data : null;
}

function Editor({ initial, id, onDone, onCancel, onLeft }: { initial: Draft; id: string | null; onDone: () => void; onCancel: () => void; onLeft: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [weight, setWeight] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const body = bodyOf(d);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setD({ ...d, [key]: value });
  };
  const setStep = (i: number, step: StepDraft) => {
    set(
      'steps',
      d.steps.map((s, j) => (j === i ? step : s)),
    );
  };
  const w = num(weight);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (body === null || busy) return;
    setBusy(true);
    setMessage(null);
    void (id === null ? addTemplate(body) : patchTemplate(id, body)).then((r) => {
      setBusy(false);
      if (r.ok) onDone();
      else if (r.error === 'unregistered') onLeft();
      else setMessage(r.error === 'shape' ? 'テンプレに電話番号・メールなどの形があるので、残しませんでした。患者の情報は書かないでください。' : errorMessage(r.error));
    });
  };
  return (
    <form className="form template-editor" onSubmit={submit} data-testid="template-editor">
      <p className="note">先生の施設の内容（濃度・単位・段・閾値）で作ってください。carte は見本の数を入れません。患者の情報は書かないでください（全患者に共通です）。</p>
      <div className="field-row wrap">
        <label className="field">
          <span className="field-label">名前</span>
          <input className="input" maxLength={SCALE_NAME_MAX} value={d.name} onChange={(e) => { set('name', e.target.value); }} disabled={busy} data-testid="template-name" />
        </label>
        <label className="field">
          <span className="field-label">薬</span>
          <input className="input" maxLength={SCALE_DRUG_MAX} value={d.drug} onChange={(e) => { set('drug', e.target.value); }} disabled={busy} data-testid="template-drug" />
        </label>
      </div>
      <span className="field-label">濃度（量を mL に溶かす。投与量が mL/h なら空でよい）</span>
      <div className="field-row wrap">
        <label className="field">
          <span className="field-label">量</span>
          <input className="input short" inputMode="decimal" value={d.amount} onChange={(e) => { set('amount', e.target.value); }} disabled={busy} data-testid="template-amount" />
        </label>
        <label className="field">
          <span className="field-label">単位</span>
          <select className="input" value={d.amountUnit} onChange={(e) => { set('amountUnit', e.target.value as ScaleAmountUnit); }} disabled={busy} data-testid="template-amount-unit">
            {SCALE_AMOUNT_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">mL</span>
          <input className="input short" inputMode="decimal" value={d.volume} onChange={(e) => { set('volume', e.target.value); }} disabled={busy} data-testid="template-volume" />
        </label>
      </div>
      <label className="field">
        <span className="field-label">投与量の単位（段の量の単位）</span>
        <select className="input" value={d.doseUnit} onChange={(e) => { set('doseUnit', e.target.value as ScaleDoseUnit); }} disabled={busy} data-testid="template-dose-unit">
          {SCALE_DOSE_UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </label>
      <span className="field-label">段（名前・量・注。量のない段〔「医師コール」など〕は量を空に）</span>
      <ol className="template-steps">
        {d.steps.map((s, i) => (
          <li key={i} className="field-row wrap">
            <input className="input" placeholder="段の名前" maxLength={SCALE_STEP_LABEL_MAX} value={s.label} onChange={(e) => { setStep(i, { ...s, label: e.target.value }); }} disabled={busy} data-testid={`template-step-label-${String(i)}`} />
            <input className="input short" inputMode="decimal" placeholder={`量（${d.doseUnit}）`} value={s.dose} onChange={(e) => { setStep(i, { ...s, dose: e.target.value }); }} disabled={busy} data-testid={`template-step-dose-${String(i)}`} />
            <input className="input" placeholder="注" maxLength={SCALE_STEP_NOTE_MAX} value={s.note} onChange={(e) => { setStep(i, { ...s, note: e.target.value }); }} disabled={busy} data-testid={`template-step-note-${String(i)}`} />
            <button type="button" className="chip small" disabled={busy} onClick={() => { set('steps', d.steps.filter((_, j) => j !== i)); }}>
              段を外す
            </button>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button type="button" className="button small" disabled={busy || d.steps.length >= SCALE_STEPS_MAX} onClick={() => { set('steps', [...d.steps, { label: '', dose: '', note: '' }]); }} data-testid="template-step-add">
          段を足す
        </button>
      </div>
      <label className="field">
        <span className="field-label">注（施設の決まりなど）</span>
        <textarea className="input area" rows={2} maxLength={SCALE_NOTE_MAX} value={d.note} onChange={(e) => { set('note', e.target.value); }} disabled={busy} data-testid="template-note" />
      </label>
      <label className="field">
        <span className="field-label">試しの体重（kg。計算を見るだけで、残しません）</span>
        <input className="input short" inputMode="decimal" value={weight} onChange={(e) => { setWeight(e.target.value); }} disabled={busy} data-testid="template-preview-weight" />
      </label>
      {body !== null ? <ScaleTable scale={body} weightKg={w !== null && Number.isFinite(w) && w > 0 ? w : null} selected={null} /> : <p className="note">名前を入れ、数の欄は数で入れてください（0 より大きい数）。</p>}
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      <div className="actions">
        <button className="button primary" type="submit" disabled={busy || body === null} data-testid="template-save">
          {id === null ? 'テンプレを残す' : '直したテンプレを残す'}
        </button>
        <button className="button" type="button" onClick={onCancel} disabled={busy}>
          やめる
        </button>
      </div>
      {id !== null && <p className="note">直しても、すでに指示簿に入れた点滴の中身は変わりません（入れたときの中身を持ちます）。</p>}
    </form>
  );
}

export function OrderTemplates({ templates, onChanged, onLeft }: { templates: readonly ScaleTemplate[]; onChanged: () => void; onLeft: () => void }) {
  const [editing, setEditing] = useState<string | null>(templates.length === 0 ? 'new' : null);
  const [message, setMessage] = useState<string | null>(null);
  const done = () => {
    setEditing(null);
    onChanged();
  };
  return (
    <div className="order-templates" data-testid="order-templates">
      <h4 className="order-cat">スケールのテンプレ（全患者に共通・{String(templates.length)}）</h4>
      <ul className="order-list">
        {templates.map((t) => (
          <li key={t.id} className="order-item" data-testid="template-item">
            <div className="order-head">
              <strong>{t.body.name}</strong>
              <span className="row-sub">
                {t.body.drug === '' ? '' : `${t.body.drug}・`}
                {concentrationText(t.body)}・{t.body.doseUnit}・段 {String(t.body.steps.length)}
              </span>
            </div>
            {editing === t.id ? (
              <Editor
                initial={draftOf(t)}
                id={t.id}
                onDone={done}
                onCancel={() => {
                  setEditing(null);
                }}
                onLeft={onLeft}
              />
            ) : (
              <div className="chips">
                <button type="button" className="chip small" onClick={() => { setEditing(t.id); }} data-testid="template-edit">
                  直す
                </button>
                <button
                  type="button"
                  className="chip small"
                  onClick={() => {
                    setMessage(null);
                    void removeTemplate(t.id).then((r) => {
                      if (r.ok) onChanged();
                      else if (r.error === 'unregistered') onLeft();
                      else setMessage(errorMessage(r.error));
                    });
                  }}
                  data-testid="template-remove"
                >
                  外す
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {editing === 'new' ? (
        <Editor
          initial={EMPTY}
          id={null}
          onDone={done}
          onCancel={() => {
            setEditing(null);
          }}
          onLeft={onLeft}
        />
      ) : (
        <div className="actions">
          <button type="button" className="button small" onClick={() => { setEditing('new'); }} data-testid="template-new">
            新しいテンプレを作る
          </button>
        </div>
      )}
    </div>
  );
}
