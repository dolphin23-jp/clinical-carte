// いちばん新しいバイタル（「いま」の上）。数と、いつの値かと、小さな推移の線（段L。CA-080）を出すだけ
// （判定しない・値で色分けしない・増減の矢印を付けない。色は、経過表と同じ項目の色）。
import { latestPoint, untimedSameDay, type VitalPanel } from '@clinical-carte/core';

import { shortWhen } from './charts/format.ts';
import { Sparkline } from './charts/Sparkline.tsx';
import { Icon } from './Icon.tsx';

export function LatestStrip({ panels, onOpen }: { panels: readonly VitalPanel[]; onOpen?: () => void }) {
  const items = panels.map((p) => ({ p, last: latestPoint(p.points) })).filter((x) => x.last !== null);
  if (items.length === 0) return null;
  return (
    <section className="latest-block" aria-labelledby="latest-title">
      <div className="latest-head">
        <h3 id="latest-title" className="sub-title with-icon">
          <Icon name="vital" />
          最新のバイタル
        </h3>
        {onOpen !== undefined && (
          <button type="button" className="button link small with-icon" onClick={onOpen} data-testid="latest-open">
            経過表で見る
            <Icon name="chevron" />
          </button>
        )}
      </div>
      <div className="latest" data-testid="latest">
        {items.map(({ p, last }) =>
          last === null ? null : (
            <div key={p.key} className="stat" data-testid="latest-item">
              <span className="stat-label">
                <span className={`stat-key swatch-${p.id}`} aria-hidden="true" />
                <span className="stat-name">{p.name}</span>
                <span className="stat-unit">{p.unit}</span>
              </span>
              <span className="stat-value">
                <span className="stat-num">{last.text}</span>
              </span>
              <Sparkline points={p.points} id={p.id} name={p.name} />
              <span className="stat-when">
                {shortWhen(last.at, last)}
                {untimedSameDay(p.points, last) && '・同じ日に時刻のない値あり'}
              </span>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
