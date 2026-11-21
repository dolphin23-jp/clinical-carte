// 文を入れる（docs/00 の 5）。先に患者と受診を選んである（CA-015）。どの患者に入るかを、送るボタンのすぐ上に出す。
// 送った文は、サーバーで AI の選別と置き換えを通ったものだけが保存される。通らなければ、打った文は、この欄に残る。
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
} from '@clinical-carte/core';
import { type SyntheticEvent, useState } from 'react';

import { joinDateTime, nowLocal, replacedSummary } from './format.ts';
import { errorMessage } from './messages.ts';
import { addSource, type Observation, organizeSource, type Source } from './net/api.ts';
import { organizeSummary } from './organizeText.ts';

export function Composer({ encounterId, target, onSaved, onLeft }: { encounterId: string; target: string; onSaved: (source?: Source, observations?: readonly Observation[]) => void; onLeft: () => void }) {
  const [kind, setKind] = useState<SourceKind>('unsorted');
  const [authorRole, setAuthorRole] = useState<AuthorRole>('self');
  const [day, setDay] = useState(() => nowLocal().day);
  const [time, setTime] = useState(() => nowLocal().time);
  const [unknownTime, setUnknownTime] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** 保存のあとの整理（段2）の知らせ */
  const [organizing, setOrganizing] = useState<string | null>(null);

  const readsValues = READ_VALUES_KINDS.includes(kind);
  const tooLong = text.length > TEXT_LIMIT;
  const ready = text.trim() !== '' && !tooLong && (unknownTime || day !== '');

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (busy || !ready) return;
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
      <div className="field-row">
        <label className="field">
          <span className="field-label">種類</span>
          <select
            className="input"
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
        <label className="field">
          <span className="field-label">書いた人</span>
          <select
            className="input"
            value={authorRole}
            onChange={(e) => {
              setAuthorRole(e.target.value as AuthorRole);
            }}
            disabled={busy}
          >
            {AUTHOR_ROLES.map((r) => (
              <option key={r} value={r}>
                {AUTHOR_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-label">記載・測定の日</span>
          <input
            className="input"
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
            }}
            disabled={busy || unknownTime}
            data-testid="at-day"
          />
        </label>
        <label className="field">
          <span className="field-label">時刻（分かれば）</span>
          <input
            className="input"
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
            }}
            disabled={busy || unknownTime}
            data-testid="at-time"
          />
        </label>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={unknownTime}
          onChange={(e) => {
            setUnknownTime(e.target.checked);
          }}
          disabled={busy}
        />
        <span>日時が分からない（日時なしで入れる）</span>
      </label>
      <label className="field">
        <span className="field-label">文</span>
        <textarea
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
          data-testid="text"
        />
      </label>
      {readsValues ? (
        <p className="note">名前と値を並べて書きます（例：WBC 12.3 Hb 8.2 CRP &lt;0.1 BP 78/40 尿潜血 (-)）。値は、AI を使わずに読みます。読めなかった部分も、文には残ります。</p>
      ) : (
        <p className="note">写した文を、そのまま入れます。保存したあと、AI が整理します（見出しの区切り・投薬・できごと・問題・測定値）。整理は、文に書かれたことだけで、文そのものは変えません。</p>
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
      <p className="target" data-testid="target">
        入れる先：<strong>{target}</strong>
      </p>
      <button className="button primary" type="submit" disabled={busy || !ready} data-testid="send">
        {busy ? '識別情報を選別しています…' : 'この患者に入れる'}
      </button>
    </form>
  );
}
