// 整理した事実の見方（docs/04 の 1 の層④。保存しない）：投薬の時間軸・できごとの並び（問題は ProblemThreads.tsx）。
// 判定しない：書かれたとおりに並べるだけ（色・評価の語を付けない）。どの事実も、どの記載から来たかを出す。
import {
  type EventFact,
  type MedicationFact,
  EVENT_KIND_NAMES,
  eventTimeline,
  foldedEventIds,
  foldedMedicationIds,
  MEDICATION_ACTION_NAMES,
  medicationTimeline,
  SOURCE_KIND_LABELS,
} from '@clinical-carte/core';

import { actionShape } from './charts/Timeline.tsx';
import { showDateTime } from './format.ts';
import { Icon } from './Icon.tsx';
import type { ClinicalEvent, Medication, Source } from './net/api.ts';

const notOrganized = (sources: readonly Source[]): number => sources.filter((s) => s.organized !== 'done').length;

function Pending({ sources }: { sources: readonly Source[] }) {
  const n = notOrganized(sources);
  if (n === 0) return null;
  return <p className="note">まだ整理していない記載が {String(n)} 件あります（「記録」の各記載の「整理する」で整理できます）。</p>;
}

const sourceLabel = (sources: readonly Source[], id: string): string => {
  const s = sources.find((x) => x.id === id);
  return s === undefined ? '' : `${SOURCE_KIND_LABELS[s.kind]}・${showDateTime(s.at)}`;
};

/** 同じ日の二重でたたんだ行の、短い説明 */
const FOLD_NOTE = '同じ日に時刻つきの同じ記載があるので、たたみました（方針の行など。消していません）';

export function MedicationView({ medications, sources }: { medications: readonly Medication[]; sources: readonly Source[] }) {
  const lines = medicationTimeline(medications);
  const folded = foldedMedicationIds(medications);
  return (
    <div className="facts" data-testid="medications">
      <Pending sources={sources} />
      {lines.length === 0 ? (
        <p className="note">この受診の記載から、投薬は見つかっていません。</p>
      ) : (
        lines.map((line) => (
          <section key={line.name} className="fact-group" data-testid="medication-line">
            <h3 className="fact-title with-icon">
              <span className="cat-mark cat-med" aria-hidden="true">
                <Icon name="med" />
              </span>
              {line.name}
            </h3>
            <ul className="fact-list">
              {line.entries
                .filter((m) => !folded.has(m.id))
                .map((m) => (
                  <MedicationRow key={m.id} m={m} sources={sources} />
                ))}
            </ul>
            {line.entries.some((m) => folded.has(m.id)) && (
              <details className="fact-folded" data-testid="medication-folded">
                <summary>
                  {FOLD_NOTE}（{String(line.entries.filter((m) => folded.has(m.id)).length)}）
                </summary>
                <ul className="fact-list">
                  {line.entries
                    .filter((m) => folded.has(m.id))
                    .map((m) => (
                      <MedicationRow key={m.id} m={m} sources={sources} />
                    ))}
                </ul>
              </details>
            )}
          </section>
        ))
      )}
    </div>
  );
}

function MedicationRow({ m, sources }: { m: MedicationFact; sources: readonly Source[] }) {
  return (
    <li className="fact-row">
      <span className="fact-when">{showDateTime(m.at)}</span>
      <span className="fact-main">
        {/* 動きの印：経過表と同じ形（色ではなく、形で分ける） */}
        <svg className="action-mark" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d={actionShape(m.action, 7, 7)} className={m.action === null ? 'mark-med hollow' : 'mark-med'} />
        </svg>
        {m.action === null ? '（動きの記載なし）' : MEDICATION_ACTION_NAMES[m.action]}
        {m.doseText !== null && <span className="fact-dose">{m.doseText}</span>}
      </span>
      <span className="fact-from">{sourceLabel(sources, m.sourceId)}</span>
    </li>
  );
}

function EventRow({ e, sources }: { e: EventFact; sources: readonly Source[] }) {
  return (
    <li className="fact-row" data-testid="event-line">
      <span className="fact-when">{showDateTime(e.at)}</span>
      <span className="fact-main">
        <span className="tag">{EVENT_KIND_NAMES[e.kind]}</span>
        {e.title}
      </span>
      <span className="fact-from">{sourceLabel(sources, e.sourceId)}</span>
    </li>
  );
}

export function EventView({ events, sources }: { events: readonly ClinicalEvent[]; sources: readonly Source[] }) {
  const all = eventTimeline(events);
  const folded = foldedEventIds(events);
  const list = all.filter((e) => !folded.has(e.id));
  return (
    <div className="facts" data-testid="events">
      <Pending sources={sources} />
      {list.length === 0 ? (
        <p className="note">この受診の記載から、できごとは見つかっていません。</p>
      ) : (
        <ul className="fact-list">
          {list.map((e) => (
            <EventRow key={e.id} e={e} sources={sources} />
          ))}
        </ul>
      )}
      {folded.size > 0 && (
        <details className="fact-folded" data-testid="event-folded">
          <summary>
            {FOLD_NOTE}（{String(folded.size)}）
          </summary>
          <ul className="fact-list">
            {all
              .filter((e) => folded.has(e.id))
              .map((e) => (
                <EventRow key={e.id} e={e} sources={sources} />
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}
