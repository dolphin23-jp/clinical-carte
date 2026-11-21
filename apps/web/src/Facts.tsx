// 整理した事実の見方（docs/04 の 1 の層④。保存しない）：投薬の時間軸・問題の一覧・できごとの並び。
// 判定しない：書かれたとおりに並べるだけ（色・評価の語を付けない）。どの事実も、どの記載から来たかを出す。
import {
  EVENT_KIND_NAMES,
  eventTimeline,
  MEDICATION_ACTION_NAMES,
  medicationTimeline,
  PROBLEM_STATUS_NAMES,
  problemList,
  SOURCE_KIND_LABELS,
} from '@clinical-carte/core';

import { showDateTime } from './format.ts';
import type { ClinicalEvent, Medication, Problem, Source } from './net/api.ts';

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

export function ProblemView({ problems, sources }: { problems: readonly Problem[]; sources: readonly Source[] }) {
  const lines = problemList(problems);
  return (
    <div className="facts" data-testid="problems">
      <Pending sources={sources} />
      {lines.length === 0 ? (
        <p className="note">この受診の記載から、問題は見つかっていません。</p>
      ) : (
        <ul className="fact-list">
          {lines.map((p) => (
            <li key={p.name} className="fact-row" data-testid="problem-line">
              <span className="fact-main">
                <strong>{p.name}</strong>
                <span className="tag">{PROBLEM_STATUS_NAMES[p.latestStatus]}</span>
              </span>
              <span className="fact-from">
                記載 {String(p.mentions)} 件・{showDateTime(p.first)}
                {p.last !== p.first && `〜${showDateTime(p.last)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && <p className="note">確からしさは、いちばん新しい記載の書かれ方です（判定ではありません）。</p>}
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
