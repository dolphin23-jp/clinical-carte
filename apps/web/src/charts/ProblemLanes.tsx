// 問題ごとの、書かれた日の点（段L。CA-080）：問題ごとに、「書かれた日時」を同じ時間の軸に点で並べる。計算は core の problemLanes（純関数）。
// どの問題が、どの日に書かれたか（どの日から書かれていないか）を見るための図。**線で結ばない**：問題が続いている期間の帯は、
// 経過表のボードの「問題の帯」（CA-061）の役目で、ここは書かれた日時の点だけ（期間を、もう1つの決まりで描かない）。
// 判定しない：色は1つ。点の形（中が白＝日だけ分かる）と、名前の字の濃さ・状態の字（活動中でないもの）で分ける。
import { axisTicks, type ProblemLane, laneDomain } from '@clinical-carte/core';
import { useRef, useState } from 'react';

import { useWidth } from './useWidth.ts';

const GUTTER = 6;
const RIGHT = 10;
const AXIS_H = 32;
const LABEL_H = 17;
const LANE_H = 16;
const LANE_GAP = 5;

const two = (n: number): string => String(n).padStart(2, '0');
/** 「11/18 09:00」「11/18」（日だけ分かる記載） */
function markText(t: number, dateOnly: boolean): string {
  const d = new Date(t);
  const md = `${String(d.getUTCMonth() + 1)}/${String(d.getUTCDate())}`;
  return dateOnly ? md : `${md} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

export function ProblemLanes({ lanes, inpatientStart }: { lanes: readonly ProblemLane[]; inpatientStart: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [picked, setPicked] = useState<string | null>(null);
  const domain = laneDomain(lanes);
  if (domain === null) return null;
  const plotW = Math.max(120, width - GUTTER - RIGHT);
  const x = (t: number): number => GUTTER + ((t - domain[0]) / (domain[1] - domain[0])) * plotW;
  const ticks = axisTicks(domain, Math.max(2, Math.floor(plotW / 52)), inpatientStart);
  const rowH = LABEL_H + LANE_H + LANE_GAP;
  const height = AXIS_H + lanes.length * rowH + 2;
  // 名前は、幅に入る字数まで（切った分は、押すと下に全体が出る）
  const maxChars = Math.max(6, Math.floor((plotW - 70) / 12.5));
  const short = (name: string): string => (name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name);
  const pickedLane = lanes.find((l) => l.key === picked) ?? null;

  return (
    <div className="lanes" ref={box} data-testid="problem-lanes">
      <svg width={width} height={height} role="img" aria-label={`問題ごとの、書かれた日の点：${lanes.map((l) => `${l.no === null ? '' : `#${String(l.no)} `}${l.name}`).join('・')}`}>
        {ticks.map((tk) => (
          <g key={tk.t}>
            <line x1={x(tk.t)} x2={x(tk.t)} y1={AXIS_H - 4} y2={height - 2} className={tk.kind === 'day' ? 'gridline' : 'gridline faint'} />
            {/* 右の端の目盛りは、字が枠の外へ出るので、線だけ */}
            {x(tk.t) <= GUTTER + plotW - 28 && (
              <text x={x(tk.t) + 3} y={12} className="axis-text">
                {tk.label}
              </text>
            )}
            {tk.hospitalDay !== null && x(tk.t) <= GUTTER + plotW - 28 && (
              <text x={x(tk.t) + 3} y={24} className="axis-text muted">
                {`${String(tk.hospitalDay)}病日`}
              </text>
            )}
          </g>
        ))}
        {lanes.map((lane, i) => {
          const top = AXIS_H + i * rowH;
          const cy = top + LABEL_H + LANE_H / 2;
          const on = lane.key === picked;
          return (
            <g key={lane.key} className={lane.active ? 'lane-row' : 'lane-row closed'} data-testid="problem-lane">
              {on && <rect x={0} y={top - 2} width={width} height={rowH} rx={6} className="lane-picked" />}
              <text x={GUTTER} y={top + 12} className="lane-title">
                {lane.no !== null && <tspan className="lane-no">{`#${String(lane.no)} `}</tspan>}
                {short(lane.name)}
                {lane.stateName !== '' && <tspan className="panel-unit">{`\u3000${lane.stateName}`}</tspan>}
                {lane.undated > 0 && <tspan className="panel-unit">{`\u3000日時不明 ${String(lane.undated)}`}</tspan>}
              </text>
              <line x1={GUTTER} x2={GUTTER + plotW} y1={cy} y2={cy} className="lane" />
              {lane.marks.map((m) => (
                <circle key={m.t} cx={x(m.t)} cy={cy} r={4} className={m.dateOnly ? 'written-mark hollow' : 'written-mark'} />
              ))}
              <rect
                x={0}
                y={top - 2}
                width={width}
                height={rowH}
                className="hit lane-hit"
                onPointerDown={() => {
                  setPicked(on ? null : lane.key);
                }}
                data-testid="problem-lane-hit"
              />
            </g>
          );
        })}
      </svg>
      <div className="readout lanes-readout" data-testid="problem-lanes-readout" aria-live="polite">
        {pickedLane === null ? (
          <span className="note">点は、その問題が書かれた日時（中が白い点は、日だけ分かる記載）。書かれていない日には、何も置いていません。問題が続いている期間の帯は、経過の「経過表」にあります。押すと、書かれた日時が出ます。</span>
        ) : (
          <>
            <div className="readout-when">
              {pickedLane.no !== null && `#${String(pickedLane.no)} `}
              {pickedLane.name}
              {pickedLane.stateName !== '' && `（${pickedLane.stateName}）`}
            </div>
            <span className="map-counts">
              書かれた日時（{String(pickedLane.marks.length)}）：{pickedLane.marks.length === 0 ? 'なし' : pickedLane.marks.map((m) => markText(m.t, m.dateOnly)).join('・')}
              {pickedLane.undated > 0 && `・日時不明 ${String(pickedLane.undated)}`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
