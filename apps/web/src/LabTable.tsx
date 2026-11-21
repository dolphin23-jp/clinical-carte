// 検査・バイタルの表（docs/04 の 3.4）：項目 × 日（段H。日時ごとの列では、列が多すぎて読めなかった）。書かれたとおりに出す。
// 同じ日に2回以上あれば、セルの中に時刻つきで並べる。**判定しない**（色・矢印・基準範囲を付けない）。
import { compareDateTime } from '@clinical-carte/core';

import type { Observation } from './net/api.ts';

const cell = (o: Observation): string => `${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}${o.unseen === true ? '※' : ''}`;
const dayOf = (at: string | null): string | null => (at === null ? null : at.slice(0, 10));
const timeOf = (at: string | null): string => (at === null || at.length <= 10 ? '時刻なし' : at.slice(11, 16));

export function LabTable({ observations }: { observations: readonly Observation[] }) {
  if (observations.length === 0) return <p className="note">この受診には、まだ、読んだ値がありません。種類を「検査結果」「バイタル」にして入れると、ここに並びます。</p>;

  const days = [...new Set(observations.map((o) => dayOf(o.at)))].sort(compareDateTime);
  // 行：バイタルを先に、あとは、古い日時の文から、書かれた順（サーバーは、文ごとに、書かれた順で返す）
  const ordered = observations.map((o, index) => ({ o, index })).sort((a, b) => compareDateTime(a.o.at, b.o.at) || a.index - b.index);
  const labels: { label: string; vital: boolean }[] = [];
  for (const { o } of ordered) {
    const label = o.name ?? o.nameRaw;
    if (!labels.some((l) => l.label === label)) labels.push({ label, vital: o.kind === 'vital' });
  }
  labels.sort((a, b) => Number(b.vital) - Number(a.vital));
  const at = (label: string, day: string | null): { text: string; title: string } => {
    const list = ordered.map(({ o }) => o).filter((o) => (o.name ?? o.nameRaw) === label && dayOf(o.at) === day);
    const times = new Set(list.map((o) => o.at));
    // 同じ日に違う時刻の値があれば、時刻を添える（1つの時刻だけなら、値だけ。時刻はセルの説明に）
    const text = times.size > 1 ? list.map((o) => `${timeOf(o.at)} ${cell(o)}`).join(' / ') : list.map(cell).join(' / ');
    return { text, title: list.map((o) => `${timeOf(o.at)} ${cell(o)}`).join(' / ') };
  };

  return (
    <div className="table-scroll" data-testid="lab-table">
      <table className="grid">
        <thead>
          <tr>
            <th scope="col" className="grid-corner">
              項目
            </th>
            {days.map((d) => (
              <th key={d ?? 'unknown'} scope="col">
                {d ?? '日時不明'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {labels.map(({ label }) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {days.map((d) => {
                const v = at(label, d);
                return (
                  <td key={d ?? 'unknown'} title={v.title}>
                    {v.text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
