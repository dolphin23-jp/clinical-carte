// いちばん新しいバイタル（患者の画面の上）。数と、いつの値かを出すだけ（判定しない・色分けしない）。
import { latestPoint, type VitalPanel } from '@clinical-carte/core';

import { shortWhen } from './charts/format.ts';

export function LatestStrip({ panels }: { panels: readonly VitalPanel[] }) {
  const items = panels.map((p) => ({ p, last: latestPoint(p.points) })).filter((x) => x.last !== null);
  if (items.length === 0) return null;
  return (
    <div className="latest" data-testid="latest">
      {items.map(({ p, last }) =>
        last === null ? null : (
          <div key={p.key} className="stat" data-testid="latest-item">
            <span className="stat-label">
              <span className={`stat-key swatch-${p.id}`} aria-hidden="true" />
              {p.name}
            </span>
            <span className="stat-value">
              <span className="stat-num">{last.text}</span> <span className="stat-unit">{p.unit}</span>
            </span>
            <span className="stat-when">{shortWhen(last.at, last)}</span>
          </div>
        ),
      )}
    </div>
  );
}
