// 記載から整理した事実を見る・直す（段3e。docs/04 の 10）。直せるのは、外す・戻すと、選ぶだけの直し（投薬の動き・できごとの種類・日時）。
// 打つ欄はない（打った文は選別を通す決まり。docs/01 の 2）。直した記録（fact_edits）を、その記載の事実の分だけ出す。
import { EVENT_KIND_NAMES, EVENT_KINDS, FACT_FIELD_NAMES, type FactKind, type FactPatch, MEDICATION_ACTION_NAMES, MEDICATION_ACTIONS } from '@clinical-carte/core';
import { useState } from 'react';

import { joinDateTime, showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { type ClinicalEvent, type FactEdit, type Medication, type Observation, patchFact } from './net/api.ts';

interface Row {
  readonly fact: FactKind;
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly at: string | null;
  readonly excluded: boolean;
  readonly edited: boolean;
  readonly action?: Medication['action'];
  readonly kind?: ClinicalEvent['kind'];
}

const FACT_NAMES: Readonly<Record<FactKind, string>> = { medication: '投薬', event: 'できごと', observation: '値' };

export function SourceFacts({
  medications,
  events,
  observations,
  edits,
  onChanged,
  onLeft,
}: {
  medications: readonly Medication[];
  events: readonly ClinicalEvent[];
  observations: readonly Observation[];
  edits: readonly FactEdit[];
  onChanged: () => void;
  onLeft: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const rows: Row[] = [
    ...medications.map((m) => ({ fact: 'medication' as const, id: m.id, label: '投薬', text: `${m.name}${m.doseText === null ? '' : ` ${m.doseText}`}`, at: m.at, excluded: m.excluded, edited: m.edited, action: m.action })),
    ...events.map((e) => ({ fact: 'event' as const, id: e.id, label: EVENT_KIND_NAMES[e.kind], text: e.title, at: e.at, excluded: e.excluded, edited: e.edited, kind: e.kind })),
    ...observations.map((o) => ({ fact: 'observation' as const, id: o.id, label: '値', text: `${o.nameRaw} ${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`, at: o.at, excluded: o.excluded, edited: o.edited })),
  ];
  if (rows.length === 0) return null;
  const ids = new Set(rows.map((r) => r.id));
  const mine = edits.filter((e) => ids.has(e.target));
  const nameOf = new Map(rows.map((r) => [r.id, `${FACT_NAMES[r.fact]}「${r.text}」`]));

  const run = (row: Row, patch: FactPatch) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    void patchFact(row.fact, row.id, patch).then((r) => {
      setBusy(false);
      if (!r.ok) {
        if (r.error === 'unregistered') onLeft();
        else setMessage(errorMessage(r.error));
      }
      onChanged();
    });
  };
  const excludedCount = rows.filter((r) => r.excluded).length;

  return (
    <details className="source-facts" data-testid="source-facts">
      <summary>
        この記載から整理した事実を見る・直す（{String(rows.length)}
        {excludedCount > 0 && `、うち外した ${String(excludedCount)}`}）
      </summary>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      <ul className="fact-list">
        {rows.map((row) => (
          <FactRow key={row.id} row={row} busy={busy} onPatch={(patch) => {
            run(row, patch);
          }} />
        ))}
      </ul>
      {mine.length > 0 && (
        <div className="fact-edits" data-testid="fact-edits">
          <span className="field-label">直した記録（{String(mine.length)}）</span>
          <ul className="fact-list">
            {mine.map((e) => (
              <li key={e.id} className="fact-row">
                <span className="fact-when">{showDateTime(e.at)}</span>
                <span className="fact-main">
                  {nameOf.get(e.target) ?? '事実'}：{FACT_FIELD_NAMES[e.field]}{'\u3000'}{editValue(e.field, e.before)} → {editValue(e.field, e.after)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="note">外した事実は、経過表・検査・投薬・問題・いま・草案に出なくなります（消してはいないので、戻せます）。整理し直しても、同じ場所の事実には、直した値を引き継ぎます。</p>
    </details>
  );
}

function editValue(field: FactEdit['field'], value: string | null): string {
  if (field === 'excluded') return value === '1' ? '外した' : '使う';
  if (value === null) return field === 'at' ? '日時不明' : '記載なし';
  if (field === 'action') return MEDICATION_ACTION_NAMES[value as keyof typeof MEDICATION_ACTION_NAMES];
  if (field === 'kind') return EVENT_KIND_NAMES[value as keyof typeof EVENT_KIND_NAMES];
  return showDateTime(value);
}

function FactRow({ row, busy, onPatch }: { row: Row; busy: boolean; onPatch: (patch: FactPatch) => void }) {
  const [day, setDay] = useState(row.at?.slice(0, 10) ?? '');
  const [time, setTime] = useState(row.at !== null && row.at.length > 10 ? row.at.slice(11, 16) : '');
  return (
    <li className={row.excluded ? 'fact-row fact-excluded' : 'fact-row'} data-testid="fact-row" data-excluded={row.excluded}>
      <span className="fact-when">{showDateTime(row.at)}</span>
      <span className="fact-main">
        <span className="tag">{row.label}</span>
        {row.text}
        {row.excluded && <span className="tag">外した</span>}
        {row.edited && !row.excluded && <span className="tag">直した</span>}
      </span>
      <span className="fact-controls">
        <button
          type="button"
          className="button small"
          disabled={busy}
          onClick={() => {
            onPatch({ excluded: !row.excluded });
          }}
          data-testid="fact-exclude"
        >
          {row.excluded ? '戻す' : '外す'}
        </button>
        {row.fact === 'medication' && (
          <select
            className="input compact"
            aria-label="投薬の動き"
            value={row.action ?? ''}
            disabled={busy || row.excluded}
            onChange={(e) => {
              const v = e.target.value;
              onPatch({ action: v === '' ? null : (v as (typeof MEDICATION_ACTIONS)[number]) });
            }}
            data-testid="fact-action"
          >
            <option value="">動きの記載なし</option>
            {MEDICATION_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {MEDICATION_ACTION_NAMES[a]}
              </option>
            ))}
          </select>
        )}
        {row.fact === 'event' && (
          <select
            className="input compact"
            aria-label="できごとの種類"
            value={row.kind}
            disabled={busy || row.excluded}
            onChange={(e) => {
              onPatch({ kind: e.target.value as (typeof EVENT_KINDS)[number] });
            }}
            data-testid="fact-kind"
          >
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {EVENT_KIND_NAMES[k]}
              </option>
            ))}
          </select>
        )}
        <span className="fact-at">
          <input className="input compact" type="date" aria-label="日" value={day} disabled={busy || row.excluded} onChange={(e) => { setDay(e.target.value); }} data-testid="fact-day" />
          <input className="input compact" type="time" aria-label="時刻" value={time} disabled={busy || row.excluded || day === ''} onChange={(e) => { setTime(e.target.value); }} data-testid="fact-time" />
          <button
            type="button"
            className="button small"
            disabled={busy || row.excluded || (day === '' ? row.at === null : joinDateTime(day, time) === row.at)}
            onClick={() => {
              onPatch({ at: day === '' ? null : joinDateTime(day, time) });
            }}
            data-testid="fact-at"
          >
            日時を直す
          </button>
        </span>
      </span>
    </li>
  );
}
