// バイタル・検査値の入力欄：数の欄に打つと、文（「BT 37.2 HR 88 BP 120/80」）を作って、文の欄に入れる。
// 送るのは、いつも文の欄の文（同じ選別・同じ読み取りを通る）。空の欄は書かない（補わない）。
import { useState } from 'react';

import { composeValues, LAB_SETS, type QuickField, VITAL_FIELDS } from './templates.ts';

export function QuickValues({ kind, disabled, onCompose }: { kind: 'vital' | 'lab'; disabled: boolean; onCompose: (text: string) => void }) {
  const [open, setOpen] = useState(kind === 'vital');
  const [setIndex, setSetIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [bad, setBad] = useState<string[]>([]);

  const fields: readonly QuickField[] = kind === 'vital' ? VITAL_FIELDS : (LAB_SETS[setIndex]?.items ?? []).map((name) => ({ name, label: name, unit: '' }));

  const apply = () => {
    const r = composeValues(fields, values);
    if ('bad' in r) {
      setBad(r.bad);
      return;
    }
    setBad([]);
    if (r.text === '') return;
    onCompose(r.text);
    setValues({});
  };

  return (
    <div className="quick" data-testid="quick">
      <button
        type="button"
        className="quick-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        data-testid="quick-open"
      >
        {open ? '▾' : '▸'} {kind === 'vital' ? 'バイタルを欄で入れる' : '検査値を欄で入れる'}
      </button>
      {open && (
        <div className="quick-body">
          {kind === 'lab' && (
            <div className="chips">
              {LAB_SETS.map((s, i) => (
                <button
                  key={s.label}
                  type="button"
                  className={i === setIndex ? 'chip small on' : 'chip small'}
                  onClick={() => {
                    setSetIndex(i);
                    setValues({});
                    setBad([]);
                  }}
                  disabled={disabled}
                  data-testid={`labset-${String(i)}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <div className="quick-grid">
            {fields.map((f) => (
              <label key={f.name} className="quick-field">
                <span className="quick-label">
                  {f.label}
                  {f.unit !== '' && <span className="quick-unit">{f.unit}</span>}
                </span>
                <input
                  className={bad.includes(f.label) ? 'input quick-input bad' : 'input quick-input'}
                  inputMode="decimal"
                  autoComplete="off"
                  value={values[f.name] ?? ''}
                  onChange={(e) => {
                    setValues({ ...values, [f.name]: e.target.value });
                  }}
                  disabled={disabled}
                  data-testid={`quick-${f.name}`}
                />
              </label>
            ))}
          </div>
          {bad.length > 0 && (
            <p className="alert" role="alert">
              数で入れてください（不等号は「&lt;0.1」のように）：{bad.join('・')}
            </p>
          )}
          <button type="button" className="button" onClick={apply} disabled={disabled} data-testid="quick-apply">
            文の欄に入れる
          </button>
        </div>
      )}
    </div>
  );
}
