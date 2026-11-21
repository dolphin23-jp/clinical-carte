// 記載を直す（CA-029）：種類・日時・書いた人（選ぶ）、区切りの見出し（選ぶ）、文をなぞって足す（打たない）、
// 文を打ち直す（C-1：サーバーで選別を通す。AI の1回。続けて整理し直す）。どれも、直した記録が残る。
import {
  ADD_TYPES,
  type AddFact,
  type AddType,
  AUTHOR_ROLE_LABELS,
  AUTHOR_ROLES,
  type AuthorRole,
  EVENT_KIND_NAMES,
  EVENT_KINDS,
  type EventKind,
  MEDICATION_ACTION_NAMES,
  MEDICATION_ACTIONS,
  type MedicationAction,
  PROBLEM_STATUS_NAMES,
  PROBLEM_STATUSES,
  type ProblemStatus,
  SEGMENT_LABEL_NAMES,
  SEGMENT_LABELS,
  type SegmentLabel,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  type SourceKind,
  TEXT_LIMIT,
  USER_EDIT_FIELD_NAMES,
} from '@clinical-carte/core';
import { useRef, useState } from 'react';

import { joinDateTime, showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { addFact, organizeSource, patchSegment, patchSource, type Result, retypeSource, type Segment, type Source, type UserEdit } from './net/api.ts';

const ADD_NAMES: Readonly<Record<AddType, string>> = { problem: '問題', medication: '投薬', event: 'できごと', observation: '値', segment: 'ここから区切り' };

export function SourceEdit({ source, segments, edits, onChanged, onLeft }: { source: Source; segments: readonly Segment[]; edits: readonly UserEdit[]; onChanged: () => void; onLeft: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [day, setDay] = useState(source.at?.slice(0, 10) ?? '');
  const [time, setTime] = useState(source.at !== null && source.at.length > 10 ? source.at.slice(11, 16) : '');

  const run = (action: () => Promise<Result<unknown>>, done?: string) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    void action().then((r) => {
      setBusy(false);
      if (!r.ok) {
        if (r.error === 'unregistered') onLeft();
        else setMessage(errorMessage(r.error));
      } else if (done !== undefined) setMessage(done);
      onChanged();
    });
  };
  const mine = edits.filter((e) => e.target === source.id || segments.some((g) => g.id === e.target));

  return (
    <details className="source-edit" data-testid="source-edit">
      <summary>この記載を直す・足す</summary>
      {message !== null && (
        <p className="note" role="status" data-testid="source-edit-message">
          {message}
        </p>
      )}

      <div className="form">
        <div className="field-row">
          <label className="field">
            <span className="field-label">種類</span>
            <select className="input" value={source.kind} disabled={busy} onChange={(e) => { run(() => patchSource(source.id, { kind: e.target.value as SourceKind })); }} data-testid="source-kind">
              {SOURCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SOURCE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">書いた人</span>
            <select className="input" value={source.authorRole} disabled={busy} onChange={(e) => { run(() => patchSource(source.id, { authorRole: e.target.value as AuthorRole })); }} data-testid="source-author">
              {AUTHOR_ROLES.map((r) => (
                <option key={r} value={r}>
                  {AUTHOR_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          <span className="field-label">記載の日時</span>
          <div className="field-row">
            <input className="input compact" type="date" aria-label="日" value={day} disabled={busy} onChange={(e) => { setDay(e.target.value); }} data-testid="source-day" />
            <input className="input compact" type="time" aria-label="時刻" value={time} disabled={busy || day === ''} onChange={(e) => { setTime(e.target.value); }} data-testid="source-time" />
            <button
              type="button"
              className="button small"
              disabled={busy || (day === '' ? source.at === null : joinDateTime(day, time) === source.at)}
              onClick={() => {
                run(() => patchSource(source.id, { at: day === '' ? null : joinDateTime(day, time) }));
              }}
              data-testid="source-at"
            >
              日時を直す
            </button>
          </div>
        </div>

        {segments.length > 0 && (
          <div className="field">
            <span className="field-label">区切りの見出し</span>
            <ul className="fact-list">
              {[...segments]
                .sort((a, b) => a.start - b.start)
                .map((g) => (
                  <li key={g.id} className="fact-row" data-testid="segment-row">
                    <span className="fact-main">
                      「{source.text.slice(g.start, Math.min(g.end, g.start + 16)).trim()}…」
                      {g.edited && <span className="tag">直した</span>}
                    </span>
                    <span className="fact-controls">
                      <select className="input compact" aria-label="見出し" value={g.label} disabled={busy} onChange={(e) => { run(() => patchSegment(g.id, { label: e.target.value as SegmentLabel })); }} data-testid="segment-label-select">
                        {SEGMENT_LABELS.map((l) => (
                          <option key={l} value={l}>
                            {SEGMENT_LABEL_NAMES[l]}
                          </option>
                        ))}
                      </select>
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}

        <Picker
          source={source}
          busy={busy}
          onAdd={(add) => {
            run(() => addFact(source.id, add), `${ADD_NAMES[add.type]}として足しました。`);
          }}
        />

        {/* 保存した文が変わったら、欄を作り直す（打った文〔紛れた名前を含みうる〕を、画面に残さない） */}
        <Retype
          key={source.text}
          source={source}
          busy={busy}
          onRetype={(text) => {
            run(async () => {
              const r = await retypeSource(source.id, text);
              if (!r.ok) return r;
              // 打ち直した文を、続けて整理し直す（整理に失敗しても、文は保存されている）
              const organized = await organizeSource(source.id);
              const lost = r.value.lost > 0 ? `前の文で直した・足したもののうち ${String(r.value.lost)} 件は、新しい文に同じ字がなく、引き継げませんでした。` : '';
              setMessage(organized.ok ? `文を直し、整理し直しました。${lost}` : `文を直しました（整理できなかったので、「整理する」で、もう一度整理できます）。${lost}`);
              return { ok: true as const, value: null };
            });
          }}
        />

        {mine.length > 0 && (
          <div className="fact-edits" data-testid="source-edits">
            <span className="field-label">直した記録（{String(mine.length)}）</span>
            <ul className="fact-list">
              {mine.map((e) => (
                <li key={e.id} className="fact-row">
                  <span className="fact-when">{showDateTime(e.at)}</span>
                  <span className="fact-main">
                    {USER_EDIT_FIELD_NAMES[e.field]}
                    {e.field !== 'text' && e.after !== null && `：${editLabel(e)}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function editLabel(e: UserEdit): string {
  const v = e.after ?? '';
  const pick = (names: Readonly<Record<string, string>>): string => (Object.hasOwn(names, v) ? (names[v] ?? v) : v);
  if (e.field === 'kind') return pick(SOURCE_KIND_LABELS);
  if (e.field === 'author_role') return pick(AUTHOR_ROLE_LABELS);
  if (e.field === 'label') return pick(SEGMENT_LABEL_NAMES);
  if (e.field === 'at') return showDateTime(v);
  if (e.field === 'added') return pick(ADD_NAMES);
  return v;
}

/** 文をなぞって足す：選んだ範囲（文の中の場所）を、問題・投薬・できごと・値・区切りとして足す。字は打たない */
function Picker({ source, busy, onAdd }: { source: Source; busy: boolean; onAdd: (add: AddFact) => void }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [type, setType] = useState<AddType>('problem');
  const [status, setStatus] = useState<ProblemStatus>('problem');
  const [action, setAction] = useState<MedicationAction | ''>('');
  const [kind, setKind] = useState<EventKind>('test');
  const [label, setLabel] = useState<SegmentLabel>('assessment');

  /** 画面で選んだ範囲を、文の中の場所にする（文は1つの字の並びとして出してあるので、位置がそのまま場所） */
  const capture = () => {
    const sel = document.getSelection();
    const node = ref.current?.firstChild;
    if (sel === null || node === null || node === undefined || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    if (r.startContainer !== node || r.endContainer !== node) return;
    const start = Math.min(r.startOffset, r.endOffset);
    const end = Math.max(r.startOffset, r.endOffset);
    setRange({ start, end: type === 'segment' ? start + 1 : end });
  };
  const nudge = (which: 'start' | 'end', d: number) => {
    if (range === null) return;
    const next = { ...range, [which]: Math.max(0, Math.min(source.text.length, range[which] + d)) };
    if (next.start < next.end) setRange(next);
  };
  const submit = () => {
    if (range === null) return;
    const span = { start: range.start, end: range.end };
    if (type === 'segment') onAdd({ type, start: range.start, label });
    else if (type === 'problem') onAdd({ type, ...span, status });
    else if (type === 'medication') onAdd({ type, ...span, action: action === '' ? null : action });
    else if (type === 'event') onAdd({ type, ...span, kind });
    else onAdd({ type, ...span });
    setRange(null);
  };

  return (
    <details className="picker" data-testid="picker">
      <summary>文をなぞって足す（AI が拾わなかったもの）</summary>
      <p className="note">下の文の一部を指でなぞって選び、「選んだ範囲にする」を押します。区切りは、始めたい場所の1字を選びます。</p>
      <p className="pick-text" ref={ref} data-testid="pick-text" onMouseUp={capture} onTouchEnd={capture}>
        {source.text}
      </p>
      <button type="button" className="button small" disabled={busy} onClick={capture} data-testid="pick-capture">
        選んだ範囲にする
      </button>
      {range !== null && (
        <div className="pick-chosen" data-testid="pick-chosen">
          <span className="field-label">選んだ字</span>
          <strong className="pick-quote" data-testid="pick-quote">
            {type === 'segment' ? `ここから：「${source.text.slice(range.start, range.start + 12)}…」` : source.text.slice(range.start, range.end)}
          </strong>
          {type !== 'segment' && (
            <div className="field-row">
              <button type="button" className="button small" onClick={() => { nudge('start', -1); }}>始まりを1字前へ</button>
              <button type="button" className="button small" onClick={() => { nudge('start', 1); }}>始まりを1字後へ</button>
              <button type="button" className="button small" onClick={() => { nudge('end', -1); }}>終わりを1字前へ</button>
              <button type="button" className="button small" onClick={() => { nudge('end', 1); }}>終わりを1字後へ</button>
            </div>
          )}
        </div>
      )}
      <div className="field-row">
        <select className="input compact" aria-label="何として足すか" value={type} disabled={busy} onChange={(e) => { setType(e.target.value as AddType); }} data-testid="pick-type">
          {ADD_TYPES.map((t) => (
            <option key={t} value={t}>
              {ADD_NAMES[t]}
            </option>
          ))}
        </select>
        {type === 'problem' && (
          <select className="input compact" aria-label="確からしさ" value={status} onChange={(e) => { setStatus(e.target.value as ProblemStatus); }} data-testid="pick-status">
            {PROBLEM_STATUSES.map((st) => (
              <option key={st} value={st}>
                {PROBLEM_STATUS_NAMES[st]}
              </option>
            ))}
          </select>
        )}
        {type === 'medication' && (
          <select className="input compact" aria-label="投薬の動き" value={action} onChange={(e) => { setAction(e.target.value as MedicationAction | ''); }} data-testid="pick-action">
            <option value="">動きの記載なし</option>
            {MEDICATION_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {MEDICATION_ACTION_NAMES[a]}
              </option>
            ))}
          </select>
        )}
        {type === 'event' && (
          <select className="input compact" aria-label="できごとの種類" value={kind} onChange={(e) => { setKind(e.target.value as EventKind); }} data-testid="pick-kind">
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {EVENT_KIND_NAMES[k]}
              </option>
            ))}
          </select>
        )}
        {type === 'segment' && (
          <select className="input compact" aria-label="区切りの見出し" value={label} onChange={(e) => { setLabel(e.target.value as SegmentLabel); }} data-testid="pick-label">
            {SEGMENT_LABELS.map((l) => (
              <option key={l} value={l}>
                {SEGMENT_LABEL_NAMES[l]}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="button small primary" disabled={busy || range === null} onClick={submit} data-testid="pick-add">
          足す
        </button>
      </div>
    </details>
  );
}

/** 文を打ち直す（C-1）：入れるときと同じ選別を通す */
function Retype({ source, busy, onRetype }: { source: Source; busy: boolean; onRetype: (text: string) => void }) {
  const [text, setText] = useState(source.text);
  return (
    <details className="picker" data-testid="retype">
      <summary>文を打ち直す（打ち間違い・紛れた名前を消す）</summary>
      <p className="note">
        直した文は、入れるときと同じく AI の選別（氏名などの置き換え）を通してから保存し、続けて整理し直します（AI の2回）。前の文は残りません。先生が足した・直したものは、新しい文に同じ字があれば引き継ぎます。
      </p>
      <textarea className="input area" value={text} maxLength={TEXT_LIMIT} disabled={busy} onChange={(e) => { setText(e.target.value); }} data-testid="retype-text" />
      <button type="button" className="button small primary" disabled={busy || text.trim() === '' || text === source.text} onClick={() => { onRetype(text); }} data-testid="retype-save">
        直した文を保存する
      </button>
    </details>
  );
}
