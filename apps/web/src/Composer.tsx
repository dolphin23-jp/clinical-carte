// 文を入れる（docs/00 の 5）。先に患者と受診を選んである（CA-015）。どの患者に入るかを、送るボタンのすぐ上に出す。
// 送った文は、サーバーで AI の選別と置き換えを通ったものだけが保存される。通らなければ、打った文は、この欄に残る。
// 手軽にするための部品：種類・書いた人・日時のチップ、見出しのひな形、バイタル・検査値の入力欄（欄の値から文を作り、文の欄に入れる。送る文は、いつも文の欄の文）。
// 電波のないとき（段K9。CA-072）：つながらずに送れなかった文は、画面のメモリの「送り待ち」に入れて、欄を空ける（続けて入れられる）。
// 電波が戻ったら送り直す（outbox.ts）。サーバーが断った文は、いつもどおり誤りを出し、送り待ちの札から欄に戻して直せる。読み込み直す・閉じると、送り待ちは消える。
import {
  AUTHOR_ROLE_LABELS,
  AUTHOR_ROLES,
  type AuthorRole,
  READ_VALUES_KINDS,
  readLabText,
  shouldRetry,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  type SourceKind,
  TEXT_LIMIT,
  whenCandidates,
} from '@clinical-carte/core';
import { type SyntheticEvent, useRef, useState } from 'react';

