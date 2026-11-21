// 単位の「同じ目盛り」（CA-051。全患者に共通）：同じ項目で、単位の書き方の違う推移（「単位の記載なし」と「/μL」など）を、先生が同じ目盛りと決めてつなぐ・外す。
// 換算はしない（点の字には、書かれた単位が残る）。字は打たない（項目と単位は、推移にあるものから選ぶ）。決めたものは、ほかの患者の推移にも効く。
import { type LabTrend, LAB_NAMES, EXTRA_LAB_NAMES } from '@clinical-carte/core';
import { useState } from 'react';

import { errorMessage } from './messages.ts';
import { addScaleLink, removeScaleLink, type Result, type ScaleLinkView } from './net/api.ts';

const unitLabel = (u: string | null): string => (u === null || u === '' ? '単位の記載なし' : u);
const isLab = (name: string): boolean => [...LAB_NAMES, ...EXTRA_LAB_NAMES].some((e) => e.name === name && e.kind === 'lab');

export function ScaleLinks({ trends, links, onChanged, onLeft }: { trends: readonly LabTrend[]; links: readonly ScaleLinkView[]; onChanged: () => void; onLeft: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 同じ項目で、別々の推移になっているもの（つなげる候補）
  const byName = new Map<string, LabTrend[]>();
  for (const t of trends) if (isLab(t.name)) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
  const candidates = [...byName.entries()].filter(([, list]) => list.length > 1);
  // この患者の推移に効いている決め
  const used = links.filter((l) => trends.some((t) => t.joined?.linkIds.includes(l.id)));
  if (candidates.length === 0 && used.length === 0) return null;

  const run = (action: () => Promise<Result<null>>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    void action().then((r) => {
      setBusy(false);
      if (r.ok) onChanged();
      else if (r.error === 'unregistered') onLeft();
      else setMessage(errorMessage(r.error));
    });
  };

  return (
    <section className="scale-links" data-testid="scale-links">
      <h3 className="sub-title">単位の違う推移</h3>
      <p className="note">同じ項目で、単位の書き方が違う値は、別の推移にしています（単位がないことは、同じ目盛りであることを意味しないため）。同じ目盛りと分かっているときだけ、つなげます。換算はしません。決めたものは、ほかの患者の推移にも効きます。</p>
      <ul className="fact-list">
        {candidates.flatMap(([name, list]) =>
          list.slice(1).map((t, i) => {
            const first = list[0] as LabTrend;
            return (
              <li key={`${name}:${String(i)}`} className="fact-row" data-testid="scale-candidate">
                <span className="fact-main">
                  {name}：{unitLabel(first.unit)} と {unitLabel(t.unit)}
                </span>
                <button type="button" className="button small" disabled={busy} onClick={() => { run(() => addScaleLink({ name, unitA: first.unit ?? '', unitB: t.unit ?? '' })); }} data-testid="scale-join">
                  同じ目盛りにする
                </button>
              </li>
            );
          }),
        )}
        {used.map((l) => (
          <li key={l.id} className="fact-row" data-testid="scale-link">
            <span className="fact-main">
              {l.name}：{unitLabel(l.unitA)} と {unitLabel(l.unitB)} は同じ目盛り（先生が決めた）
            </span>
            <button type="button" className="button small" disabled={busy} onClick={() => { run(() => removeScaleLink(l.id)); }} data-testid="scale-split">
              分ける
            </button>
          </li>
        ))}
      </ul>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
