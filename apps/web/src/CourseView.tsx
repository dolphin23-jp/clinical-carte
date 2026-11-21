// 時系列（段J。CA-056）：経過の出来事（病歴・経過から AI が振り分けたもの）・できごと・投薬・バイタル・検査値を、日ごと・時刻の順に1本に並べる。
// 「この日に何があったか・何を飲んだか・何時にどの処置・何の検査・何時のバイタル」を、記載を開かずに読めるようにする。
// 判定しない（色・正常範囲なし）。AI の要約・AI が読んだ値には印。おおよその日時には「ごろ」の印。押すと、元の文の字と、どの記載からかが開く。
import { COURSE_CATEGORY_NAMES, EVENT_KIND_NAMES, hospitalDay, MEDICATION_ACTION_NAMES, SOURCE_KIND_LABELS } from '@clinical-carte/core';
import { useState } from 'react';

import { showDateTime } from './format.ts';
import type { ClinicalEvent, CourseItem, Encounter, Medication, Observation, Source } from './net/api.ts';

type Row = {
  readonly key: string;
  readonly at: string | null;
  readonly approx: string | null;
  readonly tag: string;
  readonly text: string;
  /** AI の要約・AI が読んだ値 */
  readonly ai: boolean;
  /** AI が読んだ数が、字に見つからない */
  readonly unseen: boolean;
  readonly sourceId: string;
  readonly start: number;
  readonly end: number;
};

const valueText = (o: Observation): string => `${o.nameRaw} ${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`;

