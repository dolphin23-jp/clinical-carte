// 指示簿（段K11。CA-074〜CA-079）：受診ごとに1つ。欄（安静度・食事・酸素/呼吸器・モニター/測定・検査・コール基準・頓用・内服・その他）と、別の欄の点滴。
// - 入れ方：記録の文から写す（AI が欄に分け、字は記録の字のまま）・AI の案を出す（用量を含めてよい。資料にない数に※）・テンプレから入れる・手で足す。
//   写した項目と案は、**先生が1つずつ「入れる」まで指示簿に入らない**（それまでは画面のメモリだけ。保存しない）
// - スケールの点滴は、入れたときのテンプレの中身と、先生が入れた体重から、流量を決定論で計算して式とともに出す（判定しない）
// - 検査の予定は、後の記録の結果の記載を、結果待ちの1回（AI）で結びつけ、項目の下に出す
// - **病院のカルテへ戻す向き（コピーのボタン）は作らない**（CA-001・CA-033。病院のカルテには先生が打ち直す）
import {
  fieldsOf,
  type MarkedText,
  ORDER_ACTION_NAMES,
  ORDER_ACTIONS,
  ORDER_CATEGORIES,
  ORDER_CATEGORY_NAMES,
  ORDER_CATEGORY_SHORT,
  ORDER_FIELD_MAX,
  ORDER_FIELD_NAMES,
  ORDER_HISTORY_NAMES,
  ORDER_ORIGIN_NAMES,
  ORDER_STATUS_NAMES,
  ORDER_TEXT_MAX,
  PROPOSE_REJECT_NAMES,
  TRANSCRIBE_REJECT_NAMES,
  itemsByCategory,
  numberText,
  type OrderCategory,
  type OrderFields,
  type OrderItem,
  type OrderNew,
  type OrderProposal,
  type OrderTextField,
  orderFieldsProblem,
  orderLabel,
  type ScaleTemplate,
  SHEET_CATEGORIES,
  SOURCE_KIND_LABELS,
  unseenMarks,
} from '@clinical-carte/core';
import { type SyntheticEvent, useState } from 'react';

import { joinDateTime, showDateTime } from './format.ts';
import { Icon } from './Icon.tsx';
import { errorMessage } from './messages.ts';
import { addOrders, type ApiError, deleteOrder, type Encounter, type OrderProposals, type PatientRecord, patchOrder, proposeOrders, transcribeOrders } from './net/api.ts';
import { OrderTemplates, ScaleTable } from './OrderTemplates.tsx';
import { ResultLinks } from './PendingView.tsx';
import { Marked } from './SupportView.tsx';

const say = (error: ApiError): string => errorMessage(error).replace('文は保存していません。', '');

/** 欄ごとに出す字の欄（指示の文はどの欄にもある。出さない欄の値は、そのまま持つ） */
const VISIBLE: Readonly<Record<OrderCategory, readonly OrderTextField[]>> = {
  rest: ['condition'],
  diet: ['condition'],
  respiratory: ['condition', 'interval'],
  monitor: ['condition', 'interval'],
  test: ['interval'],
  call: ['condition'],
  prn: ['condition', 'drug', 'dose', 'interval'],
  oral: ['drug', 'dose', 'interval', 'duration'],
  infusion: ['drug', 'dose', 'rate', 'duration'],
  other: ['condition', 'interval'],
};
/** 開始・終わりの日時を入れる欄（検査は「予定の日時」） */
const TIMED: readonly OrderCategory[] = ['test', 'oral', 'infusion', 'respiratory', 'other'];

export const emptyFields = (category: OrderCategory): OrderFields => ({
  category,
  text: '',
  condition: '',
  drug: '',
  dose: '',
  rate: '',
  interval: '',
  duration: '',
  action: 'none',
  start: null,
  end: null,
  scale: null,
});

const fieldsOfProposal = (p: OrderProposal): OrderFields => ({
  category: p.category,
  text: p.text,
  condition: p.condition,
  drug: p.drug,
  dose: p.dose,
  rate: p.rate,
  interval: p.interval,
  duration: p.duration,
  action: p.action,
  start: null,
  end: null,
  scale: p.scale,
});

const newOf = (fields: OrderFields, p: OrderProposal | null): OrderNew => ({
  ...fields,
  origin: p?.origin ?? 'self',
  from: p?.from ?? null,
  basis: [...(p?.basis ?? [])],
  unseen: [...(p?.unseen ?? [])],
});

const splitAt = (at: string | null): { day: string; time: string } => ({ day: at === null ? '' : at.slice(0, 10), time: at !== null && at.length > 10 ? at.slice(11, 16) : '' });

