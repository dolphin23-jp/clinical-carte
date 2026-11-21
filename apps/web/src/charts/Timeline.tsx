// 経過表（温度板）：体温・心拍数・血圧・呼吸数・SpO2 を、同じ時間の軸に縦に並べ、その下に投薬とできごとを置く。
// 1つのグラフに目盛りは1つだけ（2つの目盛りを重ねない）。正常範囲の帯・色分けは描かない（判定しない）。
// タップ（ポインタ）で、その時刻の値を、グラフの下にまとめて出す。値は、表（検査・バイタルのタブ）でも読める。
import {
  type ChartPoint,
  chartTime,
  dayTicks,
  EVENT_KIND_NAMES,
  MEDICATION_ACTION_NAMES,
  type MedicationAction,
  type MedicationLine,
  medicationSpans,
  niceTicks,
  timeDomain,
  latestPoint,
  untimedSameDay,
  type VitalPanel,
} from '@clinical-carte/core';
import { type PointerEvent, useRef, useState } from 'react';

import type { ClinicalEvent } from '../net/api.ts';
import { shortWhen, tickText } from './format.ts';
import { useWidth } from './useWidth.ts';

const GUTTER = 44;
const RIGHT = 14;
const AXIS_H = 34;
const TITLE_H = 28;
const PLOT_H = 64;
const PANEL_GAP = 12;
const SECTION_H = 22;
const LANE_LABEL_H = 16;
const LANE_H = 20;

interface Props {
  readonly panels: readonly VitalPanel[];
  readonly medications: readonly MedicationLine[];
  readonly events: readonly ClinicalEvent[];
  readonly encounterStart: string;
  readonly encounterEnd: string | null;
  readonly inpatient: boolean;
}

/** 投薬の動きの印の形（色ではなく、形で区別する） */
export function actionShape(action: MedicationAction | null, x: number, y: number): string {
  const r = 5;
  switch (action) {
    case 'start':
      return `M${String(x - r)},${String(y - r)} L${String(x + r)},${String(y)} L${String(x - r)},${String(y + r)} Z`;
    case 'stop':
      return `M${String(x - r)},${String(y - r)} h${String(2 * r)} v${String(2 * r)} h${String(-2 * r)} Z`;
    case 'change':
      return `M${String(x)},${String(y - r - 1)} L${String(x + r + 1)},${String(y)} L${String(x)},${String(y + r + 1)} L${String(x - r - 1)},${String(y)} Z`;
    default:
      return `M${String(x - r)},${String(y)} a${String(r)},${String(r)} 0 1,0 ${String(2 * r)},0 a${String(r)},${String(r)} 0 1,0 ${String(-2 * r)},0`;
  }
}

export function ActionKey() {
  const items: (MedicationAction | null)[] = ['start', 'change', 'stop', 'continue', null];
  return (
    <div className="chart-key" aria-label="投薬の印">
      {items.map((a) => (
        <span key={a ?? 'none'} className="chart-key-item">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d={actionShape(a, 7, 7)} className={a === null ? 'mark-med hollow' : 'mark-med'} />
          </svg>
          {a === null ? '動きの記載なし' : MEDICATION_ACTION_NAMES[a]}
        </span>
      ))}
    </div>
  );
}

interface HoverRow {
  readonly label: string;
  readonly value: string;
  readonly cls?: string;
}