import { joinDateTime, nowLocal, replacedSummary, showDateTime } from './format.ts';
import { Icon } from './Icon.tsx';
import { NextDayAsk, type NextDayAnswer, nextDayKey } from './NextDayAsk.tsx';
import { errorMessage } from './messages.ts';
import { addSource, type Observation, type Source } from './net/api.ts';
import { runOrganize } from './organizing.ts';
import { organizeSummary } from './organizeText.ts';
import { hasQueued, kick, newSendKey, queueSource, type QueuedSource } from './outbox.ts';
import { QUEUE_NOTE, QueueCards } from './QueueView.tsx';
import { QuickValues } from './QuickValues.tsx';
import { COMMON_KINDS, insertAt, KIND_CHIP_LABELS, type Template, TEMPLATES } from './templates.ts';

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
  problemHeadings = [],
  onSaved,
  onQueued = () => undefined,
  onLeft,
}: {
  encounterId: string;
  target: string;
  /** いまの問題の見出し（保存した記載に書かれた名前。並びは問題のタブと同じ）。経過のひな形にする（決定論。AI を使わない） */
  problemHeadings?: readonly string[];
  onSaved: (source?: Source, observations?: readonly Observation[]) => void;
  /** 送り待ちに入れたとき（段K9。入れる欄を開いたままにする。記録は、まだ変わっていない） */
  onQueued?: () => void;
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
  /** 日をまたいだかの答え（CA-047。文に大きな時刻の逆戻りがあるときだけ聞く） */
  const [nextAnswer, setNextAnswer] = useState<NextDayAnswer | null>(null);

  const readsValues = READ_VALUES_KINDS.includes(kind);
  const tooLong = text.length > TEXT_LIMIT;
  const turnKey = unknownTime ? null : nextDayKey(text);
  const turnAnswered = turnKey === null || nextAnswer?.key === turnKey;
  const ready = text.trim() !== '' && !tooLong && (unknownTime || day !== '') && turnAnswered;
  // 経過の記載では、いまの問題の見出しを並べたひな形を先に出す（前日の問題の骨組み。中身は本人が書く）
  const headings: Template[] = kind === 'progress_note' && problemHeadings.length > 0 ? [{ label: `いまの問題の見出し（${String(problemHeadings.length)}）`, text: problemHeadings.map((h) => `${h}\n`).join('\n') }] : [];
  const templates = [...headings, ...(TEMPLATES[kind] ?? [])];
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

  /** 文に時刻の候補があって、時刻なし（日だけ）で送るとき：整理のときに、文に書かれた時刻を AI が指し、記載と事実の時刻にする
   *  （2026-11-21 の本人の決定。送る前の確かめ〔CA-040〕は、自動にしたので外した） */
  const timedCandidates = candidates.filter((c) => c.length > 10);
  const autoTime = !unknownTime && time === '' && timedCandidates.length > 0;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    send();
  };

  /** 送ったあと・送り待ちに入れたあとに、欄を空ける（時刻も空に戻す） */
  const clear = () => {
    setText('');
    setTime('');
    setUnknownTime(false);
    setNextAnswer(null);
  };

  /** 送り待ちの札から、断られた文を欄に戻す（直して送り直す） */
  const takeBack = (item: QueuedSource) => {
    const { input } = item;
    setKind(input.kind);
    setAuthorRole(input.authorRole);
    if (input.at === null) setUnknownTime(true);
    else {
      setUnknownTime(false);
      setDay(input.at.slice(0, 10));
      setTime(input.at.length > 10 ? input.at.slice(11, 16) : '');
    }
    setText(input.text);
    setNextAnswer(null);
    setMessage(null);
    setDone(null);
  };

  const send = () => {
    if (busy || !ready) return;
    setMessage(null);
    setDone(null);
    setOrganizing(null);
    const nextDay = turnKey !== null && nextAnswer?.key === turnKey && nextAnswer.next;
    // 送る鍵は、押したときに1つ作る（送り待ちから送り直しても同じ鍵。サーバーは二重に保存しない）
    const input = { kind, authorRole, at: unknownTime ? null : joinDateTime(day, time), text, ...(nextDay ? { nextDay: true } : {}), sendKey: newSendKey() };
    // この受診に送り待ちがあれば、順を守るため、この文も送り待ちの後ろに入れる
    if (hasQueued(encounterId)) {
      queueSource({ encounterId, input });
      clear();
      setDone(`前の文が送り待ちなので、この文もその後ろに入れました（${QUEUE_NOTE}）。まだ保存していません。`);
      // 入れる欄を開いたままにする（送り待ちの札は、この欄に出る）
      onQueued();
      kick();
      return;
    }
    setBusy(true);
    void addSource(encounterId, input).then((result) => {
      setBusy(false);
      if (!result.ok) {
        // つながらない（サーバーまで届かない・答えが戻らない）：送り待ちに入れて、欄を空ける（電波が戻ったら送る）
        if (shouldRetry(result.error)) {
          queueSource({ encounterId, input });
          clear();
          setDone(`つながらないので、送り待ちに入れました（${QUEUE_NOTE}）。まだ保存していません。`);
          onQueued();
          return;
        }
        // サーバーが断った：打った文は、欄に残す（もう一度送れる）
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
      clear();
      onSaved(source, observations);
      // 続けて整理する（段2）。整理に失敗しても、文は保存されている
      setOrganizing('整理しています…（30 秒ほどかかることがあります）');
      void runOrganize(source.id).then((organized) => {
        if (organized.ok) setOrganizing(organized.value === null ? '整理しました（画面を離れていたあいだに済んでいたので、記録を読み直しました）。' : organizeSummary(organized.value));
        else if (organized.error === 'unregistered') onLeft();
        else setOrganizing(`整理できませんでした（${errorMessage(organized.error).replace('文は保存していません。', '')}）。文は保存してあります。あとで、記録の「整理する」を押せます。`);
        onSaved();
      });
    });
  };

  return (
    <form className="form composer" onSubmit={submit} data-testid="composer">
      <fieldset className="field">
        <legend className="field-label">
          <span className="step-no" aria-hidden="true">
            1
          </span>
          種類
        </legend>
        <div className="chips row" role="radiogroup" aria-label="種類">
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
          <select
            className="input compact"
            aria-label="ほかの種類"
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
        </div>
      </fieldset>

      <fieldset className="field">
        <legend className="field-label">
          <span className="step-no" aria-hidden="true">
            2
          </span>
          書いた人
        </legend>
        <div className="chips row" role="radiogroup" aria-label="書いた人">
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
        <legend className="field-label">
          <span className="step-no" aria-hidden="true">
            3
          </span>
          記載・測定の日時
        </legend>
        <div className="chips row">
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
          <div className="chips row" aria-label="文に書かれた日時" data-testid="when-candidates">
            <span className="note with-icon">
              <Icon name="clock" />
              文に書かれた日時：
            </span>
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
            {autoTime
              ? `時刻を空のまま入れると、整理のときに、文に書かれた時刻（${timedCandidates
                  .slice(0, 3)
                  .map((c) => c.slice(11, 16))
                  .join('・')} など）を AI が読み取り、記載と、その見出しの下の値・できごとの時刻にします（この日の時刻だけ）。`
              : '時刻なし（日だけ）で入れます。分かれば、選ぶか打ってください。'}
          </p>
        )}
      </fieldset>

      <NextDayAsk text={text} day={unknownTime || day === '' ? null : day} answer={nextAnswer} onAnswer={setNextAnswer} disabled={busy || unknownTime} />

      {(kind === 'vital' || kind === 'lab') && <QuickValues kind={kind} disabled={busy} onCompose={insert} />}

      <label className="field">
        <span className="field-label">
          <span className="step-no" aria-hidden="true">
            4
          </span>
          文
        </span>
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
          rows={7}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={readsValues ? '例：WBC 12.3 Hb 8.2 CRP <0.1 BP 120/80（上の欄から入れることもできます）' : '写した文を、そのまま入れます'}
          data-testid="text"
        />
      </label>
      <p className={tooLong ? 'note over' : 'note'}>
        {readsValues ? '値は AI を使わずに読みます（読めない部分も文に残ります）' : '保存後に AI が整理します（文は変えません）'}・{String(text.length)} / {String(TEXT_LIMIT)} 字
      </p>
      {message !== null && (
        <p className="alert" role="alert" data-testid="composer-error">
          {message}
        </p>
      )}
      {done !== null && (
        <p className="done with-icon" role="status" data-testid="composer-done">
          <Icon name="check" />
          {done}
        </p>
      )}
      {organizing !== null && (
        <p className="note" role="status" data-testid="composer-organizing">
          {organizing}
        </p>
      )}
      <QueueCards encounterId={encounterId} canTakeBack={text.trim() === ''} onTakeBack={takeBack} />
      <div className="send-bar">
        <p className="target" data-testid="target">
          <Icon name="user" />
          入れる先：<strong>{target}</strong>
        </p>
        <button className="button primary block big" type="submit" disabled={busy || !ready} data-testid="send">
          {busy ? '識別情報を選別しています…' : 'この患者に入れる'}
        </button>
      </div>
    </form>
  );
}