/** 同じ時刻・同じ記載の値を、1行にまとめる（バイタル・検査を分けて） */
function valueRows(observations: readonly Observation[]): Row[] {
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const key = `${o.kind ?? 'other'}|${o.at ?? ''}|${o.sourceId}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups.values()].map((list) => {
    const first = list[0] as Observation;
    // 血圧の2つの値（同じ場所）は「BP 90/50」の1つに
    const shown: string[] = [];
    const used = new Set<Observation>();
    for (const o of list) {
      if (used.has(o)) continue;
      const pair = list.find((x) => x !== o && !used.has(x) && x.start === o.start && x.nameRaw === o.nameRaw && ((o.name === '収縮期血圧' && x.name === '拡張期血圧') || (o.name === '拡張期血圧' && x.name === '収縮期血圧')));
      used.add(o);
      if (pair !== undefined) {
        used.add(pair);
        const [sys, dia] = o.name === '収縮期血圧' ? [o, pair] : [pair, o];
        shown.push(`${sys.nameRaw} ${sys.valueText}/${dia.valueText}${sys.unit === null ? '' : ` ${sys.unit}`}${sys.unseen === true || dia.unseen === true ? '※' : ''}`);
      } else shown.push(`${valueText(o)}${o.unseen === true ? '※' : ''}`);
    }
    return {
      key: `v-${first.id}`,
      at: first.at,
      approx: first.atApprox ?? null,
      tag: first.kind === 'vital' ? 'バイタル' : first.kind === 'lab' ? '検査値' : '値',
      text: shown.join('・'),
      ai: list.some((o) => o.readBy === 'ai'),
      unseen: list.some((o) => o.unseen === true),
      sourceId: first.sourceId,
      start: Math.min(...list.map((o) => o.start)),
      end: Math.max(...list.map((o) => o.end)),
    };
  });
}

export function CourseView({
  course,
  events,
  medications,
  observations,
  sources,
  encounter,
  day,
}: {
  course: readonly CourseItem[];
  events: readonly ClinicalEvent[];
  medications: readonly Medication[];
  observations: readonly Observation[];
  sources: readonly Source[];
  encounter: Encounter;
  /** 日の帯で選んだ日（なければ全期間） */
  day: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const rows: Row[] = [
    ...course.map((c) => ({ key: `c-${c.id}`, at: c.at, approx: c.atApprox, tag: COURSE_CATEGORY_NAMES[c.category], text: c.summary, ai: true, unseen: false, sourceId: c.sourceId, start: c.start, end: c.end })),
    ...events.map((e) => ({ key: `e-${e.id}`, at: e.at, approx: e.atApprox ?? null, tag: EVENT_KIND_NAMES[e.kind], text: e.title, ai: false, unseen: false, sourceId: e.sourceId, start: e.start, end: e.end })),
    ...medications.map((m) => ({
      key: `m-${m.id}`,
      at: m.at,
      approx: m.atApprox ?? null,
      tag: m.action === null ? '投薬' : `投薬・${MEDICATION_ACTION_NAMES[m.action]}`,
      text: `${m.name}${m.doseText === null ? '' : ` ${m.doseText}`}`,
      ai: false,
      unseen: false,
      sourceId: m.sourceId,
      start: m.start,
      end: m.end,
    })),
    ...valueRows(observations),
  ].filter((r) => day === null || (r.at !== null && r.at.slice(0, 10) === day));
  // 時刻の順。同じ時刻は、病歴の出来事・できごと・投薬・値の順（書かれた並びに近く）
  const order = (r: Row): number => (r.key.startsWith('c-') ? 0 : r.key.startsWith('e-') ? 1 : r.key.startsWith('m-') ? 2 : 3);
  rows.sort((a, b) => {
    if (a.at === null || b.at === null) return a.at === b.at ? order(a) - order(b) : a.at === null ? 1 : -1;
    const da = a.at.slice(0, 10);
    const db = b.at.slice(0, 10);
    if (da !== db) return da < db ? -1 : 1;
    // 日だけの行は、その日の先頭
    const ta = a.at.length > 10 ? a.at.slice(11) : '';
    const tb = b.at.length > 10 ? b.at.slice(11) : '';
    return ta === tb ? order(a) - order(b) : ta < tb ? -1 : 1;
  });
  const start = encounter.start.slice(0, 10);
  const dayHead = (d: string): string => {
    if (d < start) {
      const n = Math.round((Date.parse(`${start}T00:00Z`) - Date.parse(`${d}T00:00Z`)) / 86_400_000);
      return `${d.slice(5).replace('-', '/')}（来院・入院の${String(n)}日前）`;
    }
    const hd = encounter.kind === 'inpatient' ? hospitalDay(encounter.start, d) : null;
    return `${d.slice(5).replace('-', '/')}${hd === null ? '' : `（${String(hd)}病日）`}`;
  };
  const quote = (r: Row): string => (sources.find((s) => s.id === r.sourceId)?.text ?? '').slice(r.start, r.end);
  const source = (r: Row): string => {
    const s = sources.find((x) => x.id === r.sourceId);
    return s === undefined ? '' : `${SOURCE_KIND_LABELS[s.kind]}・${showDateTime(s.at)}`;
  };

  if (rows.length === 0)
    return (
      <p className="note" data-testid="timeline-empty">
        {day === null ? 'まだ時系列にできる記録がありません（記録を入れて整理すると、ここに日ごとに並びます）。' : 'この日の記録はありません。'}
      </p>
    );
  return (
    <div className="timeline-list" data-testid="timeline-list">
      <p className="note">病歴・経過の文から振り分けた出来事（AI の要約）と、できごと・投薬・値を、時刻の順に並べています。押すと、元の文の字が開きます。</p>
      <ul className="tl">
        {rows.map((r, i) => {
          const d = r.at === null ? '日時不明' : r.at.slice(0, 10);
          const prev = rows[i - 1];
          const prevDay = prev === undefined ? null : prev.at === null ? '日時不明' : prev.at.slice(0, 10);
          const on = open === r.key;
          return (
            <li key={r.key} className="tl-item" data-testid="timeline-row">
              {d !== prevDay && (
                <div className="tl-day" data-testid="timeline-day">
                  {d === '日時不明' ? d : dayHead(d)}
                </div>
              )}
              <button
                type="button"
                className="tl-row"
                aria-expanded={on}
                onClick={() => {
                  setOpen(on ? null : r.key);
                }}
              >
                <span className="tl-time">{r.at !== null && r.at.length > 10 ? r.at.slice(11) : ''}</span>
                <span className="tl-main">
                  <span className="tag">{r.tag}</span>
                  {r.approx !== null && <span className="tag">{r.approx}</span>}
                  {r.text}
                  {r.ai && <span className="tag ai-tag">AI</span>}
                </span>
              </button>
              {on && (
                <div className="tl-quote" data-testid="timeline-quote">
                  <span className="part-label">元の文（{source(r)}）</span>
                  <p className="source-text">{quote(r)}</p>
                  {r.unseen && <p className="note">※ AI が読んだ数が、この字に見つかりませんでした。確かめてください。</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
