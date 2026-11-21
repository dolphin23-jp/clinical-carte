// 日の帯（段H。CA-053）：受診の始まりの日から最後の記録の日までを、横に並べる。各日には、記録・値・薬・できごとが「あるか」の印だけ
// （値は見ない・色で判定しない）。日を押すと、その日（0〜24時）を経過表・記載・一覧で見る。もう一度押すと、選ぶ前に戻る。
// 選んだ日は、画面のメモリだけ（保存しない）。
import type { StripDay } from '@clinical-carte/core';
import { useEffect, useRef } from 'react';

export function DayStrip({ days, selected, onSelect }: { days: readonly StripDay[]; selected: string | null; onSelect: (day: string | null) => void }) {
  const row = useRef<HTMLDivElement>(null);
  // はじめは、いちばん新しい日が見えるように、右の端へ（DOM の scrollLeft。style は使わない：CSP）
  useEffect(() => {
    const el = row.current;
    if (el !== null) el.scrollLeft = el.scrollWidth;
  }, [days.length]);
  if (days.length === 0) return null;
  const index = selected === null ? -1 : days.findIndex((d) => d.day === selected);
  const move = (dir: -1 | 1) => {
    const base = index < 0 ? days.length - 1 : index;
    const next = days[Math.min(days.length - 1, Math.max(0, base + (index < 0 ? 0 : dir)))];
    if (next !== undefined) onSelect(next.day);
  };
  return (
    <div className="day-strip-wrap" data-testid="day-strip">
      <div className="day-strip" ref={row} role="listbox" aria-label="日を選ぶ">
        {days.map((d) => {
          const on = d.day === selected;
          const marks = [
            d.sources > 0 ? `記録 ${String(d.sources)}` : null,
            d.vitals > 0 ? `バイタル ${String(d.vitals)}` : null,
            d.labs > 0 ? `検査 ${String(d.labs)}` : null,
            d.medications > 0 ? `投薬 ${String(d.medications)}` : null,
            d.events > 0 ? `できごと ${String(d.events)}` : null,
          ].filter((m): m is string => m !== null);
          return (
            <button
              key={d.day}
              type="button"
              role="option"
              aria-selected={on}
              className={on ? 'day-cell on' : marks.length === 0 ? 'day-cell empty' : 'day-cell'}
              onClick={() => {
                onSelect(on ? null : d.day);
              }}
              aria-label={`${d.label}（${d.weekday}）${d.hospitalDay === null ? '' : `・${String(d.hospitalDay)}病日`}・${marks.length === 0 ? '記録なし' : marks.join('・')}`}
              data-testid="day-cell"
            >
              <span className="day-date">{d.label}</span>
              <span className="day-sub">
                {d.weekday}
                {d.hospitalDay !== null && `・${String(d.hospitalDay)}病日`}
              </span>
              <span className="day-marks" aria-hidden="true">
                <span className={d.sources > 0 ? 'day-mark has' : 'day-mark'}>記</span>
                <span className={d.vitals + d.labs > 0 ? 'day-mark has' : 'day-mark'}>値</span>
                <span className={d.medications > 0 ? 'day-mark has' : 'day-mark'}>薬</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="day-strip-actions">
        <button type="button" className="chip small" disabled={index === 0} onClick={() => { move(-1); }} data-testid="day-prev">
          ◀ 前の日
        </button>
        <span className="note" data-testid="day-selected">
          {selected === null ? '日を押すと、その日（0〜24時）を見ます' : `${days[index]?.label ?? selected} を見ています`}
        </span>
        {selected !== null && (
          <button type="button" className="chip small" onClick={() => { onSelect(null); }} data-testid="day-clear">
            日を外す
          </button>
        )}
        <button type="button" className="chip small" disabled={index === days.length - 1} onClick={() => { move(1); }} data-testid="day-next">
          次の日 ▶
        </button>
      </div>
    </div>
  );
}
