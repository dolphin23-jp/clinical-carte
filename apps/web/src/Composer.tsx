// 文を入れる（docs/00 の 5）。先に患者と受診を選んである（CA-015）。どの患者に入るかを、送るボタンのすぐ上に出す。
// 送った文は、サーバーで AI の選別と置き換えを通ったものだけが保存される。通らなければ、打った文は、この欄に残る。
// 手軽にするための部品：種類・書いた人・日時のチップ、見出しのひな形、バイタル・検査値の入力欄（欄の値から文を作り、文の欄に入れる。送る文は、いつも文の欄の文）。
import {
  AUTHOR_ROLE_LABELS,
  AUTHOR_ROLES,
  type AuthorRole,
  READ_VALUES_KINDS,
  readLabText,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  type SourceKind,
  TEXT_LIMIT,
  whenCandidates,
} from '@clinical-carte/core';
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';

import { joinDateTime, nowLocal, replacedSummary, showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { addSource, type Observation, organizeSource, type Source } from './net/api.ts';
import { organizeSummary } from './organizeText.ts';
import { QuickValues } from './QuickValues.tsx';
import { COMMON_KINDS, insertAt, KIND_CHIP_LABELS, TEMPLATES } from './templates.ts';

/** 端末の日付から、n 日前の日（YYYY-MM-DD） */
function dayBefore(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const two = (v: number): string => String(v).padStart(2, '0');
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function Composer({
  encounterId,
  target,
  onSaved,
  onLeft,
}: {
  encounterId: string;
  target: string;
  onSaved: (source?: Source, observations?: readonly Observation[]) => void;
  onLeft: () => void;
}) {
  const [kind, setKind] = useState<SourceKind>('progress_note');
  const [authorRole, setAuthorRole] = useState<AuthorRole>('self');
  // 時刻は、はじめは空（日だけ）。画面を開いた時刻を既定にすると、あとで写した記載が、みな同じ時刻になる（写す時刻は、記載の時刻ではない）。
  // 保存のたびにも、時刻を空に戻す（前の記載の時刻を、黙って次の記載に使わない）
  const [day, setDay] = useState(() => nowLocal().day);
  const [time, setTime] = useState('');
  const [unknownTime, setUnknownTime] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** 保存のあとの整理（段2）の知らせ */
  const [organizing, setOrganizing] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const readsValues = READ_VALUES_KINDS.includes(kind);
  const tooLong = text.length > TEXT_LIMIT;
  const ready = text.trim() !== '' && !tooLong && (unknownTime || day !== '');
  const templates = TEMPLATES[kind] ?? [];
  /** 文に書かれた日時（選ぶ手がかり。自動では使わない） */
  const candidates = text.trim() === '' ? [] : whenCandidates(text, { refDay: day === '' ? nowLocal().day : day, encounterStart: null });
  const chosen = unknownTime ? null : joinDateTime(day, time);

  /** 文の欄の、カーソルの位置に差し込む */
  const insert = (snippet: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = insertAt(text, start, end, snippet);
    setText(next.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const setWhen = (which: 'now' | 'today' | 'yesterday') => {
    setUnknownTime(false);
    if (which === 'now') {
      const now = nowLocal();
      setDay(now.day);
      setTime(now.time);
    } else {
      setDay(dayBefore(which === 'today' ? 0 : 1));
      setTime('');
    }
  };

  /** 文に時刻の候補があるのに、時刻なし（日だけ）で送ろうとしたとき：送る前に確かめる（2026-11-21 の本人の決定） */
  const timedCandidates = candidates.filter((c) => c.length > 10);
  const needsDayOnlyCheck = !unknownTime && time === '' && timedCandidates.length > 0;
  const [askDayOnly, setAskDayOnly] = useState(false);
  useEffect(() => {
    setAskDayOnly(false);
  }, [text, time, unknownTime]);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || !ready) return;
    if (needsDayOnlyCheck && !askDayOnly) {
      setAskDayOnly(true);
      return;
    }
    send();
  };

  const send = () => {
    if (busy || !ready) return;
    setAskDayOnly(false);
    setBusy(true);
    setMessage(null);
    setDone(null);
    setOrganizing(null);
    void addSource(encounterId, { kind, authorRole, at: unknownTime ? null : joinDateTime(day, time), text }).then((result) => {
      setBusy(false);
      if (!result.ok) {
        // 打った文は、欄に残す（もう一度送れる）
        if (result.error === 'unregistered') onLeft();
        else setMessage(errorMessage(result.error));
        return;
      }
      const { source, observations } = result.value;
      const replaced = replacedSummary(source.replaced);
      const parts = ['保存しました。'];
      if (replaced !== null) parts.push(`置き換えた場所：${replaced}。`);
      if (readsValues) {
        const unread = readLabText(source.text).unread.length;
        parts.push(`読んだ値 ${String(observations.length)} 件${unread > 0 ? `、読めなかった部分 ${String(unread)} か所（文には残っています）` : ''}。`);
      }
      setDone(parts.join(''));
      setText('');
      setTime('');
      setUnknownTime(false);
      onSaved(source, observations);
      // 続けて整理する（段2）。整理に失敗しても、文は保存されている
      setOrganizing('整理しています…（30 秒ほどかかることがあります）');
      void organizeSource(source.id).then((organized) => {
        if (organized.ok) setOrganizing(organizeSummary(organized.value));
        else if (organized.error === 'unregistered') onLeft();
        else setOrganizing(`整理できませんでした（${errorMessage(organized.error).replace('文は保存していません。', '')}）。文は保存してあります。あとで、記録の「整理する」を押せます。`);
        onSaved();
      });
    });
  };

  return (
    <form className="form" onSubmit={submit} data-testid="composer">
      <fieldset className="field">
        <legend className="field-label">種類</legend>
        <div className="chips" role="radiogroup" aria-label="種類">
          {COMMON_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              className={kind === k ? 'chip on' : 'chip'}
              onClick={() => {
                setKind(k);
              }}
              disabled={busy}
              data-testid={`kind-chip-${k}`}
            >
              {KIND_CHIP_LABELS[k] ?? SOURCE_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <label className="inline-select">
          <span className="note">ほかの種類</span>
          <select
            className="input compact"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as SourceKind);
            }}
            disabled={busy}
            data-testid="kind"
          >
            {SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {SOURCE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="field">
        <legend className="field-label">書いた人</legend>
        <div className="chips" role="radiogroup" aria-label="書いた人">
          {AUTHOR_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={authorRole === r}
              className={authorRole === r ? 'chip small on' : 'chip small'}
              onClick={() => {
                setAuthorRole(r);
              }}
              disabled={busy}
              data-testid={`author-chip-${r}`}
            >
              {AUTHOR_ROLE_LABELS[r]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend className="field-label">記載・測定の日時</legend>
        <div className="chips">
          <button type="button" className="chip small" onClick={() => { setWhen('now'); }} disabled={busy} data-testid="when-now">
            今
          </button>
          <button type="button" className="chip small" onClick={() => { setWhen('today'); }} disabled={busy} data-testid="when-today">
            今日（時刻なし）
          </button>
          <button type="button" className="chip small" onClick={() => { setWhen('yesterday'); }} disabled={busy} data-testid="when-yesterday">
            昨日
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={unknownTime}
            className={unknownTime ? 'chip small on' : 'chip small'}
            onClick={() => {
              setUnknownTime(!unknownTime);
            }}
            disabled={busy}
            data-testid="when-unknown"
          >
            日時不明
          </button>
        </div>
        {candidates.length > 0 && (
          <div className="chips" aria-label="文に書かれた日時" data-testid="when-candidates">
            <span className="note">文に書かれた日時：</span>
            {candidates.map((c, i) => (
              <button
                key={c}
                type="button"
                className={chosen === c ? 'chip small on' : 'chip small outline'}
                aria-pressed={chosen === c}
                onClick={() => {
                  setUnknownTime(false);
                  setDay(c.slice(0, 10));
                  setTime(c.length > 10 ? c.slice(11, 16) : '');
                }}
                disabled={busy}
                data-testid={`when-candidate-${String(i)}`}
              >
                {showDateTime(c)}
              </button>
            ))}
          </div>
        )}
        <div className="field-row">
          <label className="field">
            <span className="sr-only">日</span>
            <input className="input" type="date" value={day} onChange={(e) => { setDay(e.target.value); }} disabled={busy || unknownTime} data-testid="at-day" />
          </label>
          <label className="field">
            <span className="sr-only">時刻（分かれば）</span>
            <input className="input" type="time" value={time} onChange={(e) => { setTime(e.target.value); }} disabled={busy || unknownTime} data-testid="at-time" />
          </label>
        </div>
        {!unknownTime && time === '' && (
          <p className="note" data-testid="when-day-only">
            時刻なし（日だけ）で入れます。時刻の書かれていない値・できごとも、日だけになります。時刻が分かれば、選ぶか打ってください。
          </p>
        )}
      </fieldset>

      {(kind === 'vital' || kind === 'lab') && <QuickValues kind={kind} disabled={busy} onCompose={insert} />}

      <label className="field">
        <span className="field-label">文</span>
        {templates.length > 0 && (
          <span className="chips">
            {templates.map((t, i) => (
              <button key={t.label} type="button" className="chip small outline" onClick={() => { insert(t.text); }} disabled={busy} data-testid={`template-${String(i)}`}>
                ＋ {t.label}
              </button>
            ))}
          </span>
        )}
        <textarea
          ref={area}
          className="input area"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
          }}
          disabled={busy}
          rows={8}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={readsValues ? '例：WBC 12.3 Hb 8.2 CRP <0.1 BP 120/80（上の欄から入れることもできます）' : '写した文を、そのまま入れます'}
          data-testid="text"
        />
      </label>
      {readsValues ? (
        <p className="note">名前と値を並べて書きます。値は、AI を使わずに読みます。読めなかった部分も、文には残ります。</p>
      ) : (
        <p className="note">保存したあと、AI が整理します（見出しの区切り・投薬・できごと・問題・測定値）。整理は、文に書かれたことだけで、文そのものは変えません。</p>
      )}
      <p className={tooLong ? 'note over' : 'note'}>
        {String(text.length)} / {String(TEXT_LIMIT)} 字
      </p>
      {message !== null && (
        <p className="alert" role="alert" data-testid="composer-error">
          {message}
        </p>
      )}
      {done !== null && (
        <p className="done" role="status" data-testid="composer-done">
          {done}
        </p>
      )}
      {organizing !== null && (
        <p className="note" role="status" data-testid="composer-organizing">
          {organizing}
        </p>
      )}
      {askDayOnly && needsDayOnlyCheck && (
        <div className="alert" role="alert" data-testid="day-only-check">
          <p>
            文に時刻（{timedCandidates.slice(0, 3).map((c) => c.slice(11, 16)).join('・')}）が書かれています。時刻なし（日だけ）で入れると、時刻の書かれていない値・できごとは日だけになり、同じ日の時刻のある記録との前後が分からなくなります。上の「文に書かれた日時」から選ぶか、時刻を打ってください。
          </p>
          <button className="button small" type="button" onClick={send} disabled={busy} data-testid="send-day-only">
            このまま時刻なしで入れる
          </button>
        </div>
      )}
      <p className="target" data-testid="target">
        入れる先：<strong>{target}</strong>
      </p>
      <button className="button primary block" type="submit" disabled={busy || !ready} data-testid="send">
        {busy ? '識別情報を選別しています…' : 'この患者に入れる'}
      </button>
    </form>
  );
}
