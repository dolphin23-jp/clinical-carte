// 小さな推移の線（段L。CA-080）：最新のバイタルの札に添える。目盛り・正常範囲・色分け・増減の矢印は描かない（判定しない）。
// 横は時間（記録どうしの間隔のまま）、縦はその項目の値の幅だけ。色は、経過表と同じ項目の色（どの項目かを見分けるためだけ）。
// 血圧は、上と下を縦の線でつなぐ（経過表と同じ形）。値そのものは、札の数字と、経過表・表で読む。
import { type ChartPoint, latestPoint, type VitalPanel } from '@clinical-carte/core';
import { useRef } from 'react';

import { useWidth } from './useWidth.ts';

/** 札に描く点の数（新しいほうから） */
export const SPARK_POINTS = 12;
const H = 30;
const PAD = 4;

export function Sparkline({ points, id, name }: { points: readonly ChartPoint[]; id: VitalPanel['id']; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 96);
  const shown = points.slice(-SPARK_POINTS);
  const latest = latestPoint(points);
  if (shown.length < 2) return <div ref={box} className="spark empty" aria-hidden="true" />;
  const values = shown.flatMap((p) => (p.low === undefined ? [p.value] : [p.value, p.low]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const t0 = shown[0]?.t ?? 0;
  const t1 = shown.at(-1)?.t ?? 1;
  const x = (t: number): number => PAD + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (width - 2 * PAD);
  const y = (v: number): number => (max === min ? H / 2 : PAD + (1 - (v - min) / (max - min)) * (H - 2 * PAD));
  const cls = `series-${id}`;
  return (
    <div ref={box} className="spark" data-testid="spark">
      <svg width={width} height={H} role="img" aria-label={`${name}の推移（新しいほうから ${String(shown.length)} 点）`}>
        {id === 'bp' ? (
          shown.map((p) => (p.low === undefined ? <circle key={p.t} cx={x(p.t)} cy={y(p.value)} r={2} className={`dot spark-dot ${cls}`} /> : <line key={p.t} x1={x(p.t)} x2={x(p.t)} y1={y(p.value)} y2={y(p.low)} className={p.t === latest?.t ? 'spark-range last' : 'spark-range'} />))
        ) : (
          <>
            <path d={shown.map((p, i) => `${i === 0 ? 'M' : 'L'}${String(x(p.t))},${String(y(p.value))}`).join(' ')} className={`line spark-line ${cls}`} />
            {latest !== null && shown.includes(latest) && <circle cx={x(latest.t)} cy={y(latest.value)} r={3} className={`dot spark-dot ${cls}`} />}
          </>
        )}
      </svg>
    </div>
  );
}
