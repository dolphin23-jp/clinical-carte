// 記録の地図（段K。CA-058）：受診の始まりの日から最後の記録の日までを横に、記録（入れた文）・バイタル・検査・投薬・できごとを縦に並べ、
// 「その日に、その種類の記録が入っているか」だけを点で出す（日の帯〔CA-053〕と同じ材料。数・値は見ない。色は種類を見分けるためだけで、値で変えない）。
// どの日をまだ写していないかが、ひと目で分かる。日を押すと、その日に入っているものの数が下に出て、そこから経過のその日へ行ける。
import type { StripDay } from '@clinical-carte/core';
import { type PointerEvent, useRef, useState } from 'react';

import { useWidth } from './useWidth.ts';

const ROWS = [
  ['sources', '記録', 'note'],
  ['vitals', 'バイタル', 'vital'],
  ['labs', '検査', 'lab'],
  ['medications', '投薬', 'med'],
  ['events', 'できごと', 'event'],
] as const;

const GUTTER = 58;
const RIGHT = 6;
const AXIS_H = 30;
const ROW_H = 16;
/** 1日の幅の上限（日数の少ない受診で、点が間のびしないように） */
const CELL_MAX = 46;

export function RecordMap({ days, onOpenDay }: { days: readonly StripDay[]; onOpenDay: (day: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [picked, setPicked] = useState<string | null>(null);
  if (days.length === 0) return null;
  const plotW = Math.max(60, width - GUTTER - RIGHT);
  const cell = Math.min(CELL_MAX, plotW / days.length);
  const x = (i: number): number => GUTTER + (i + 0.5) * cell;
  const y = (r: number): number => AXIS_H + (r + 0.5) * ROW_H;
  const height = AXIS_H + ROWS.length * ROW_H + 4;
  // 日付の目盛り：字が重ならない間隔で、最初の日から。最後の日は、前の目盛りと離れていれば足す
  const step = Math.max(1, Math.ceil(44 / cell));
  const ticks = days.map((_, i) => i).filter((i) => i % step === 0);
  const lastIndex = days.length - 1;
  if (!ticks.includes(lastIndex) && lastIndex - (ticks.at(-1) ?? 0) >= step) ticks.push(lastIndex);
  const r = Math.max(1.5, Math.min(4.5, cell / 2 - 1));
  const pickedIndex = picked === null ? -1 : days.findIndex((d) => d.day === picked);
  const pickedDay = pickedIndex < 0 ? null : (days[pickedIndex] ?? null);
  const pick = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const i = Math.min(days.length - 1, Math.max(0, Math.floor((event.clientX - rect.left) / cell)));
    setPicked(days[i]?.day ?? null);
  };
  const filled = days.filter((d) => d.sources > 0).length;

  return (
    <div className="record-map" ref={box} data-testid="record-map">
      <svg width={width} height={height} role="img" aria-label={`記録の地図：${String(days.length)} 日のうち、記録のある日 ${String(filled)} 日`}>
        {ticks.map((i) => {
          const d = days[i];
          return d === undefined ? null : (
            <g key={d.day}>
              <line x1={x(i)} x2={x(i)} y1={AXIS_H - 3} y2={height - 4} className="gridline faint" />
              <text x={x(i)} y={12} className="axis-text" textAnchor="middle">
                {d.label}
              </text>
              {d.hospitalDay !== null && (
                <text x={x(i)} y={24} className="axis-text muted" textAnchor="middle">
                  {`${String(d.hospitalDay)}病日`}
                </text>
              )}
            </g>
          );
        })}
        {pickedIndex >= 0 && <rect x={GUTTER + pickedIndex * cell} y={AXIS_H - 2} width={cell} height={ROWS.length * ROW_H + 4} rx={3} className="map-picked" />}
        {ROWS.map(([key, name, cat], rowIndex) => (
          <g key={key} data-testid={`map-row-${key}`}>
            <text x={0} y={y(rowIndex) + 4} className="map-label">
              {name}
            </text>
            {days.map((d, i) =>
              d[key] > 0 ? (
                cell >= 7 ? (
                  <circle key={d.day} cx={x(i)} cy={y(rowIndex)} r={r} className={`map-dot cat-${cat}`} />
                ) : (
                  <rect key={d.day} x={x(i) - Math.max(1, cell / 2 - 0.25)} y={y(rowIndex) - 4} width={Math.max(2, cell - 0.5)} height={8} className={`map-dot cat-${cat}`} />
                )
              ) : cell >= 7 ? (
                <circle key={d.day} cx={x(i)} cy={y(rowIndex)} r={1} className="map-none" />
              ) : null,
            )}
          </g>
        ))}
        <rect x={GUTTER} y={0} width={cell * days.length} height={height} className="hit" onPointerDown={pick} data-testid="record-map-hit" />
      </svg>
      <div className="readout map-readout" data-testid="record-map-readout" aria-live="polite">
        {pickedDay === null ? (
          <span className="note">点は「その日に入っているか」だけです（数・値では変わりません）。日を押すと、その日の内わけが出ます。</span>
        ) : (
          <>
            <div className="readout-when">
              {pickedDay.label}（{pickedDay.weekday}）{pickedDay.hospitalDay !== null && `・${String(pickedDay.hospitalDay)}病日`}
            </div>
            <span className="map-counts">
              {ROWS.map(([key, name]) => `${name} ${String(pickedDay[key])}`).join('・')}
            </span>
            <button
              type="button"
              className="chip small"
              onClick={() => {
                onOpenDay(pickedDay.day);
              }}
              data-testid="record-map-open"
            >
              この日を経過で見る
            </button>
          </>
        )}
      </div>
    </div>
  );
}
