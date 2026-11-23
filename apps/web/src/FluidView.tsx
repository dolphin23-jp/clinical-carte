// 水分の出入りと体重（段K8。CA-069。CA-058 の A7）：日ごとに、書かれた入る量・出る量を項目ごとに足し、書かれた分の差と体重を並べる。
// 決定論で、AI を使わない。計算は core の fluidDays（経過表と同じ、外した値・同じ値の二重を除いた値から）。
// - 書かれていない量を補わない（合計はいつも「書かれた分だけの合計」）。換算しない（mL・mL/日・cc は別に足す）。判定しない（多い・少ない・H・L なし）
// - 色は入・出の見分けだけ（字の「入」「出」をいつも添える）
import { FLUID_SKIP_LABELS, type FluidDay, type FluidEntry, type FluidItem, type FluidSide, type FluidSum, fluidDays, hospitalDay, latestFluidDay } from '@clinical-carte/core';

import type { Encounter, Observation } from './net/api.ts';

const md = (day: string): string => `${String(Number(day.slice(5, 7)))}/${String(Number(day.slice(8, 10)))}`;
const timeOf = (at: string): string => (at.length <= 10 ? '時刻なし' : at.slice(11, 16));
const sumText = (s: FluidSum): string => `${s.text} ${s.unit}`;

function ItemLine({ item }: { item: FluidItem }) {
  const used = item.entries.filter((e) => e.skip === null);
  const skipped = item.entries.filter((e) => e.skip !== null);
  return (
    <li className="fluid-item" data-testid="fluid-item">
      <span className="fluid-name">{item.name}</span>
      {used.length > 0 && <span className="fluid-values">{used.map((e) => `${timeOf(e.at)} ${e.text}`).join('・')}</span>}
      {item.sums.length > 0 && used.length > 1 && <span className="fluid-sum">（計 {item.sums.map(sumText).join('・')}）</span>}
      {skipped.map((e: FluidEntry) => (
        <span key={e.id} className="fluid-skip" data-testid="fluid-skip">
          {timeOf(e.at)} {e.text}：{e.skip === null ? '' : FLUID_SKIP_LABELS[e.skip]}
        </span>
      ))}
    </li>
  );
}

function SideCell({ side, which }: { side: FluidSide; which: 'in' | 'out' }) {
  if (side.items.length === 0) return <span className="doc-empty">（書かれていません）</span>;
  return (
    <div className={`fluid-side fluid-${which}`} data-testid={`fluid-${which}`}>
      <ul>
        {side.items.map((item) => (
          <ItemLine key={item.name} item={item} />
        ))}
      </ul>
      {side.totals.length > 0 ? (
        <p className="fluid-total" data-testid={`fluid-${which}-total`}>
          書かれた分だけの合計 {side.totals.map(sumText).join('・')}
        </p>
      ) : (
        <p className="fluid-total">足せる値がありません（単位・不等号などのため）</p>
      )}
    </div>
  );
}

function BalanceCell({ day }: { day: FluidDay }) {
  if (day.balance.length > 0)
    return (
      <span className="fluid-balance" data-testid="fluid-balance">
        書かれた分の差 {day.balance.map((b) => `${b.text} ${b.unit}`).join('・')}
      </span>
    );
  return <span className="doc-empty">出しません（入・出の両方に、同じ単位の合計がありません）</span>;
}

function WeightCell({ day }: { day: FluidDay }) {
  if (day.weights.length === 0) return <span className="doc-empty">（書かれていません）</span>;
  return (
    <ul className="fluid-weights" data-testid="fluid-weight">
      {day.weights.map((w) => (
        <li key={w.entry.id}>
          {day.weights.length > 1 && `${timeOf(w.entry.at)} `}
          {w.entry.text}
          {w.change !== null ? (
            <span className="row-sub">（前回 {md(w.change.fromAt.slice(0, 10))} から {w.change.text} {w.change.unit}）</span>
          ) : (
            <span className="row-sub">{w.entry.unit === null ? '（単位の記載なし。差は出しません）' : '（比べる前の体重の記載なし）'}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function FluidView({ observations, encounter, day }: { observations: readonly Observation[]; encounter: Encounter; day: string | null }) {
  const summary = fluidDays(observations);
  const days = summary.days.filter((d) => day === null || d.day === day);
  return (
    <section className="fluid" data-testid="fluid" aria-label="水分の出入りと体重">
      <p className="note">
        書かれた量だけを、同じ単位どうしで足しています（書かれていない量は補いません。換算しません。単位の違う値は別に足します）。日は、値に書かれた日時の日です（締めの時刻は考えません）。多い・少ないの判定はしません。
      </p>
      {day !== null && <p className="note">{`${md(day)} の分だけを出しています（日を外すと、全期間）。`}</p>}
      {summary.undated > 0 && (
        <p className="note" data-testid="fluid-undated">
          日時のない値 {String(summary.undated)} 件は、どの日にも入れていません（記録の各記載の「整理した事実」にあります）。
        </p>
      )}
      {days.length === 0 ? (
        <p className="note" data-testid="fluid-none">
          {summary.days.length === 0 ? '水分の出入り（輸液量・飲水量・尿量・ドレーン排液量など）と体重の値は、まだ読まれていません。' : 'この日の水分の出入り・体重の値はありません。'}
        </p>
      ) : (
        <table className="fluid-table" data-testid="fluid-table">
          <thead>
            <tr>
              <th scope="col">日</th>
              <th scope="col" className="fluid-in-head">入</th>
              <th scope="col" className="fluid-out-head">出</th>
              <th scope="col">書かれた分の差（入 − 出）</th>
              <th scope="col">体重</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => {
              const hd = encounter.kind === 'inpatient' ? hospitalDay(encounter.start, d.day) : null;
              return (
                <tr key={d.day} data-testid="fluid-day">
                  <th scope="row">
                    {md(d.day)}
                    {hd !== null && <span className="row-sub">（{String(hd)}病日）</span>}
                  </th>
                  <td data-label="入">
                    <SideCell side={d.intake} which="in" />
                  </td>
                  <td data-label="出">
                    <SideCell side={d.output} which="out" />
                  </td>
                  <td data-label="書かれた分の差">
                    <BalanceCell day={d} />
                  </td>
                  <td data-label="体重">
                    <WeightCell day={d} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** いまのタブの1行：値のあるいちばん新しい日の、書かれた分の入・出・差と体重 */
export function FluidLine({ observations }: { observations: readonly Observation[] }) {
  const latest = latestFluidDay(fluidDays(observations));
  if (latest === null) return null;
  const parts: string[] = [];
  if (latest.intake.totals.length > 0) parts.push(`入 ${latest.intake.totals.map(sumText).join('・')}`);
  if (latest.output.totals.length > 0) parts.push(`出 ${latest.output.totals.map(sumText).join('・')}`);
  if (latest.balance.length > 0) parts.push(`書かれた分の差 ${latest.balance.map((b) => `${b.text} ${b.unit}`).join('・')}`);
  const w = latest.weights.at(-1);
  if (w !== undefined) parts.push(`体重 ${w.entry.text}${w.change === null ? '' : `（前回から ${w.change.text} ${w.change.unit}）`}`);
  if (parts.length === 0) return null;
  return (
    <p className="fluid-line" data-testid="fluid-line">
      <span className="fluid-line-head">水分（{md(latest.day)}・書かれた分だけ）</span>
      {parts.join('　')}
    </p>
  );
}
