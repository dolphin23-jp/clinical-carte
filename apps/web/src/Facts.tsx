// 整理した事実の見方（docs/04 の 1 の層④。保存しない）：投薬の時間軸・できごとの並び（問題は ProblemThreads.tsx）。
// 判定しない：書かれたとおりに並べるだけ（色・評価の語を付けない）。どの事実も、どの記載から来たかを出す。
import {
  EVENT_KIND_NAMES,
  eventTimeline,
  MEDICATION_ACTION_NAMES,
  medicationTimeline,
  SOURCE_KIND_LABELS,
} from '@clinical-carte/core';

import { showDateTime } from './format.ts';
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

export function MedicationView({ medications, sources }: { medications: readonly Medication[]; sources: readonly Source[] }) {
  const lines = medicationTimeline(medications);
  return (
    <div className="facts" data-testid="medications">
      <Pending sources={sources} />
      {lines.length === 0 ? (
        <p className="note">この受診の記載から、投薬は見つかっていません。</p>
      ) : (
        lines.map((line) => (
          <section key={line.name} className="fact-group" data-testid="medication-line">
            <h3 className="fact-title">{line.name}</h3>
            <ul className="fact-list">
              {line.entries.map((m) => (
                <li key={m.id} className="fact-row">
                  <span className="fact-when">{showDateTime(m.at)}</span>
                  <span className="fact-main">
                    {m.action === null ? '（動きの記載なし）' : MEDICATION_ACTION_NAMES[m.action]}
                    {m.doseText !== null && <span className="fact-dose">{m.doseText}</span>}
                  </span>
                  <span className="fact-from">{sourceLabel(sources, m.sourceId)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

export function EventView({ events, sources }: { events: readonly ClinicalEvent[]; sources: readonly Source[] }) {
  const list = eventTimeline(events);
  return (
    <div className="facts" data-testid="events">
      <Pending sources={sources} />
      {list.length === 0 ? (
        <p className="note">この受診の記載から、できごとは見つかっていません。</p>
      ) : (
        <ul className="fact-list">
          {list.map((e) => (
            <li key={e.id} className="fact-row" data-testid="event-line">
              <span className="fact-when">{showDateTime(e.at)}</span>
              <span className="fact-main">
                <span className="tag">{EVENT_KIND_NAMES[e.kind]}</span>
                {e.title}
              </span>
              <span className="fact-from">{sourceLabel(sources, e.sourceId)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
