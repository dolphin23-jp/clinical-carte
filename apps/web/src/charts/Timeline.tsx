// 経過表（温度板）：体温・心拍数・血圧・呼吸数・SpO2 を、同じ時間の軸に縦に並べ、その下に投薬とできごとを置く。
// 1つのグラフに目盛りは1つだけ（2つの目盛りを重ねない）。正常範囲の帯・色分けは描かない（判定しない）。
// タップ（ポインタ）で、その時刻の値を、グラフの下にまとめて出す。値は、表（検査・バイタルのタブ）でも読める。
// 表示の窓（段H。CA-053）：既定は最後の記録までの3日。範囲のボタン（24時間・3日・7日・全期間）、ドラッグ・指で横に動かす、
// 2本指・ctrl＋ホイールで拡大縮小、全期間の縮小図で範囲を選ぶ。縦の目盛りは、見えている範囲の値で決める。範囲は画面のメモリだけ（保存しない）。
import {
  axisTicks,
  type ChartPoint,
  chartTime,
  clampWindow,
  DEFAULT_RANGE,
  inWindow,
  panWindow,
  presetWindow,
  RANGE_PRESET_NAMES,
  RANGE_PRESETS,
  type RangePreset,
  type Window,
  zoomWindow,
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
import { type PointerEvent, useEffect, useId, useRef, useState } from 'react';

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

/** 表示の範囲：決まった範囲（最後の記録を右端の近くに）か、動かした窓 */
export type TimelineRange = { readonly preset: RangePreset } | { readonly window: Window };
export const DEFAULT_TIMELINE_RANGE: TimelineRange = { preset: DEFAULT_RANGE };

interface Props {
  readonly panels: readonly VitalPanel[];
  readonly medications: readonly MedicationLine[];
  readonly events: readonly ClinicalEvent[];
  readonly encounterStart: string;
  readonly encounterEnd: string | null;
  readonly inpatient: boolean;
  /** 表示の範囲（親が持つ：日の帯で選んだ日と、ほかの見方と分け合う） */
  readonly range?: TimelineRange;
  readonly onRange?: (range: TimelineRange) => void;
}

/** 1日（ミリ秒） */
const DAY_MS = 86_400_000;
/** 縮小図の高さ */
const MINI_H = 26;
/** ドラッグとみなす動きの幅（px）。これより小さい動きは、タップ */
const DRAG_PX = 6;

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

export function Timeline({ panels, medications, events, encounterStart, encounterEnd, inpatient, range: rangeProp, onRange }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const width = useWidth(box);
  const [hover, setHover] = useState<number | null>(null);
  // 親が範囲を持たないとき（ほかの画面から使うとき）は、ここで持つ
  const [ownRange, setOwnRange] = useState<TimelineRange>(DEFAULT_TIMELINE_RANGE);
  const range = rangeProp ?? ownRange;
  const setRange = (r: TimelineRange): void => {
    if (onRange === undefined) setOwnRange(r);
    else onRange(r);
  };
  const clipId = `clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  // ドラッグと2本指の操作（画面のメモリだけ）
  const pointers = useRef(new Map<number, number>());
  const gesture = useRef<{ startX: number; startWindow: Window; moved: boolean; pinch: { dist: number; center: number } | null } | null>(null);
  // ctrl＋ホイール（トラックパッドの2本指の拡大縮小を含む）で拡大縮小、横のホイールで動かす。ページの縦のスクロールは奪わない
  const wheelRef = useRef<(event: WheelEvent) => void>(() => undefined);
  useEffect(() => {
    const el = svgRef.current;
    if (el === null) return;
    const listener = (event: WheelEvent): void => {
      wheelRef.current(event);
    };
    el.addEventListener('wheel', listener, { passive: false });
    return () => {
      el.removeEventListener('wheel', listener);
    };
  });

  const shown = panels.filter((p) => p.points.length > 0);
  const empty = panels.filter((p) => p.points.length === 0);
  const meds = medications.map((m) => ({ ...m, marks: m.entries.map((e) => ({ e, time: chartTime(e.at) })) }));
  const evs = events.map((e) => ({ e, time: chartTime(e.at) }));

  const timeSet = new Set<number>();
  for (const p of shown) for (const pt of p.points) timeSet.add(pt.t);
  for (const m of meds) for (const { time } of m.marks) if (time !== null) timeSet.add(time.t);
  for (const { time } of evs) if (time !== null) timeSet.add(time.t);
  const times = [...timeSet].sort((a, b) => a - b);

  const raw = timeDomain(times, encounterStart, encounterEnd);
  // 全体の範囲は、日の始まりから日の終わりまで（日の帯で選んだ日の0〜24時が、押し戻されないように）
  const full: Window | null = raw === null ? null : [Math.floor(raw[0] / DAY_MS) * DAY_MS, Math.ceil(raw[1] / DAY_MS) * DAY_MS];
  if (full === null || times.length === 0) {
    return <p className="note">この受診には、まだグラフにできる記録がありません。バイタル・検査値・投薬が入ると、ここに時間の順に並びます。</p>;
  }
  const anchor = times.at(-1) ?? full[1];
  const domain: Window = 'preset' in range ? presetWindow(range.preset, full, anchor) : clampWindow(range.window, full);
  const span = domain[1] - domain[0];
  const plotW = Math.max(120, width - GUTTER - RIGHT);
  const x = (t: number): number => GUTTER + ((t - domain[0]) / span) * plotW;
  const timeAt = (px: number): number => domain[0] + ((px - GUTTER) / plotW) * span;
  const ticks = axisTicks(domain, Math.max(2, Math.floor(plotW / 46)), inpatient ? encounterStart : null);
  const visibleTimes = times.filter((t) => inWindow(domain, t));
  /** 線を窓の端までつなぐため、窓の外のいちばん近い点を1つずつ含める */
  const nearWindow = <T extends { t: number }>(pts: readonly T[]): T[] => {
    const before = [...pts].reverse().find((p) => p.t < domain[0]);
    const after = pts.find((p) => p.t > domain[1]);
    return [...(before === undefined ? [] : [before]), ...pts.filter((p) => inWindow(domain, p.t)), ...(after === undefined ? [] : [after])];
  };
  const go = (w: Window): void => {
    setRange({ window: w });
  };
  wheelRef.current = (event: WheelEvent): void => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    if (event.ctrlKey) {
      event.preventDefault();
      go(zoomWindow(domain, full, Math.exp(event.deltaY * 0.01), timeAt(event.clientX - rect.left)));
    } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.preventDefault();
      go(panWindow(domain, full, (event.deltaX / plotW) * span));
    }
  };

  // 範囲に値のない段・範囲に動きのない薬は、段にせず、名前だけを1行に出す（段H。1日を見るときに、空の段で縦に長くならないように）
  const inRange = shown.filter((p) => p.points.some((pt) => inWindow(domain, pt.t)));
  const outRange = shown.filter((p) => !inRange.includes(p));
  const medsIn = meds.filter((m) => m.marks.some(({ time }) => time !== null && inWindow(domain, time.t)) || medicationSpans(m.entries).some((sp) => sp.to >= domain[0] && sp.from <= domain[1]));
  const medsOut = meds.filter((m) => !medsIn.includes(m));
  const evsIn = evs.filter(({ time }) => time !== null && inWindow(domain, time.t));
  // 段の位置
  let y = AXIS_H;
  const layout = inRange.map((p) => {
    const top = y + TITLE_H;
    y = top + PLOT_H + PANEL_GAP;
    // 縦の目盛りは、見えている範囲の値で決める（範囲の外の値で、今日の動きが潰れないように）。範囲に値がなければ、全体の値で
    const inside = p.points.filter((pt) => inWindow(domain, pt.t));
    const basis = inside.length > 0 ? inside : p.points;
    const values = basis.flatMap((pt) => (pt.low === undefined ? [pt.value] : [pt.value, pt.low]));
    const scale = niceTicks(Math.min(...values), Math.max(...values), 2);
    const yOf = (v: number): number => top + PLOT_H - ((v - scale.min) / (scale.max - scale.min)) * PLOT_H;
    return { p, top, scale, yOf, points: nearWindow(p.points), none: inside.length === 0 };
  });
  const medTop = y;
  if (medsIn.length > 0) y += SECTION_H + medsIn.length * (LANE_LABEL_H + LANE_H);
  const eventTop = y;
  if (evsIn.length > 0) y += SECTION_H + LANE_H;
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

  const pickAt = (clientX: number, rect: DOMRect): void => {
    const px = clientX - rect.left + GUTTER;
    let best: number | null = null;
    for (const t of visibleTimes) if (best === null || Math.abs(x(t) - px) < Math.abs(x(best) - px)) best = t;
    setHover(best);
  };
  const pick = (event: PointerEvent<SVGRectElement>) => {
    pickAt(event.clientX, event.currentTarget.getBoundingClientRect());
  };
  // タップ・ドラッグ・2本指：動きが小さければタップ（その時刻の値）、横に動けば窓を動かす、2本指は拡大縮小
  const onDown = (event: PointerEvent<SVGRectElement>) => {
    pointers.current.set(event.pointerId, event.clientX);
    event.currentTarget.setPointerCapture(event.pointerId);
    const xs = [...pointers.current.values()];
    const rect = event.currentTarget.getBoundingClientRect();
    if (xs.length === 2) {
      const [a, b] = xs as [number, number];
      gesture.current = { startX: (a + b) / 2, startWindow: domain, moved: true, pinch: { dist: Math.max(10, Math.abs(a - b)), center: timeAt((a + b) / 2 - rect.left + GUTTER) } };
    } else {
      gesture.current = { startX: event.clientX, startWindow: domain, moved: false, pinch: null };
      pick(event);
    }
  };
  const onMove = (event: PointerEvent<SVGRectElement>) => {
    const g = gesture.current;
    if (g === null || !pointers.current.has(event.pointerId)) {
      if (event.pointerType === 'mouse') pick(event);
      return;
    }
    pointers.current.set(event.pointerId, event.clientX);
    const xs = [...pointers.current.values()];
    if (g.pinch !== null && xs.length === 2) {
      const [a, b] = xs as [number, number];
      const factor = g.pinch.dist / Math.max(10, Math.abs(a - b));
      go(zoomWindow(g.startWindow, full, factor, g.pinch.center));
      return;
    }
    const dx = event.clientX - g.startX;
    if (!g.moved && Math.abs(dx) < DRAG_PX) {
      pick(event);
      return;
    }
    g.moved = true;
    const startSpan = g.startWindow[1] - g.startWindow[0];
    go(panWindow(g.startWindow, full, (-dx / plotW) * startSpan));
  };
  const onUp = (event: PointerEvent<SVGRectElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
  };
  const presetOn = (p: RangePreset): boolean => 'preset' in range && range.preset === p;
  const step = (dir: -1 | 1) => {
    go(panWindow(domain, full, (dir * span) / 2));
  };
  const zoom = (factor: number) => {
    go(zoomWindow(domain, full, factor, (domain[0] + domain[1]) / 2));
  };
  // 縮小図：全体の範囲に、いまの窓を枠で出す。押した・動かした場所を、窓の真ん中にする（幅はそのまま）
  const miniX = (t: number): number => GUTTER + ((t - full[0]) / (full[1] - full[0])) * plotW;
  const miniPick = (event: PointerEvent<SVGRectElement>) => {
    if (event.type === 'pointermove' && event.buttons === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const t = full[0] + ((event.clientX - rect.left) / rect.width) * (full[1] - full[0]);
    go(clampWindow([t - span / 2, t + span / 2], full));
  };

  const dot = (pt: ChartPoint, cx: number, cy: number, cls: string) =>
    pt.dateOnly ? <circle key={`${String(pt.t)}-${String(cy)}`} cx={cx} cy={cy} r={4} className={`dot hollow ${cls}`} /> : <circle key={`${String(pt.t)}-${String(cy)}`} cx={cx} cy={cy} r={4} className={`dot ${cls}`} />;

  return (
    <div className="timeline" ref={box} data-testid="timeline">
      <div className="range-bar" role="group" aria-label="表示の範囲">
        {RANGE_PRESETS.map((p) => (
          <button key={p} type="button" className={presetOn(p) ? 'chip small on' : 'chip small'} aria-pressed={presetOn(p)} onClick={() => { setRange({ preset: p }); }} data-testid={`range-${p}`}>
            {RANGE_PRESET_NAMES[p]}
          </button>
        ))}
        <span className="range-steps">
          <button type="button" className="chip small" aria-label="前へ" onClick={() => { step(-1); }} data-testid="range-prev">
            ◀
          </button>
          <button type="button" className="chip small" aria-label="縮小（広く）" onClick={() => { zoom(2); }} data-testid="range-out">
            －
          </button>
          <button type="button" className="chip small" aria-label="拡大（狭く）" onClick={() => { zoom(0.5); }} data-testid="range-in">
            ＋
          </button>
          <button type="button" className="chip small" aria-label="次へ" onClick={() => { step(1); }} data-testid="range-next">
            ▶
          </button>
        </span>
      </div>
      <p className="range-label" data-testid="range-label">
        {rangeText(domain)}
      </p>
      <svg ref={svgRef} width={width} height={height} role="img" aria-label={`経過表：${inRange.map((p) => p.name).join('・')}${medsIn.length > 0 ? '・投薬' : ''}${evsIn.length > 0 ? '・できごと' : ''}`}>
        {/* 日の目盛り（縦の細線）と、日付・病日 */}
        {ticks.map((tk) => (
          <g key={tk.t}>
            <line x1={x(tk.t)} x2={x(tk.t)} y1={AXIS_H - 4} y2={height - 6} className={tk.kind === 'day' ? 'gridline' : 'gridline faint'} />
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

        <defs>
          <clipPath id={clipId}>
            <rect x={GUTTER - 6} y={0} width={plotW + 12} height={height} />
          </clipPath>
        </defs>
        {layout.map(({ p, top, scale, yOf, points, none }) => {
          const latest = latestPoint(p.points);
          const cls = `series-${p.id}`;
          const path = points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${String(x(pt.t))},${String(yOf(pt.value))}`).join(' ');
          return (
            <g key={p.key} data-testid={`panel-${p.key}`}>
              <text x={0} y={top - 11} className="panel-title">
                {p.name}
                <tspan className="panel-unit">{` ${p.unit}`}</tspan>
                {latest !== null && <tspan className="panel-latest">{`\u3000最新 ${latest.text}（${shortWhen(latest.at, latest)}${untimedSameDay(p.points, latest) ? '・同じ日に時刻のない値あり' : ''}）`}</tspan>}
                {none && <tspan className="panel-unit">{'\u3000この範囲に記録なし'}</tspan>}
              </text>
              {scale.ticks.map((v) => (
                <g key={v}>
                  <line x1={GUTTER} x2={GUTTER + plotW} y1={yOf(v)} y2={yOf(v)} className="gridline" />
                  <text x={GUTTER - 6} y={yOf(v) + 4} className="axis-text" textAnchor="end">
                    {tickText(v)}
                  </text>
                </g>
              ))}
              <g clipPath={`url(#${clipId})`}>
              {p.id === 'bp' ? (
                points.map((pt) =>
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
                  {points.length > 1 && <path d={path} className={`line ${cls}`} />}
                  {points.map((pt) => dot(pt, x(pt.t), yOf(pt.value), cls))}
                </>
              )}
              </g>
            </g>
          );
        })}

        {medsIn.length > 0 && (
          <g data-testid="timeline-medications">
            <text x={0} y={medTop + 14} className="section-title">
              投薬
            </text>
            {medsIn.map((m, i) => {
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
                  <g clipPath={`url(#${clipId})`}>
                    {medicationSpans(m.entries).map((sp) => (
                      <line key={sp.from} x1={x(sp.from)} x2={x(sp.to)} y1={cy} y2={cy} className="med-span" />
                    ))}
                    {m.marks.map(({ e, time }) => (time === null || !inWindow(domain, time.t) ? null : <path key={e.id} d={actionShape(e.action, x(time.t), cy)} className={e.action === null ? 'mark-med hollow' : 'mark-med'} />))}
                  </g>
                </g>
              );
            })}
          </g>
        )}

        {evsIn.length > 0 && (
          <g data-testid="timeline-events">
            <text x={0} y={eventTop + 14} className="section-title">
              できごと
            </text>
            <line x1={GUTTER} x2={GUTTER + plotW} y1={eventTop + SECTION_H + LANE_H / 2} y2={eventTop + SECTION_H + LANE_H / 2} className="lane" />
            {evsIn.map(({ e, time }) =>
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
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse' && gesture.current === null) setHover(null);
          }}
          data-testid="timeline-hit"
        />
      </svg>
      {/* 全期間の縮小図：いま見ている範囲を枠で出す。押す・なぞると、その場所へ動く */}
      <svg width={width} height={MINI_H} className="minimap" role="img" aria-label="全期間の中の、いま見ている範囲" data-testid="minimap">
        <line x1={GUTTER} x2={GUTTER + plotW} y1={MINI_H / 2} y2={MINI_H / 2} className="lane" />
        {times.map((t) => (
          <line key={t} x1={miniX(t)} x2={miniX(t)} y1={MINI_H / 2 - 4} y2={MINI_H / 2 + 4} className="mini-tick" />
        ))}
        <rect x={miniX(domain[0])} y={2} width={Math.max(4, miniX(domain[1]) - miniX(domain[0]))} height={MINI_H - 4} className="mini-window" />
        <rect x={GUTTER} y={0} width={plotW} height={MINI_H} className="hit" onPointerDown={miniPick} onPointerMove={miniPick} data-testid="minimap-hit" />
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
      {(outRange.length > 0 || medsOut.length > 0 || (evs.length > 0 && evsIn.length === 0)) && (
        <p className="note" data-testid="timeline-outside">
          {outRange.length > 0 && `この範囲に記録のない項目：${outRange.map((p) => p.name).join('・')}。`}
          {medsOut.length > 0 && `この範囲に動きの記録のない薬：${medsOut.map((m) => m.name).join('・')}。`}
          {evs.length > 0 && evsIn.length === 0 && 'この範囲に、できごとの記録はありません。'}
        </p>
      )}
      {empty.length > 0 && <p className="note">記録のない項目：{empty.map((p) => p.name).join('・')}</p>}
      <p className="note">中の白い点は、日だけ分かる値（その日の真ん中に置いています）。横に動かす・2本指で拡大縮小・下の細い帯で範囲を選べます。縦の目盛りは、見えている範囲の値で決めています。正常範囲や色分けは付けていません。</p>
    </div>
  );
}

/** 範囲の文字（「11/18 06:00 〜 11/21 08:52」） */
function rangeText(w: Window): string {
  const show = (t: number): string => {
    const d = new Date(t);
    const two = (n: number): string => String(n).padStart(2, '0');
    return `${String(d.getUTCMonth() + 1)}/${String(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  };
  return `${show(w[0])} 〜 ${show(w[1])}`;
}
