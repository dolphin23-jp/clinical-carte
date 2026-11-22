// 検査・バイタルの表（docs/04 の 3.4）：項目 × 日（段H。日時ごとの列では、列が多すぎて読めなかった）。書かれたとおりに出す。
// 同じ日に2回以上あれば、セルの中に時刻つきで並べる。基準範囲の外の値には、H・L の字と色（段K3。CA-059。範囲と出典は、セルの説明に）。
import { compareDateTime } from '@clinical-carte/core';

import type { Observation } from './net/api.ts';
import { markFor, REF_NOTE, refClass, refLetter, type RefPatient, refTitle } from './refmark.ts';

const dayOf = (at: string | null): string | null => (at === null ? null : at.slice(0, 10));
const timeOf = (at: string | null): string => (at === null || at.length <= 10 ? '時刻なし' : at.slice(11, 16));

export function LabTable({ observations, patient = null }: { observations: readonly Observation[]; patient?: RefPatient | null }) {
  const mark = (o: Observation) => markFor(o, patient);
  const cell = (o: Observation): string => {
    const m = mark(o);
    const letter = m === null ? '' : refLetter(m);
    return `${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}${o.unseen === true ? '※' : ''}${letter === '' ? '' : ` ${letter}`}`;
  };
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
  const at = (label: string, day: string | null): { text: string; title: string; cls: string } => {
    const list = ordered.map(({ o }) => o).filter((o) => (o.name ?? o.nameRaw) === label && dayOf(o.at) === day);
    const times = new Set(list.map((o) => o.at));
    // 同じ日に違う時刻の値があれば、時刻を添える（1つの時刻だけなら、値だけ。時刻はセルの説明に）
    const text = times.size > 1 ? list.map((o) => `${timeOf(o.at)} ${cell(o)}`).join(' / ') : list.map(cell).join(' / ');
    // 色は、範囲の外の値があるときだけ（高い・低いが混ざれば、両方の字が見える。色は最後の値のもの）
    const marks = list.map(mark).filter((m) => m !== null);
    const lastOut = [...marks].reverse().find((m) => refLetter(m) !== '');
    const titles = [...new Set(marks.map(refTitle).filter((t) => t !== ''))];
    return { text, title: `${list.map((o) => `${timeOf(o.at)} ${cell(o)}`).join(' / ')}${titles.length > 0 ? `\n${titles.join('\n')}` : ''}`, cls: lastOut === undefined ? '' : refClass(lastOut) };
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
                  <td key={d ?? 'unknown'} title={v.title} className={v.cls === '' ? undefined : v.cls} data-testid={v.cls === '' ? undefined : 'ref-cell'}>
                    {v.text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {patient !== null && <p className="note">{REF_NOTE}</p>}
    </div>
  );
}
