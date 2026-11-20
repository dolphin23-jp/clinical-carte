// 検査・バイタルの表（docs/04 の 3.4）：項目 × 日時。書かれたとおりに出す。**判定しない**（色・矢印・基準範囲を付けない）。
import { compareDateTime } from '@clinical-carte/core';

import { showDateTime } from './format.ts';
import type { Observation } from './net/api.ts';

const cell = (o: Observation): string => `${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`;

export function LabTable({ observations }: { observations: readonly Observation[] }) {
  if (observations.length === 0) return <p className="note">この受診には、まだ、読んだ値がありません。種類を「検査結果」「バイタル」にして入れると、ここに並びます。</p>;

  const times = [...new Set(observations.map((o) => o.at))].sort(compareDateTime);
  // 行：バイタルを先に、あとは、古い日時の文から、書かれた順（サーバーは、文ごとに、書かれた順で返す）
  const ordered = observations.map((o, index) => ({ o, index })).sort((a, b) => compareDateTime(a.o.at, b.o.at) || a.index - b.index);
  const labels: { label: string; vital: boolean }[] = [];
  for (const { o } of ordered) {
    const label = o.name ?? o.nameRaw;
    if (!labels.some((l) => l.label === label)) labels.push({ label, vital: o.kind === 'vital' });
  }
  labels.sort((a, b) => Number(b.vital) - Number(a.vital));
  const at = (label: string, time: string | null): string =>
    observations
      .filter((o) => (o.name ?? o.nameRaw) === label && o.at === time)
      .map(cell)
      .join(' / ');

  return (
    <div className="table-scroll" data-testid="lab-table">
      <table className="grid">
        <thead>
          <tr>
            <th scope="col" className="grid-corner">
              項目
            </th>
            {times.map((t) => (
              <th key={t ?? 'unknown'} scope="col">
                {showDateTime(t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map(({ label }) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {times.map((t) => (
                <td key={t ?? 'unknown'}>{at(label, t)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