/** AI の案の字に、資料にない数の※（保存した unseen の数の場所） */
function OrderText({ text, unseen }: { text: string; unseen: readonly string[] }) {
  const value: MarkedText = { text, marks: unseenMarks(text, unseen) };
  return <Marked value={value} />;
}

/** 欄の中身の行（書かれた欄だけ。空の欄は出さない：補わない） */
function FieldLine({ v, unseen }: { v: Pick<OrderFields, OrderTextField | 'action' | 'start' | 'end' | 'category'>; unseen: readonly string[] }) {
  const parts = (['condition', 'drug', 'dose', 'rate', 'interval', 'duration'] as const).filter((f) => v[f].trim() !== '');
  const when = [v.start === null ? null : `${v.category === 'test' ? '予定' : '開始'} ${showDateTime(v.start)}`, v.end === null ? null : `${v.category === 'infusion' ? '予定の終わり' : '終わり'} ${showDateTime(v.end)}`].filter((x) => x !== null);
  if (parts.length === 0 && v.action === 'none' && when.length === 0) return null;
  return (
    <p className="order-fields row-sub" data-testid="order-fields">
      {parts.map((f) => (
        <span key={f} className="order-field">
          <span className="order-field-name">{ORDER_FIELD_NAMES[f]}</span> <OrderText text={v[f]} unseen={unseen} />
        </span>
      ))}
      {v.action !== 'none' && <span className="order-field">{ORDER_ACTION_NAMES[v.action]}</span>}
      {when.map((w) => (
        <span key={w} className="order-field">
          {w}
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------
// 入れる・直す欄

export function OrderForm({
  initial,
  templates,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: OrderFields;
  templates: readonly ScaleTemplate[];
  busy: boolean;
  submitLabel: string;
  onSubmit: (fields: OrderFields) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<OrderFields>(initial);
  const [start, setStart] = useState(splitAt(initial.start));
  const [end, setEnd] = useState(splitAt(initial.end));
  const set = <K extends keyof OrderFields>(key: K, value: OrderFields[K]) => {
    setV({ ...v, [key]: value });
  };
  const fields: OrderFields = { ...v, start: start.day === '' ? null : joinDateTime(start.day, start.time), end: end.day === '' ? null : joinDateTime(end.day, end.time) };
  const problem = orderFieldsProblem(fields);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || fields.text.trim() === '' || problem !== null) return;
    onSubmit({ ...fields, text: fields.text.trim() });
  };
  const timed = TIMED.includes(v.category);
  return (
    <form className="form order-form" onSubmit={submit} data-testid="order-form">
      <label className="field">
        <span className="field-label">欄</span>
        <select
          className="input"
          value={v.category}
          onChange={(e) => {
            const category = e.target.value as OrderCategory;
            setV({ ...v, category, scale: category === 'infusion' ? v.scale : null });
          }}
          disabled={busy}
          data-testid="order-category"
        >
          {ORDER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {ORDER_CATEGORY_NAMES[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">指示（書かれたとおり・先生の言葉で）</span>
        <textarea
          className="input area"
          rows={2}
          maxLength={ORDER_TEXT_MAX}
          value={v.text}
          onChange={(e) => {
            set('text', e.target.value);
          }}
          disabled={busy}
          data-testid="order-field-text"
        />
      </label>
      <div className="field-row wrap">
        {VISIBLE[v.category].map((f) => (
          <label key={f} className="field">
            <span className="field-label">{ORDER_FIELD_NAMES[f]}</span>
            <input
              className="input"
              maxLength={ORDER_FIELD_MAX}
              value={v[f]}
              onChange={(e) => {
                set(f, e.target.value);
              }}
              disabled={busy}
              data-testid={`order-field-${f}`}
            />
          </label>
        ))}
      </div>
      {(v.category === 'oral' || v.category === 'infusion' || v.category === 'prn' || v.action !== 'none') && (
        <label className="field">
          <span className="field-label">動き</span>
          <select
            className="input"
            value={v.action}
            onChange={(e) => {
              set('action', e.target.value as OrderFields['action']);
            }}
            disabled={busy}
            data-testid="order-action"
          >
            {ORDER_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ORDER_ACTION_NAMES[a]}
              </option>
            ))}
          </select>
        </label>
      )}
      {timed && (
        <>
          <div className="field-row">
            <label className="field">
              <span className="field-label">{v.category === 'test' ? '予定の日' : '開始の日'}</span>
              <input className="input" type="date" value={start.day} onChange={(e) => { setStart({ ...start, day: e.target.value }); }} disabled={busy} data-testid="order-start-day" />
            </label>
            <label className="field">
              <span className="field-label">時刻</span>
              <input className="input" type="time" value={start.time} onChange={(e) => { setStart({ ...start, time: e.target.value }); }} disabled={busy} data-testid="order-start-time" />
            </label>
          </div>
          {v.category !== 'test' && (
            <div className="field-row">
              <label className="field">
                <span className="field-label">{v.category === 'infusion' ? '予定の終わりの日' : '終わりの日'}</span>
                <input className="input" type="date" value={end.day} onChange={(e) => { setEnd({ ...end, day: e.target.value }); }} disabled={busy} data-testid="order-end-day" />
              </label>
              <label className="field">
                <span className="field-label">時刻</span>
                <input className="input" type="time" value={end.time} onChange={(e) => { setEnd({ ...end, time: e.target.value }); }} disabled={busy} data-testid="order-end-time" />
              </label>
            </div>
          )}
          <p className="note">日時は、先生が入れたときだけ持ちます（書かれていなければ空欄のまま）。{v.category === 'infusion' ? '開始が入ると、経過表に予定の帯が出ます。' : v.category === 'test' ? '予定の日時が入ると、経過表に予定の印が出ます。' : ''}</p>
        </>
      )}
      {v.category === 'infusion' && templates.length > 0 && (
        <label className="field">
          <span className="field-label">スケールのテンプレ（先生が作ったもの）</span>
          <select
            className="input"
            value={v.scale?.templateId ?? ''}
            onChange={(e) => {
              const t = templates.find((x) => x.id === e.target.value);
              set('scale', t === undefined ? null : { templateId: t.id, template: t.body, weightKg: v.scale?.weightKg ?? null, step: null });
            }}
            disabled={busy}
            data-testid="order-template"
          >
            <option value="">使わない</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.body.name}
              </option>
            ))}
            {v.scale !== null && !templates.some((t) => t.id === v.scale?.templateId) && <option value={v.scale.templateId}>{`${v.scale.template.name}（入れたときの中身）`}</option>}
          </select>
        </label>
      )}
      {problem === 'end_before_start' && (
        <p className="alert" role="alert">
          終わりが開始より前になっています。
        </p>
      )}
      <div className="actions">
        <button className="button primary" type="submit" disabled={busy || fields.text.trim() === '' || problem !== null} data-testid="order-submit">
          {submitLabel}
        </button>
        <button className="button" type="button" onClick={onCancel} disabled={busy}>
          やめる
        </button>
      </div>
      <p className="note">打った字は、保存の前に識別情報の選別（AI の 1 回）を通します。記録の文から写した字そのままの欄は、選別を通しません。</p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// スケールの点滴：体重と段、流量の計算（決定論。式を出す。判定しない）

function ScaleBlock({ item, encounterId, onChanged, onLeft }: { item: OrderItem; encounterId: string; onChanged: () => void; onLeft: () => void }) {
  const scale = item.scale;
  const [weight, setWeight] = useState(scale?.weightKg === null || scale === null ? '' : numberText(scale.weightKg));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (scale === null) return null;
  const save = (weightKg: number | null, step: number | null) => {
    setBusy(true);
    setMessage(null);
    void patchOrder(encounterId, item.id, { weightKg, step }).then((r) => {
      setBusy(false);
      if (r.ok) onChanged();
      else if (r.error === 'unregistered') onLeft();
      else setMessage(say(r.error));
    });
  };
  const parsed = weight.trim() === '' ? null : Number(weight.normalize('NFKC'));
  const valid = parsed === null || (Number.isFinite(parsed) && parsed > 0 && parsed <= 500);
  return (
    <div className="scale-block" data-testid="scale-block">
      <span className="part-label">スケール「{scale.template.name}」（入れたときのテンプレの中身）</span>
      <div className="field-row">
        <label className="field">
          <span className="field-label">体重（kg。先生が入れる）</span>
          <input className="input short" inputMode="decimal" value={weight} onChange={(e) => { setWeight(e.target.value); }} disabled={busy} data-testid="scale-weight" />
        </label>
        <label className="field">
          <span className="field-label">いまの段</span>
          <select
            className="input"
            value={scale.step === null ? '' : String(scale.step)}
            onChange={(e) => {
              save(valid ? parsed : scale.weightKg, e.target.value === '' ? null : Number(e.target.value));
            }}
            disabled={busy}
            data-testid="scale-step"
          >
            <option value="">選ばない</option>
            {scale.template.steps.map((s, i) => (
              <option key={i} value={String(i)}>
                {s.label === '' ? `段${String(i + 1)}` : s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions">
        <button className="button small" type="button" disabled={busy || !valid} onClick={() => { save(parsed, scale.step); }} data-testid="scale-save">
          体重を残す
        </button>
      </div>
      {!valid && <p className="alert" role="alert">体重は 0 より大きい数（500 まで）で入れてください。</p>}
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      <ScaleTable scale={scale.template} weightKg={valid ? parsed : null} selected={scale.step} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 指示簿の項目

function OrderRow({ item, record, encounter, onChanged, onLeft }: { item: OrderItem; record: PatientRecord; encounter: Encounter; onChanged: () => void; onLeft: () => void }) {
  const [mode, setMode] = useState<'none' | 'edit' | 'delete'>('none');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = (p: Promise<{ ok: true } | { ok: false; error: ApiError }>) => {
    setBusy(true);
    setMessage(null);
    void p.then((r) => {
      setBusy(false);
      if (r.ok) {
        setMode('none');
        onChanged();
      } else if (r.error === 'unregistered') onLeft();
      else setMessage(say(r.error));
    });
  };
  const link = item.category === 'test' ? record.pending?.body.orders.find((o) => o.orderId === item.id) : undefined;
  const source = item.from === null ? undefined : record.sources.find((s) => s.id === item.from?.sourceId);
  const unseen = item.origin === 'ai' ? item.unseen : [];
  return (
    <li className={item.status === 'stopped' ? 'order-item stopped' : 'order-item'} data-testid="order-item" data-status={item.status}>
      <div className="order-head">
        <span className="order-text" data-testid="order-text">
          <OrderText text={item.text} unseen={unseen} />
        </span>
        <span className="order-tags">
          <span className={item.origin === 'ai' ? 'tag ai-tag' : 'tag'} data-testid="order-origin">
            {ORDER_ORIGIN_NAMES[item.origin]}
            {item.edited ? '・先生が直した' : ''}
          </span>
          {item.status === 'stopped' && (
            <span className="tag" data-testid="order-status">
              {ORDER_STATUS_NAMES.stopped}
              {item.stoppedAt === null ? '' : `（${showDateTime(item.stoppedAt)}）`}
            </span>
          )}
        </span>
      </div>
      <FieldLine v={item} unseen={unseen} />
      {unseen.length > 0 && <p className="note">※ は、資料（記録・テンプレ・臨床支援）に見つからなかった数です（AI の案。消していません）。確かめてください。</p>}
      {item.basis.length > 0 && <p className="row-sub">根拠：{item.basis.map((b) => b.label).join('・')}</p>}
      {source !== undefined && (
        <p className="row-sub">
          写した記載：{SOURCE_KIND_LABELS[source.kind]}・{showDateTime(source.at)}
        </p>
      )}
      {item.scale !== null && <ScaleBlock key={`${item.id}:${String(item.scale.weightKg)}`} item={item} encounterId={encounter.id} onChanged={onChanged} onLeft={onLeft} />}
      {item.category === 'test' &&
        (link !== undefined && link.state === 'resulted' ? (
          <div data-testid="order-results">
            <ResultLinks results={link.results} sources={record.sources} />
            <p className="note">結果の記載は、結果待ちの整理（AI の整理）が、後の記録から結びつけたものです。開いて確かめてください。</p>
          </div>
        ) : (
          <p className="row-sub" data-testid="order-no-result">
            {link === undefined ? '結果の記載との結びつけは、まだしていません（いまのタブの結果待ちを組むときに、一緒に整理します）。' : '結果の記載は、まだ記録に見つかっていません。'}
          </p>
        ))}
      {item.history.length > 1 && (
        <details className="fact-more">
          <summary>直した記録（{String(item.history.length)}）</summary>
          <ul className="row-sub">
            {item.history.map((h, i) => (
              <li key={i}>
                {showDateTime(h.at)} {ORDER_HISTORY_NAMES[h.action]}
              </li>
            ))}
          </ul>
        </details>
      )}
      {mode === 'edit' ? (
        <OrderForm
          initial={fieldsOf(item)}
          templates={record.orderTemplates}
          busy={busy}
          submitLabel="直す"
          onSubmit={(fields) => {
            run(patchOrder(encounter.id, item.id, { fields }));
          }}
          onCancel={() => {
            setMode('none');
          }}
        />
      ) : (
        <div className="chips">
          <button type="button" className="chip small" disabled={busy} onClick={() => { setMode('edit'); }} data-testid="order-edit">
            直す
          </button>
          {item.status === 'active' ? (
            <button type="button" className="chip small" disabled={busy} onClick={() => { run(patchOrder(encounter.id, item.id, { status: 'stopped' })); }} data-testid="order-stop">
              中止する
            </button>
          ) : (
            <button type="button" className="chip small" disabled={busy} onClick={() => { run(patchOrder(encounter.id, item.id, { status: 'active' })); }} data-testid="order-restart">
              再開する
            </button>
          )}
          {mode === 'delete' ? (
            <>
              <button type="button" className="chip small" disabled={busy} onClick={() => { run(deleteOrder(encounter.id, item.id)); }} data-testid="order-delete-confirm">
                入れ間違いとして消す
              </button>
              <button type="button" className="chip small" disabled={busy} onClick={() => { setMode('none'); }}>
                やめる
              </button>
            </>
          ) : (
            <button type="button" className="chip small" disabled={busy} onClick={() => { setMode('delete'); }} data-testid="order-delete">
              消す
            </button>
          )}
        </div>
      )}
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// 写した項目・AI の案（画面のメモリだけ。1つずつ入れる）

function ProposalCard({
  p,
  record,
  already,
  busy,
  onAdopt,
  onDrop,
}: {
  p: OrderProposal;
  record: PatientRecord;
  already: boolean;
  busy: boolean;
  onAdopt: (fields: OrderFields) => void;
  onDrop: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="order-item proposal" data-testid="order-proposal">
      <div className="order-head">
        <span className="order-text" data-testid="proposal-text">
          <OrderText text={p.text} unseen={p.unseen} />
        </span>
        <span className="order-tags">
          <span className="tag">{ORDER_CATEGORY_SHORT[p.category]}</span>
          <span className={p.origin === 'ai' ? 'tag ai-tag' : 'tag'}>{ORDER_ORIGIN_NAMES[p.origin]}</span>
          {already && <span className="tag">入れ済み</span>}
        </span>
      </div>
      <FieldLine v={{ ...fieldsOfProposal(p) }} unseen={p.unseen} />
      {p.unseen.length > 0 && <p className="note" data-testid="proposal-unseen">※ は、資料（記録・テンプレ・臨床支援）に見つからなかった数です。確かめてから入れてください。</p>}
      {p.basis.length > 0 && <p className="row-sub">根拠：{p.basis.map((b) => b.label).join('・')}</p>}
      {p.scale !== null && (
        <p className="row-sub">
          スケール「{p.scale.template.name}」を使う案です。流量は、入れた後に体重を入れると carte が計算します（AI は計算していません）。
        </p>
      )}
      {p.from !== null && (
        <p className="row-sub">
          元の字：{(() => {
            const s = record.sources.find((x) => x.id === p.from?.sourceId);
            return s === undefined ? '' : `${SOURCE_KIND_LABELS[s.kind]}・${showDateTime(s.at)}`;
          })()}
        </p>
      )}
      {editing ? (
        <OrderForm
          initial={fieldsOfProposal(p)}
          templates={record.orderTemplates}
          busy={busy}
          submitLabel="直して入れる"
          onSubmit={(fields) => {
            onAdopt(fields);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : (
        <div className="chips">
          <button type="button" className="chip small" disabled={busy} onClick={() => { onAdopt(fieldsOfProposal(p)); }} data-testid="proposal-adopt">
            入れる
          </button>
          <button type="button" className="chip small" disabled={busy} onClick={() => { setEditing(true); }} data-testid="proposal-edit">
            直してから入れる（日時もここで）
          </button>
          <button type="button" className="chip small" disabled={busy} onClick={onDrop} data-testid="proposal-drop">
            入れない
          </button>
        </div>
      )}
    </li>
  );
}

function countsText(counts: OrderProposals['counts']): string {
  const names: Readonly<Record<string, string>> = { ...TRANSCRIBE_REJECT_NAMES, ...PROPOSE_REJECT_NAMES };
  const rejected = Object.entries(counts.rejected)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${names[k] ?? k} ${String(n)} 件`);
  return [
    counts.notOrder > 0 ? `指示ではないと分けた字 ${String(counts.notOrder)} 件は出していません。` : '',
    counts.cleared > 0 ? `引用の外の字だった欄 ${String(counts.cleared)} 件は空にしました。` : '',
    counts.shapes > 0 ? `識別情報の形 ${String(counts.shapes)} 件を伏せました。` : '',
    rejected.length > 0 ? `確かめで通らなかったもの：${rejected.join('・')}。` : '',
  ].join('');
}

// ---------------------------------------------------------------------------
// 指示簿の画面

type Mode = 'none' | 'transcribe' | 'propose' | 'template' | 'add' | 'templates';

export function OrdersView({ record, encounter, onChanged, onLeft }: { record: PatientRecord; encounter: Encounter; onChanged: () => void; onLeft: () => void }) {
  const [mode, setMode] = useState<Mode>('none');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 写した項目・案（画面のメモリだけ）
  const [proposals, setProposals] = useState<{ list: readonly OrderProposal[]; counts: OrderProposals['counts']; kind: 'transcribe' | 'propose' } | null>(null);
  const sources = record.sources.filter((s) => s.encounterId === encounter.id).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || b.id.localeCompare(a.id));
  const [sourceId, setSourceId] = useState<string>('');
  const [cats, setCats] = useState<ReadonlySet<OrderCategory>>(new Set());
  const [templateId, setTemplateId] = useState<string>('');
  const items = record.orders.find((s) => s.encounterId === encounter.id)?.items ?? [];
  const latest = record.encounters.at(-1)?.id === encounter.id;

  const fail = (error: ApiError) => {
    if (error === 'unregistered') onLeft();
    else setMessage(say(error));
  };
  const toggleMode = (m: Mode) => {
    setMode(mode === m ? 'none' : m);
    setMessage(null);
  };
  const transcribe = () => {
    const id = sourceId === '' ? (sources[0]?.id ?? '') : sourceId;
    if (id === '') return;
    setBusy(true);
    setMessage(null);
    void transcribeOrders(encounter.id, id).then((r) => {
      setBusy(false);
      if (r.ok) {
        setProposals({ list: r.value.proposals, counts: r.value.counts, kind: 'transcribe' });
        setMode('none');
      } else fail(r.error);
    });
  };
  const propose = () => {
    setBusy(true);
    setMessage(null);
    void proposeOrders(encounter.id, [...cats]).then((r) => {
      setBusy(false);
      if (r.ok) {
        setProposals({ list: r.value.proposals, counts: r.value.counts, kind: 'propose' });
        setMode('none');
      } else fail(r.error);
    });
  };
  const add = (list: readonly OrderNew[], after: () => void) => {
    setBusy(true);
    setMessage(null);
    void addOrders(encounter.id, list).then((r) => {
      setBusy(false);
      if (r.ok) {
        after();
        onChanged();
      } else fail(r.error);
    });
  };
  const adopt = (p: OrderProposal, fields: OrderFields) => {
    add([newOf(fields, p)], () => {
      // 入れた案は一覧から外す。すべて入れ終えたら、案の欄を閉じる
      setProposals((cur) => {
        const list = cur === null ? [] : cur.list.filter((x) => x.key !== p.key);
        return cur === null || list.length === 0 ? null : { ...cur, list };
      });
    });
  };
  const already = (p: OrderProposal): boolean =>
    p.from !== null ? items.some((i) => i.from !== null && i.from.sourceId === p.from?.sourceId && i.from.start === p.from.start) : items.some((i) => i.status === 'active' && i.category === p.category && i.text === p.text);
  const template = record.orderTemplates.find((t) => t.id === templateId) ?? record.orderTemplates[0];

  const sheet = itemsByCategory(items);
  const groups = sheet.filter((g) => SHEET_CATEGORIES.includes(g.category));
  const infusions = sheet.find((g) => g.category === 'infusion')?.items ?? [];
  const activeCount = items.filter((i) => i.status === 'active').length;

  return (
    <div className="orders" data-testid="orders">
      <h3 className="sub-title">指示簿（{String(activeCount)} 件が指示中）</h3>
      <p className="note">carte の中の指示簿（写しと組み立て）です。病院のカルテ・指示簿へは、先生が打ち直してください（コピーのボタンはありません）。AI の案・写した項目は、先生が1つずつ「入れる」まで入りません。</p>
      <div className="chips" role="group" aria-label="入れ方">
        <button type="button" className={mode === 'transcribe' ? 'chip on' : 'chip'} aria-pressed={mode === 'transcribe'} onClick={() => { toggleMode('transcribe'); }} disabled={sources.length === 0} data-testid="orders-transcribe-open">
          記録の文から写す
        </button>
        <button type="button" className={mode === 'propose' ? 'chip on' : 'chip'} aria-pressed={mode === 'propose'} onClick={() => { toggleMode('propose'); }} disabled={!latest} data-testid="orders-propose-open">
          AI の案を出す
        </button>
        <button type="button" className={mode === 'template' ? 'chip on' : 'chip'} aria-pressed={mode === 'template'} onClick={() => { toggleMode('template'); }} disabled={record.orderTemplates.length === 0} data-testid="orders-template-open">
          テンプレから入れる
        </button>
        <button type="button" className={mode === 'add' ? 'chip on' : 'chip'} aria-pressed={mode === 'add'} onClick={() => { toggleMode('add'); }} data-testid="orders-add-open">
          手で足す
        </button>
        <button type="button" className={mode === 'templates' ? 'chip on' : 'chip'} aria-pressed={mode === 'templates'} onClick={() => { toggleMode('templates'); }} data-testid="orders-templates-open">
          テンプレを作る・直す
        </button>
      </div>
      {mode === 'transcribe' && (
        <div className="form" data-testid="orders-transcribe-panel">
          <label className="field">
            <span className="field-label">写す記載（この受診の、保存した記載）</span>
            <select className="input" value={sourceId === '' ? (sources[0]?.id ?? '') : sourceId} onChange={(e) => { setSourceId(e.target.value); }} disabled={busy} data-testid="orders-source">
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {`${SOURCE_KIND_LABELS[s.kind]}・${showDateTime(s.at)}・${s.text.replace(/\s+/gu, ' ').slice(0, 24)}`}
                </option>
              ))}
            </select>
          </label>
          <p className="note">AI が、その記載の中の指示を欄に分けます（AI の 1 回）。項目の字は記録の字のままで、AI は文を書きません。記録の字に見つからない引用は出しません。</p>
          <div className="actions">
            <button className="button primary" type="button" onClick={transcribe} disabled={busy} data-testid="orders-transcribe">
              {busy ? '分けています…' : '写す'}
            </button>
          </div>
        </div>
      )}
      {mode === 'propose' && (
        <div className="form" data-testid="orders-propose-panel">
          <span className="field-label">頼む欄（選ばなければ、すべての欄）</span>
          <div className="chips">
            {ORDER_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={cats.has(c) ? 'chip small on' : 'chip small'}
                aria-pressed={cats.has(c)}
                onClick={() => {
                  const next = new Set(cats);
                  if (next.has(c)) next.delete(c);
                  else next.add(c);
                  setCats(next);
                }}
                data-testid={`orders-propose-cat-${c}`}
              >
                {ORDER_CATEGORY_SHORT[c]}
              </button>
            ))}
          </div>
          <p className="note">記録・AI のプロブレムリスト・AI の臨床支援・先生のテンプレから、AI が欄ごとの案を書きます（AI の 1 回）。用量を含むことがあります。資料にない数には※が付きます。スケールの流量は AI に計算させず、carte が計算します。</p>
          <div className="actions">
            <button className="button primary" type="button" onClick={propose} disabled={busy} data-testid="orders-propose">
              {busy ? '案を書いています…' : '案を出す'}
            </button>
          </div>
        </div>
      )}
      {mode === 'template' && template !== undefined && (
        <TemplateInsert
          templates={record.orderTemplates}
          selected={template.id}
          onSelect={setTemplateId}
          busy={busy}
          onInsert={(fields) => {
            add([newOf(fields, null)], () => {
              setMode('none');
            });
          }}
        />
      )}
      {mode === 'add' && (
        <OrderForm
          initial={emptyFields('rest')}
          templates={record.orderTemplates}
          busy={busy}
          submitLabel="指示簿に入れる"
          onSubmit={(fields) => {
            add([newOf(fields, null)], () => {
              setMode('none');
            });
          }}
          onCancel={() => {
            setMode('none');
          }}
        />
      )}
      {mode === 'templates' && <OrderTemplates templates={record.orderTemplates} onChanged={onChanged} onLeft={onLeft} />}
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}

      {proposals !== null && (
        <section className="state-section order-proposals" data-testid="order-proposals" aria-labelledby="order-proposals-title">
          <div className="plist-head">
            <h4 id="order-proposals-title" className="sub-title">
              {proposals.kind === 'transcribe' ? '記録の文から写した項目' : 'AI の案'}（まだ指示簿に入っていません）
            </h4>
            <button type="button" className="button small" onClick={() => { setProposals(null); }} data-testid="proposals-close">
              閉じる
            </button>
          </div>
          {proposals.list.length === 0 && <p className="note">入れられる項目はありませんでした。</p>}
          <ul className="order-list">
            {proposals.list.map((p) => (
              <ProposalCard
                key={p.key}
                p={p}
                record={record}
                already={already(p)}
                busy={busy}
                onAdopt={(fields) => {
                  adopt(p, fields);
                }}
                onDrop={() => {
                  const list = proposals.list.filter((x) => x.key !== p.key);
                  setProposals(list.length === 0 ? null : { ...proposals, list });
                }}
              />
            ))}
          </ul>
          {countsText(proposals.counts) !== '' && (
            <p className="note" data-testid="proposal-counts">
              {countsText(proposals.counts)}
            </p>
          )}
        </section>
      )}

      {items.length === 0 && <p className="note">この受診の指示簿は、まだ空です。</p>}
      {groups.map((g) => (
        <section key={g.category} className="order-section" data-testid={`order-section-${g.category}`}>
          <h4 className="order-cat">{ORDER_CATEGORY_NAMES[g.category]}</h4>
          <ul className="order-list">
            {g.items.map((item) => (
              <OrderRow key={item.id} item={item} record={record} encounter={encounter} onChanged={onChanged} onLeft={onLeft} />
            ))}
          </ul>
        </section>
      ))}
      <section className="order-section infusions" data-testid="order-infusions">
        <h4 className="order-cat">{ORDER_CATEGORY_NAMES.infusion}（別の欄）</h4>
        {infusions.length === 0 ? (
          <p className="note">点滴の指示は、まだありません。</p>
        ) : (
          <ul className="order-list">
            {infusions.map((item) => (
              <OrderRow key={item.id} item={item} record={record} encounter={encounter} onChanged={onChanged} onLeft={onLeft} />
            ))}
          </ul>
        )}
        <p className="note">開始の日時が入った点滴は、経過表に「点滴の予定（指示簿）」の帯として出ます（記録の投薬の帯とは分けています）。</p>
      </section>
    </div>
  );
}

/** テンプレから入れる：テンプレを選び、開始の日時を入れて、点滴の欄に入れる（体重・段は入れた後に） */
function TemplateInsert({ templates, selected, onSelect, busy, onInsert }: { templates: readonly ScaleTemplate[]; selected: string; onSelect: (id: string) => void; busy: boolean; onInsert: (fields: OrderFields) => void }) {
  const t = templates.find((x) => x.id === selected) ?? templates[0];
  const [start, setStart] = useState({ day: '', time: '' });
  if (t === undefined) return null;
  const fields: OrderFields = {
    ...emptyFields('infusion'),
    text: `${t.body.drug === '' ? t.body.name : t.body.drug}（スケール「${t.body.name}」に従う）`,
    drug: t.body.drug,
    start: start.day === '' ? null : joinDateTime(start.day, start.time),
    scale: { templateId: t.id, template: t.body, weightKg: null, step: null },
  };
  return (
    <div className="form" data-testid="orders-template-panel">
      <label className="field">
        <span className="field-label">テンプレ</span>
        <select className="input" value={t.id} onChange={(e) => { onSelect(e.target.value); }} disabled={busy} data-testid="orders-template-pick">
          {templates.map((x) => (
            <option key={x.id} value={x.id}>
              {x.body.name}
            </option>
          ))}
        </select>
      </label>
      <ScaleTable scale={t.body} weightKg={null} selected={null} />
      <div className="field-row">
        <label className="field">
          <span className="field-label">開始の日（分かれば）</span>
          <input className="input" type="date" value={start.day} onChange={(e) => { setStart({ ...start, day: e.target.value }); }} disabled={busy} data-testid="orders-template-day" />
        </label>
        <label className="field">
          <span className="field-label">時刻</span>
          <input className="input" type="time" value={start.time} onChange={(e) => { setStart({ ...start, time: e.target.value }); }} disabled={busy} data-testid="orders-template-time" />
        </label>
      </div>
      <div className="actions">
        <button className="button primary" type="button" disabled={busy} onClick={() => { onInsert(fields); }} data-testid="orders-template-insert">
          点滴の欄に入れる
        </button>
      </div>
      <p className="note">入れた後に、体重といまの段を選ぶと、流量を計算して出します。</p>
    </div>
  );
}

/** いまのタブ：この受診の、指示中の項目（欄ごと。点滴は別） */
export function OrdersSummary({ record, encounter, onOpen }: { record: PatientRecord; encounter: Encounter; onOpen: () => void }) {
  const items = (record.orders.find((s) => s.encounterId === encounter.id)?.items ?? []).filter((i) => i.status === 'active');
  if (items.length === 0) return null;
  const groups = itemsByCategory(items);
  return (
    <section className="state-section orders-summary" data-testid="orders-summary" aria-labelledby="orders-summary-title">
      <div className="plist-head">
        <h3 id="orders-summary-title" className="sub-title with-icon">
          <Icon name="orders" />
          指示中の指示簿（{String(items.length)}）
        </h3>
        <button type="button" className="button small" onClick={onOpen} data-testid="orders-summary-open">
          指示簿を開く
        </button>
      </div>
      <ul className="orders-summary-list">
        {groups.map((g) => (
          <li key={g.category} data-testid="orders-summary-row">
            <span className="tag">{ORDER_CATEGORY_SHORT[g.category]}</span> {g.items.map((i) => `${orderLabel(i)}${i.origin === 'ai' ? '（AI の案）' : ''}`).join('・')}
          </li>
        ))}
      </ul>
      <p className="note">carte に入れた指示の要約です（病院の指示簿の最新とは限りません）。</p>
    </section>
  );
}
