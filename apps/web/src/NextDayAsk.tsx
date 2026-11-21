// 日をまたいだかもしれない記載を、入れる前に1回だけ確かめる（CA-047）。決めるのは本人で、自動では翌日にしない
// （日は書かれていないので、補わない）。「23:30 … 0:15 …」のように、時刻が大きくさかのぼった場所だけを聞く（core の nextDayPoint）。
import { nextDayPoint, shiftDay } from '@clinical-carte/core';

export interface NextDayAnswer {
  /** どの逆戻りへの答えか（文を打ち直して逆戻りが変われば、答え直す） */
  readonly key: string;
  readonly next: boolean;
}

/** 確かめる逆戻りの鍵。なければ null */
export function nextDayKey(text: string): string | null {
  const point = nextDayPoint(text);
  return point === null ? null : `${point.before}>${point.time}`;
}

const monthDay = (day: string): string => `${String(Number(day.slice(5, 7)))}/${String(Number(day.slice(8, 10)))}`;

export function NextDayAsk({ text, day, answer, onAnswer, disabled }: { text: string; day: string | null; answer: NextDayAnswer | null; onAnswer: (answer: NextDayAnswer) => void; disabled: boolean }) {
  const point = nextDayPoint(text);
  if (point === null) return null;
  const key = `${point.before}>${point.time}`;
  const chosen = answer?.key === key ? answer.next : null;
  const valid = day !== null && /^\d{4}-\d{2}-\d{2}$/.test(day);
  const choices: readonly (readonly [boolean, string, string])[] = [
    [true, valid ? `翌日（${monthDay(shiftDay(day, 1))}）` : '翌日', 'next-day-yes'],
    [false, valid ? `同じ日（${monthDay(day)}）` : '同じ日', 'next-day-no'],
  ];
  return (
    <fieldset className="field" data-testid="next-day">
      <legend className="field-label">日をまたいでいますか</legend>
      <p className="note">
        文の中で、{point.before} のあとに {point.time} があります。{point.time} からあとの、日の書かれていない時刻は、どちらの日ですか。自動では決めません。
      </p>
      <div className="chips" role="radiogroup" aria-label="日をまたいでいますか">
        {choices.map(([next, label, id]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={chosen === next}
            className={chosen === next ? 'chip small on' : 'chip small'}
            disabled={disabled}
            onClick={() => {
              onAnswer({ key, next });
            }}
            data-testid={id}
          >
            {label}
          </button>
        ))}
      </div>
      {chosen === null && <p className="note over">どちらかを選ぶと、入れられます。</p>}
    </fieldset>
  );
}

/** 記録の札：翌日として読んでいる場所の時刻（「0:15」）。なければ null */
export function nextDayLabel(text: string, from: number | null): string | null {
  if (from === null) return null;
  return /^\d{1,2}(?::\d{2}|時(?:\d{1,2}分)?)/u.exec(text.slice(from).replace(/[０-：]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)))?.[0] ?? '';
}