export function Timeline({ panels, medications, events, encounterStart, encounterEnd, inpatient }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [hover, setHover] = useState<number | null>(null);

  const shown = panels.filter((p) => p.points.length > 0);
  const empty = panels.filter((p) => p.points.length === 0);
  const meds = medications.map((m) => ({ ...m, marks: m.entries.map((e) => ({ e, time: chartTime(e.at) })) }));
  const evs = events.map((e) => ({ e, time: chartTime(e.at) }));

  const timeSet = new Set<number>();
  for (const p of shown) for (const pt of p.points) timeSet.add(pt.t);
  for (const m of meds) for (const { time } of m.marks) if (time !== null) timeSet.add(time.t);
  for (const { time } of evs) if (time !== null) timeSet.add(time.t);
  const times = [...timeSet].sort((a, b) => a - b);

  const domain = timeDomain(times, encounterStart, encounterEnd);
  if (domain === null || times.length === 0) {
    return <p className="note">この受診には、まだグラフにできる記録がありません。バイタル・検査値・投薬が入ると、ここに時間の順に並びます。</p>;
  }
  const plotW = Math.max(120, width - GUTTER - RIGHT);
  const x = (t: number): number => GUTTER + ((t - domain[0]) / (domain[1] - domain[0])) * plotW;
  const ticks = dayTicks(domain, Math.max(2, Math.floor(plotW / 46)), inpatient ? encounterStart : null);

  // 段の位置
  let y = AXIS_H;
  const layout = shown.map((p) => {
    const top = y + TITLE_H;
    y = top + PLOT_H + PANEL_GAP;
    const values = p.points.flatMap((pt) => (pt.low === undefined ? [pt.value] : [pt.value, pt.low]));
    const scale = niceTicks(Math.min(...values), Math.max(...values), 2);
    const yOf = (v: number): number => top + PLOT_H - ((v - scale.min) / (scale.max - scale.min)) * PLOT_H;
    return { p, top, scale, yOf };
  });
  const medTop = y;
  if (meds.length > 0) y += SECTION_H + meds.length * (LANE_LABEL_H + LANE_H);
  const eventTop = y;
  if (evs.length > 0) y += SECTION_H + LANE_H;
  const height = y + 6;

  const hoverX = hover === null ? null : x(hover);
  const rows: HoverRow[] = [];
  let hoverLabel = '';
  if (hover !== null) {
    for (const { p } of layout) {
      const pt = p.points.find((q) => q.t === hover);
      if (pt !== undefined) {
        hoverLabel ||= shortWhen(pt.at, pt);
        rows.push({ label: p.name, value: `${pt.text} ${p.unit}`, cls: `swatch-${p.id}` });
      }
    }
    for (const m of meds) {
      for (const { e, time } of m.marks) {
        if (time?.t !== hover || e.at === null) continue;
        hoverLabel ||= shortWhen(e.at, time);
        rows.push({ label: m.name, value: `${e.action === null ? '投薬' : MEDICATION_ACTION_NAMES[e.action]}${e.doseText === null ? '' : ` ${e.doseText}`}` });
      }
    }
    for (const { e, time } of evs) {
      if (time?.t !== hover || e.at === null) continue;
      hoverLabel ||= shortWhen(e.at, time);
      rows.push({ label: EVENT_KIND_NAMES[e.kind], value: e.title });
    }
  }

  const pick = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left + GUTTER;
    let best: number | null = null;
    for (const t of times) if (best === null || Math.abs(x(t) - px) < Math.abs(x(best) - px)) best = t;
    setHover(best);
  };

  const dot = (pt: ChartPoint, cx: number, cy: number, cls: string) =>
    pt.dateOnly ? <circle key={`${String(pt.t)}-${String(cy)}`} cx={cx} cy={cy} r={4} className={`dot hollow ${cls}`} /> : <circle key={`${String(pt.t)}-${String(cy)}`} cx={cx} cy={cy} r={4} className={`dot ${cls}`} />;

  return (
    <div className="timeline" ref={box} data-testid="timeline">
      <svg width={width} height={height} role="img" aria-label={`経過表：${shown.map((p) => p.name).join('・')}${meds.length > 0 ? '・投薬' : ''}${evs.length > 0 ? '・できごと' : ''}`}>
        {/* 日の目盛り（縦の細線）と、日付・病日 */}
        {ticks.map((tk) => (
          <g key={tk.t}>
            <line x1={x(tk.t)} x2={x(tk.t)} y1={AXIS_H - 4} y2={height - 6} className="gridline" />
            <text x={x(tk.t) + 3} y={13} className="axis-text">
              {tk.label}
            </text>
            {tk.hospitalDay !== null && (
              <text x={x(tk.t) + 3} y={26} className="axis-text muted">
                {`${String(tk.hospitalDay)}病日`}
              </text>
            )}
          </g>
        ))}

        {layout.map(({ p, top, scale, yOf }) => {
          const latest = latestPoint(p.points);
          const cls = `series-${p.id}`;
          const path = p.points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${String(x(pt.t))},${String(yOf(pt.value))}`).join(' ');
          return (
            <g key={p.key} data-testid={`panel-${p.key}`}>
              <text x={0} y={top - 11} className="panel-title">
                {p.name}
                <tspan className="panel-unit">{` ${p.unit}`}</tspan>
                {latest !== null && <tspan className="panel-latest">{`\u3000最新 ${latest.text}（${shortWhen(latest.at, latest)}${untimedSameDay(p.points, latest) ? '・同じ日に時刻のない値あり' : ''}）`}</tspan>}
              </text>
              {scale.ticks.map((v) => (
                <g key={v}>
                  <line x1={GUTTER} x2={GUTTER + plotW} y1={yOf(v)} y2={yOf(v)} className="gridline" />
                  <text x={GUTTER - 6} y={yOf(v) + 4} className="axis-text" textAnchor="end">
                    {tickText(v)}
                  </text>
                </g>
              ))}
              {p.id === 'bp' ? (
                p.points.map((pt) =>
                  pt.low === undefined ? (
                    dot(pt, x(pt.t), yOf(pt.value), cls)
                  ) : (
                    <g key={pt.t} className={cls}>
                      <line x1={x(pt.t)} x2={x(pt.t)} y1={yOf(pt.value)} y2={yOf(pt.low)} className="range" />
                      <line x1={x(pt.t) - 4} x2={x(pt.t) + 4} y1={yOf(pt.value)} y2={yOf(pt.value)} className="range" />
                      <line x1={x(pt.t) - 4} x2={x(pt.t) + 4} y1={yOf(pt.low)} y2={yOf(pt.low)} className="range" />
                    </g>
                  ),
                )
              ) : (
                <>
                  {p.points.length > 1 && <path d={path} className={`line ${cls}`} />}
                  {p.points.map((pt) => dot(pt, x(pt.t), yOf(pt.value), cls))}
                </>
              )}
            </g>
          );
        })}

        {meds.length > 0 && (
          <g data-testid="timeline-medications">
            <text x={0} y={medTop + 14} className="section-title">
              投薬
            </text>
            {meds.map((m, i) => {
              const laneTop = medTop + SECTION_H + i * (LANE_LABEL_H + LANE_H);
              const cy = laneTop + LANE_LABEL_H + LANE_H / 2;
              const undated = m.marks.filter(({ time }) => time === null).length;
              return (
                <g key={m.name}>
                  <text x={0} y={laneTop + 12} className="lane-title">
                    {m.name}
                    {undated > 0 && <tspan className="panel-unit">{`\u3000日時不明 ${String(undated)}`}</tspan>}
                  </text>
                  <line x1={GUTTER} x2={GUTTER + plotW} y1={cy} y2={cy} className="lane" />
                  {medicationSpans(m.entries).map((sp) => (
                    <line key={sp.from} x1={x(sp.from)} x2={x(sp.to)} y1={cy} y2={cy} className="med-span" />
                  ))}
                  {m.marks.map(({ e, time }) => (time === null ? null : <path key={e.id} d={actionShape(e.action, x(time.t), cy)} className={e.action === null ? 'mark-med hollow' : 'mark-med'} />))}
                </g>
              );
            })}
          </g>
        )}

        {evs.length > 0 && (
          <g data-testid="timeline-events">
            <text x={0} y={eventTop + 14} className="section-title">
              できごと
            </text>
            <line x1={GUTTER} x2={GUTTER + plotW} y1={eventTop + SECTION_H + LANE_H / 2} y2={eventTop + SECTION_H + LANE_H / 2} className="lane" />
            {evs.map(({ e, time }) =>
              time === null ? null : (
                <path key={e.id} d={actionShape('change', x(time.t), eventTop + SECTION_H + LANE_H / 2)} className="mark-event" />
              ),
            )}
          </g>
        )}

        {hoverX !== null && <line x1={hoverX} x2={hoverX} y1={AXIS_H - 4} y2={height - 6} className="crosshair" />}
        <rect
          x={GUTTER}
          y={0}
          width={plotW}
          height={height}
          className="hit"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') setHover(null);
          }}
          data-testid="timeline-hit"
        />
      </svg>
      {/* その時刻の値（グラフの下に出す：指で隠れないように。位置を style で動かさない：CSP） */}
      <div className="readout" data-testid="timeline-readout" aria-live="polite">
        {hover === null || rows.length === 0 ? (
          <span className="note">グラフをタップすると、その時刻の値が、ここに出ます。</span>
        ) : (
          <>
            <div className="readout-when">{hoverLabel}</div>
            {rows.map((r, i) => (
              <div key={i} className="readout-row">
                <span className={`readout-key ${r.cls ?? 'swatch-none'}`} aria-hidden="true" />
                <strong className="readout-value">{r.value}</strong>
                <span className="readout-label">{r.label}</span>
              </div>
            ))}
          </>
        )}
      </div>
      {meds.length > 0 && (
        <>
          <ActionKey />
          <p className="note">投薬の帯は、記録と記録のあいだ（中止の記録まで）。最後の記録より先は、続いているか書かれていないので、描いていません。</p>
        </>
      )}
      {empty.length > 0 && <p className="note">記録のない項目：{empty.map((p) => p.name).join('・')}</p>}
      <p className="note">中の白い点は、日だけ分かる値（その日の真ん中に置いています）。正常範囲や色分けは付けていません。</p>
    </div>
  );
}
