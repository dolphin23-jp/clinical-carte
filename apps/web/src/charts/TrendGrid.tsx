// 検査の推移：項目ごとの小さな線のグラフ（項目と、書かれた単位ごと）。正常範囲・色分けは描かない。
// 縦の目盛りは、その項目の目盛りの上と下だけを左に書く。タップした点の値を、カードの下に出す。値は、下の表でも読める。
import { type ChartPoint, EXTRA_LAB_NAMES, LAB_NAMES, type LabTrend, latestPoint, niceTicks, untimedSameDay } from '@clinical-carte/core';
import { type PointerEvent, useRef, useState } from 'react';

import { shortWhen, tickText } from './format.ts';
import { useWidth } from './useWidth.ts';

const SMALL_H = 64;
/** 大きく見るときの高さ（段H） */
const BIG_H = 180;
const PAD_X = 8;
/** 左の目盛りの数の幅 */
const BASE_GUT = 30;
const PAD_Y = 8;

function MiniChart({ trend, domain, unitless, big, onBig }: { trend: LabTrend; domain: [number, number]; unitless: boolean; big: boolean; onBig: () => void }) {
  const H = big ? BIG_H : SMALL_H;
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 160);
  const [picked, setPicked] = useState<ChartPoint | null>(null);
  const values = trend.points.map((p) => p.value);
  const scale = niceTicks(Math.min(...values), Math.max(...values), 2);
  // 左の目盛りの数の幅：数の字数に合わせる（「15000」の頭が切れないように）
  const GUT = Math.max(BASE_GUT, Math.max(tickText(scale.min).length, tickText(scale.max).length) * 6.5 + 8);
  const plotW = Math.max(40, width - GUT - PAD_X);
  const span = domain[1] - domain[0];
  const x = (t: number): number => GUT + (span <= 0 ? plotW / 2 : ((t - domain[0]) / span) * plotW);
  const y = (v: number): number => PAD_Y + (H - 2 * PAD_Y) - ((v - scale.min) / (scale.max - scale.min)) * (H - 2 * PAD_Y);
  const path = trend.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${String(x(p.t))},${String(y(p.value))}`).join(' ');
  const latest = latestPoint(trend.points) ?? undefined;
  const shown = picked ?? latest ?? null;

  const pick = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    let best: ChartPoint | null = null;
    for (const p of trend.points) if (best === null || Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    setPicked(best);
  };

  return (
    <div className={big ? 'trend big' : 'trend'} data-testid="trend">
      <div className="trend-head">
        <span className="trend-name">
          {trend.name}
          {trend.joined !== undefined ? (
            <span className="trend-unit" data-testid="trend-joined">
              （{trend.joined.units.map((u) => u ?? '単位の記載なし').join('・')}：先生が同じ目盛りと決めた）
            </span>
          ) : (
            <>
              {trend.unit !== null && <span className="trend-unit">（{trend.unit}）</span>}
              {unitless && <span className="trend-unit">（単位の記載なし）</span>}
            </>
          )}
        </span>
        {shown !== null && (
          <span className="trend-value" data-testid="trend-value">
            {shown.text}
            <span className="trend-when">
              {shortWhen(shown.at, shown)}
              {shown === latest && untimedSameDay(trend.points, latest) && '・同じ日に時刻のない値あり'}
            </span>
          </span>
        )}
      </div>
      <div ref={box} className="trend-plot">
        <svg width={width} height={H} role="img" aria-label={`${trend.name}の推移（${String(trend.points.length)} 点）`}>
          <line x1={GUT} x2={GUT + plotW} y1={y(scale.min)} y2={y(scale.min)} className="gridline" />
          <line x1={GUT} x2={GUT + plotW} y1={y(scale.max)} y2={y(scale.max)} className="gridline" />
          <text x={GUT - 5} y={y(scale.max) + 4} className="axis-text" textAnchor="end">
            {tickText(scale.max)}
          </text>
          <text x={GUT - 5} y={y(scale.min) + 4} className="axis-text" textAnchor="end">
            {tickText(scale.min)}
          </text>
          {trend.points.length > 1 && <path d={path} className="line series-lab" />}
          {trend.points.map((p) => (
            <circle key={p.t} cx={x(p.t)} cy={y(p.value)} r={picked?.t === p.t ? 5 : 3.5} className={`dot series-lab${p.dateOnly ? ' hollow' : ''}`} />
          ))}
          <rect x={0} y={0} width={width} height={H} className="hit" onPointerMove={pick} onPointerDown={pick} />
        </svg>
      </div>
      {trend.hidden > 0 && <p className="trend-note">グラフにない値 {String(trend.hidden)}（不等号・定性・日時なし。表にあります）</p>}
      <button type="button" className="button link small" aria-expanded={big} onClick={onBig} data-testid="trend-expand">
        {big ? '小さくする' : '大きく見る'}
      </button>
      {big && (
        <ul className="trend-values" data-testid="trend-values">
          {[...trend.points].reverse().map((p) => (
            <li key={p.t}>
              <span className="fact-when">{shortWhen(p.at, p)}</span>
              <strong>{p.text}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 検査の群（検査名の表の群。表にない名前は「その他」） */
const groupOf = (name: string): string => [...LAB_NAMES, ...EXTRA_LAB_NAMES].find((e) => e.name === name)?.group ?? 'その他';
/** 群の並び（よく見るものを先に） */
const GROUP_ORDER = ['血算', '白血球分画', '生化学', '凝固・線溶', '血液ガス', '心筋', '感染症', '尿定性', '尿沈渣', '尿生化学', '内分泌', '免疫・膠原病', '腫瘍マーカー', '薬物濃度', '体液', '心電図・心エコー・画像の計測値', 'その他'];
/** 推移がこれより多いときは、群を畳む（いまの問題の項目と、最初の群だけ開く） */
const OPEN_ALL_MAX = 8;

/**
 * 検査の推移（段H）：いまの問題の記載に書かれた項目（priority。推し量らない：その問題の記載の範囲に書かれた名前だけ）を先に、
 * 残りは検査の群ごとにまとめる。多いときは群を畳む。押すと大きく見る（値の一覧つき）。大きく見るものは、画面のメモリだけ
 */
export function TrendGrid({ trends, priority = new Set<string>() }: { trends: readonly LabTrend[]; priority?: ReadonlySet<string> }) {
  const [big, setBig] = useState<string | null>(null);
  const plotted = trends.filter((t) => t.points.length > 0);
  const onlyTable = trends.filter((t) => t.points.length === 0);
  if (plotted.length === 0) return null;
  const times = plotted.flatMap((t) => t.points.map((p) => p.t));
  const domain: [number, number] = [Math.min(...times), Math.max(...times)];
  const chart = (t: LabTrend) => (
    <MiniChart
      key={t.key}
      trend={t}
      domain={domain}
      big={big === t.key}
      onBig={() => {
        setBig(big === t.key ? null : t.key);
      }}
      unitless={t.unit === null && trends.some((o) => o !== t && o.name === t.name && o.unit !== null)}
    />
  );
  const first = plotted.filter((t) => priority.has(t.name));
  const rest = plotted.filter((t) => !priority.has(t.name));
  const groups = new Map<string, LabTrend[]>();
  for (const t of rest) groups.set(groupOf(t.name), [...(groups.get(groupOf(t.name)) ?? []), t]);
  const ordered = [...groups.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]));
  const openAll = plotted.length <= OPEN_ALL_MAX;
  return (
    <div className="trends" data-testid="trends">
      {first.length > 0 && (
        <section className="trend-section" data-testid="trend-priority">
          <h4 className="part-label">いまの問題の記載に書かれた項目（{String(first.length)}）</h4>
          <div className="trend-grid">{first.map(chart)}</div>
        </section>
      )}
      {ordered.map(([name, list], i) => (
        <details key={name} className="trend-section" open={openAll || (first.length === 0 && i === 0)} data-testid="trend-group">
          <summary className="part-label">
            {name}（{String(list.length)}）
          </summary>
          <div className="trend-grid">{list.map(chart)}</div>
        </details>
      ))}
      {onlyTable.length > 0 && <p className="note">表だけの項目（不等号・定性など）：{onlyTable.map((t) => t.name).join('・')}</p>}
      <p className="note">どの項目も、同じ時間の軸です。縦の目盛りは項目ごと（左の数は、その項目の目盛りの下と上）。正常範囲や色分けは付けていません。</p>
    </div>
  );
}
