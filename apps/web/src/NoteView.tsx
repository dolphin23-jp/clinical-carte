// 段5：記載（CA-030〜035）。日ごとに、問題ごとの S・O（保存した文の、その場所の字。決定論）と値を並べ、
// A/P は「本人が書く」と「AI の案から選んで残す」を、いつでも、どちらでも使える（CA-034）。
// - 残すのは、決まった A/P だけ（文はサーバーで選別を通す）。AI の案・議論のやりとりは保存しない（画面のメモリだけ。CA-032）。
// - AI の案から残したものは「AI 案から採用」の印と、根拠の参照（場所・題・頁・URL。本文なし）を持つ。直すと「AI 案を直した」になる。
// - 病院のカルテへ持っていく向き（コピーのボタン）は作らない（CA-033）。
import {
  AP_ORIGIN_NAMES,
  AP_TEXT_MAX,
  type ApNoteNew,
  type ApPart,
  type ApRef,
  type CheckedSentence,
  DISCUSS_TEXT_MAX,
  liveThreadId,
  noteDay,
  noteDays,
  type NotePart,
  PLAN_KIND_NAMES,
  PLAN_KINDS,
  type PlanKind,
  PROBLEM_STATUS_NAMES,
  PROPOSAL_REJECT_NAMES,
  type ProposalRejectReason,
  type RefSource,
  threadViews,
} from '@clinical-carte/core';
import { useState } from 'react';

import { showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { addApNotes, type ApiError, type ApNote, deleteApNote, type Encounter, patchApNote, type PatientRecord, type RefCounts, requestDiscussion, requestProposal, type Result } from './net/api.ts';

const BASIS_NAMES = { record: '記録から', source: '出典から', inference: '推論' } as const;

/** 保存しない画面の文から、誤りの文を作る（「文は保存していません」は、ここでは要らない） */
const say = (error: ApiError): string => errorMessage(error).replace('文は保存していません。', '');

const textOf = (record: PatientRecord, part: NotePart): string => (record.sources.find((s) => s.id === part.sourceId)?.text ?? '').slice(part.start, part.end).trim();

/** 根拠の参照（保存する形）。同じものは1つ、20 件まで */
function refsOf(cites: readonly RefSource[]): ApRef[] {
  const seen = new Set<string>();
  const out: ApRef[] = [];
  for (const c of cites) {
    const key = JSON.stringify(c.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c.ref);
  }
  return out.slice(0, 20);
}

function RefLine({ refs, record }: { refs: readonly ApRef[]; record: PatientRecord }) {
  if (refs.length === 0) return null;
  return (
    <ul className="ap-refs" data-testid="ap-refs">
      {refs.map((r, i) => (
        <li key={i}>
          {r.k === 'record' ? (
            <span>記録 {showDateTime(record.sources.find((s) => s.id === r.sourceId)?.at ?? null)}</span>
          ) : r.k === 'book' ? (
            <span>
              書籍『{r.title}』{r.page === null ? '' : ` ${r.page}`}
              {r.path === null ? '' : `（${r.path}）`}
            </span>
          ) : (
            <a href={r.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
              {r.title === '' ? r.url : r.title}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 文の根拠（出典の見出しと、その字） */
function Cites({ sentence }: { sentence: CheckedSentence }) {
  return (
    <details className="ap-cites">
      <summary>
        <span className={`tag basis-${sentence.basis}`}>{BASIS_NAMES[sentence.basis]}</span> 根拠 {String(sentence.cites.length)}
      </summary>
      <ul className="draft-quotes">
        {sentence.cites.map((c) => (
          <li key={c.id} data-testid="ap-cite">
            <span className="part-label">
              {c.kind === 'record' ? `記録 ${showDateTime(c.at)}${c.day === null ? '' : `・${String(c.day)}病日`}・${c.label}` : c.kind === 'book' ? `書籍 ${c.label}` : `ネット ${c.label}`}
            </span>
            <span className="source-text">{c.text}</span>
            {c.ref.k === 'web' && (
              <a href={c.ref.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
                {c.ref.url}
              </a>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Rejected({ rejected }: { rejected: Partial<Record<ProposalRejectReason, number>> }) {
  const list = (Object.entries(rejected) as [ProposalRejectReason, number][]).filter(([, n]) => n > 0);
  const total = list.reduce((n, [, v]) => n + v, 0);
  if (total === 0) return <>確かめを通らなかった文はありません。</>;
  return <>確かめを通らず出さなかった文 {String(total)}（{list.map(([k, n]) => `${PROPOSAL_REJECT_NAMES[k]} ${String(n)}`).join('・')}）。</>;
}

function Counts({ counts }: { counts: RefCounts }) {
  return (
    <>
      資料にした出典 {String(counts.sources)} 件（書籍 {String(counts.books)}・ネット {String(counts.web)}）。{counts.webFailed && 'ネットの検索はできませんでした（記録と書籍だけで作りました）。'}
    </>
  );
}

/** 残した A/P の1つ：直す（選別を通す）・方針の種類・消す */
function SavedNote({ note, record, busy, run }: { note: ApNote; record: PatientRecord; busy: boolean; run: (f: () => Promise<Result<null>>) => void }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [text, setText] = useState(note.text);
  return (
    <li className="ap-note" data-testid="ap-note">
      <div className="ap-note-head">
        <span className="tag">{note.part === 'assessment' ? 'A' : `P${note.planKind === null ? '' : `・${PLAN_KIND_NAMES[note.planKind]}`}`}</span>
        <span className={note.origin === 'self' ? 'tag' : 'tag ai'} data-testid="ap-origin">
          {AP_ORIGIN_NAMES[note.origin]}
        </span>
      </div>
      {editing ? (
        <div className="form">
          <textarea className="input ap-area" value={text} maxLength={AP_TEXT_MAX} disabled={busy} onChange={(e) => { setText(e.target.value); }} data-testid="ap-edit-text" />
          <div className="actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || text.trim() === '' || text === note.text}
              onClick={() => {
                run(() => patchApNote(note.id, { text: text.trim() }));
                setEditing(false);
              }}
              data-testid="ap-edit-save"
            >
              直して残す
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => { setEditing(false); setText(note.text); }}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <p className="ap-text">{note.text}</p>
      )}
      <RefLine refs={note.refs} record={record} />
      {!editing && (
        <div className="row-actions">
          <button type="button" className="button small" disabled={busy} onClick={() => { setEditing(true); }} data-testid="ap-edit">
            直す
          </button>
          {note.part === 'plan' && (
            <select className="input small" value={note.planKind ?? ''} disabled={busy} aria-label="方針の種類" onChange={(e) => { run(() => patchApNote(note.id, { planKind: e.target.value === '' ? null : (e.target.value as PlanKind) })); }} data-testid="ap-kind">
              <option value="">種類なし</option>
              {PLAN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PLAN_KIND_NAMES[k]}
                </option>
              ))}
            </select>
          )}
          {removing ? (
            <>
              <button type="button" className="button small danger" disabled={busy} onClick={() => { run(() => deleteApNote(note.id)); }} data-testid="ap-delete-yes">
                消す（履歴に残ります）
              </button>
              <button type="button" className="button small" disabled={busy} onClick={() => { setRemoving(false); }}>
                やめる
              </button>
            </>
          ) : (
            <button type="button" className="button small" disabled={busy} onClick={() => { setRemoving(true); }} data-testid="ap-delete">
              消す
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** 自分で書く */
function OwnForm({ onSave, busy }: { onSave: (part: ApPart, planKind: PlanKind | null, text: string) => void; busy: boolean }) {
  const [part, setPart] = useState<ApPart>('assessment');
  const [kind, setKind] = useState<PlanKind | null>(null);
  const [text, setText] = useState('');
  return (
    <details className="picker" data-testid="ap-own">
      <summary>自分で A/P を書く</summary>
      <div className="field-row">
        <label className="field">
          <span className="field-label">欄</span>
          <select className="input" value={part} disabled={busy} onChange={(e) => { setPart(e.target.value as ApPart); }} data-testid="ap-own-part">
            <option value="assessment">A（評価）</option>
            <option value="plan">P（方針）</option>
          </select>
        </label>
        {part === 'plan' && (
          <label className="field">
            <span className="field-label">方針の種類</span>
            <select className="input" value={kind ?? ''} disabled={busy} onChange={(e) => { setKind(e.target.value === '' ? null : (e.target.value as PlanKind)); }} data-testid="ap-own-kind">
              <option value="">種類なし</option>
              {PLAN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PLAN_KIND_NAMES[k]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <textarea className="input ap-area" value={text} maxLength={AP_TEXT_MAX} disabled={busy} placeholder="決まった評価・方針を書く（氏名・番号は、保存の前に置き換わります）" onChange={(e) => { setText(e.target.value); }} data-testid="ap-own-text" />
      <button
        type="button"
        className="button primary"
        disabled={busy || text.trim() === ''}
        onClick={() => {
          onSave(part, part === 'plan' ? kind : null, text.trim());
          setText('');
        }}
        data-testid="ap-own-save"
      >
        残す
      </button>
    </details>
  );
}

interface Turn {
  readonly role: 'doctor' | 'ai';
  readonly text: string;
  readonly sentences?: readonly CheckedSentence[];
}

/** AI と議論する（保存しない）。答えの文は、A・P に足せる（足したものだけが残る） */
function Discuss({ encounterId, threadId, day, onAdopt, busy, onLeft }: { encounterId: string; threadId: string; day: string; onAdopt: (part: ApPart, s: CheckedSentence) => void; busy: boolean; onLeft: () => void }) {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [web, setWeb] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const send = () => {
    const q = question.trim();
    if (q === '' || waiting) return;
    setWaiting(true);
    setMessage(null);
    const history = turns.slice(-20).map((t) => ({ role: t.role, text: t.text.slice(0, DISCUSS_TEXT_MAX) }));
    void requestDiscussion(encounterId, { threadId, day, web, question: q, history }).then((r) => {
      setWaiting(false);
      if (!r.ok) {
        if (r.error === 'unregistered') onLeft();
        else setMessage(say(r.error));
        return;
      }
      const sentences = r.value.discussion.paragraphs;
      setTurns([...turns, { role: 'doctor', text: q }, { role: 'ai', text: sentences.map((s) => s.text).join('') || '（確かめを通った答えがありませんでした）', sentences }]);
      setQuestion('');
      setNote(null);
      const rejected = Object.values(r.value.discussion.rejected).reduce((n, v) => n + v, 0);
      setNote(`${rejected > 0 ? `確かめを通らず出さなかった文 ${String(rejected)}。` : ''}${r.value.webFailed ? 'ネットの検索はできませんでした。' : ''}`);
    });
  };
  return (
    <details className="picker discuss" data-testid="discuss">
      <summary>AI と話す（保存しません）</summary>
      <p className="note">やりとりは保存しません（この画面を離れると消えます）。答えの文から、決まったものだけを A・P に足せます。外の検索（書籍・ネット）に送るのは、問題の名前だけです。</p>
      {turns.length > 0 && (
        <ol className="discuss-turns">
          {turns.map((t, i) => (
            <li key={i} className={t.role === 'doctor' ? 'turn doctor' : 'turn ai'} data-testid={`turn-${t.role}`}>
              <span className="part-label">{t.role === 'doctor' ? '先生' : 'AI'}</span>
              {t.sentences === undefined ? (
                <p className="ap-text">{t.text}</p>
              ) : t.sentences.length === 0 ? (
                <p className="note">{t.text}</p>
              ) : (
                <ul className="ap-sentences">
                  {t.sentences.map((s, j) => (
                    <li key={j} data-testid="discuss-sentence">
                      <p className="ap-text">{s.text}</p>
                      <Cites sentence={s} />
                      <div className="row-actions">
                        <button type="button" className="button small" disabled={busy} onClick={() => { onAdopt('assessment', s); }} data-testid="discuss-to-a">
                          A に足す
                        </button>
                        <button type="button" className="button small" disabled={busy} onClick={() => { onAdopt('plan', s); }} data-testid="discuss-to-p">
                          P に足す
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      <textarea className="input ap-area" value={question} maxLength={DISCUSS_TEXT_MAX} disabled={waiting} placeholder="問い・自分の考え（例：経口に切り替える時期は？）" onChange={(e) => { setQuestion(e.target.value); }} data-testid="discuss-question" />
      <div className="actions">
        <label className="check">
          <input type="checkbox" checked={web} disabled={waiting} onChange={(e) => { setWeb(e.target.checked); }} data-testid="discuss-web" />
          ネットのガイドラインも探す（AI をもう 1 回使います）
        </label>
        <button type="button" className="button primary" disabled={waiting || question.trim() === ''} onClick={send} data-testid="discuss-send">
          {waiting ? '考えています…' : '送る'}
        </button>
        {turns.length > 0 && (
          <button type="button" className="button" disabled={waiting} onClick={() => { setTurns([]); setNote(null); }} data-testid="discuss-clear">
            やりとりを消す
          </button>
        )}
      </div>
      {note !== null && note !== '' && <p className="note">{note}</p>}
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
    </details>
  );
}

export function NoteView({ record, encounter, onChanged, onLeft }: { record: PatientRecord; encounter: Encounter; onChanged: () => void; onLeft: () => void }) {
  const days = noteDays(encounter.id, record.sources);
  const [chosen, setChosen] = useState<string | null>(null);
  const day = chosen !== null && days.includes(chosen) ? chosen : (days[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // AI の案（保存しない。日が変わると消す）
  const [proposal, setProposal] = useState<{ day: string; value: Awaited<ReturnType<typeof requestProposal>> extends Result<infer T> ? T : never } | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [web, setWeb] = useState(false);
  const [asking, setAsking] = useState(false);
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());

  const run = (f: () => Promise<Result<null>>) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    void f().then((r) => {
      setBusy(false);
      if (r.ok) onChanged();
      else if (r.error === 'unregistered') onLeft();
      else setMessage(errorMessage(r.error));
    });
  };

  if (day === null) {
    return (
      <div className="notes-view" data-testid="note-view">
        <p className="draft-banner">記載は、写した記録を日ごとに整理したものです。正本は病院のカルテで、ここから病院のカルテへは持っていきません。</p>
        <p className="note">この受診には、日時のある記載がまだありません。</p>
      </div>
    );
  }

  const views = threadViews(record.problemThreads, record.problems).threads;
  const nd = noteDay({
    encounter,
    day,
    sources: record.sources,
    segments: record.segments,
    threads: views,
    observations: record.observations.filter((o) => !o.excluded),
    medications: record.medications.filter((m) => m.encounterId === encounter.id && !m.excluded),
  });
  // 統合された筋に残した A/P は、統合先の筋に出す
  const byId = new Map(record.problemThreads.map((t) => [t.id, t]));
  const notesOf = (threadId: string): ApNote[] => record.apNotes.filter((n) => n.encounterId === encounter.id && n.day === day && liveThreadId(byId, n.threadId) === threadId);
  const others = record.apNotes.filter((n) => n.encounterId === encounter.id && n.day === day && !nd.problems.some((p) => p.thread.id === liveThreadId(byId, n.threadId)));
  const currentProposal = proposal?.day === day ? proposal.value : null;

  const note = (threadId: string, part: ApPart, planKind: PlanKind | null, text: string, origin: 'self' | 'ai', refs: readonly ApRef[]): ApNoteNew => ({
    encounterId: encounter.id,
    threadId,
    day,
    part,
    planKind: part === 'plan' ? planKind : null,
    text: text.slice(0, AP_TEXT_MAX),
    origin,
    refs: [...refs],
  });

  const ask = () => {
    if (asking) return;
    const threadIds = nd.problems.map((p) => p.thread.id).filter((id) => !left.has(id)).slice(0, 10);
    if (threadIds.length === 0) return;
    setAsking(true);
    setMessage(null);
    void requestProposal(encounter.id, { day, threadIds, web }).then((r) => {
      setAsking(false);
      if (r.ok) {
        setProposal({ day, value: r.value });
        setPicked(new Set());
      } else if (r.error === 'unregistered') onLeft();
      else setMessage(say(r.error));
    });
  };

  const key = (threadId: string, part: ApPart, i: number): string => `${threadId}:${part}:${String(i)}`;
  const adoptPicked = () => {
    if (currentProposal === null) return;
    const notes: ApNoteNew[] = [];
    for (const p of currentProposal.proposal.problems) {
      p.assessment.forEach((s, i) => {
        if (picked.has(key(p.problem.threadId, 'assessment', i))) notes.push(note(p.problem.threadId, 'assessment', null, s.text, 'ai', refsOf(s.cites)));
      });
      p.plan.forEach((s, i) => {
        if (picked.has(key(p.problem.threadId, 'plan', i))) notes.push(note(p.problem.threadId, 'plan', s.kind ?? null, s.text, 'ai', refsOf(s.cites)));
      });
    }
    if (notes.length === 0) return;
    run(async () => {
      const r = await addApNotes(encounter.id, notes.slice(0, 30));
      if (r.ok) setPicked(new Set());
      return r;
    });
  };
  const toggle = (k: string) => {
    const next = new Set(picked);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setPicked(next);
  };

  return (
    <div className="notes-view" data-testid="note-view">
      <p className="draft-banner">記載は、写した記録を日ごとに整理したものです。正本は病院のカルテで、ここから病院のカルテへは持っていきません。A/P は、先生が書いたものと、AI の案から先生が選んだものだけが残ります。</p>
      <div className="chips" role="group" aria-label="日を選ぶ" data-testid="note-days">
        {days.map((d) => (
          <button key={d} type="button" className={d === day ? 'chip small on' : 'chip small'} aria-pressed={d === day} onClick={() => { setChosen(d); }}>
            {d.slice(5).replace('-', '/')}
          </button>
        ))}
      </div>
      <h3 className="sub-title" data-testid="note-day">
        {day}
        {nd.hospitalDay !== null && `（${String(nd.hospitalDay)}病日）`}
      </h3>
      {nd.vitals.length > 0 && (
        <p className="note-vitals" data-testid="note-vitals">
          {nd.vitals.map((v) => `${v.nameRaw} ${v.valueText}${v.unit === null ? '' : ` ${v.unit}`}`).join('　')}
        </p>
      )}
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
      {nd.problems.length === 0 && <p className="note">この日までに、問題の筋がありません（記録の「整理し直す」で、問題の区切りが付きます）。</p>}
      {nd.problems.map((p) => {
        const saved = notesOf(p.thread.id);
        return (
          <section key={p.thread.id} className="note-problem" data-testid="note-problem">
            <h4 className="note-problem-title">
              {p.thread.name}
              <span className="tag">{PROBLEM_STATUS_NAMES[p.thread.status]}</span>
            </h4>
            {p.s.length > 0 && (
              <div className="note-part" data-testid="note-s">
                <span className="part-label">S</span>
                {p.s.map((g, i) => (
                  <p key={i} className="source-text">
                    {textOf(record, g)}
                  </p>
                ))}
              </div>
            )}
            {(p.o.length > 0 || p.values.length > 0) && (
              <div className="note-part" data-testid="note-o">
                <span className="part-label">O</span>
                {p.o.map((g, i) => (
                  <p key={i} className="source-text">
                    {textOf(record, g)}
                  </p>
                ))}
                {p.values.length > 0 && <p className="note-values">{p.values.map((v) => `${v.nameRaw} ${v.valueText}${v.unit === null ? '' : ` ${v.unit}`}（${showDateTime(v.at)}）`).join('　')}</p>}
              </div>
            )}
            {p.lastAp.length > 0 && (
              <details className="note-part last-ap">
                <summary>写した記載の A/P（この日までのいちばん新しいもの）</summary>
                {p.lastAp.map((g, i) => (
                  <p key={i} className="source-text">
                    {textOf(record, g)}
                  </p>
                ))}
              </details>
            )}
            <div className="note-part">
              <span className="part-label">残した A/P（この日）</span>
              {saved.length === 0 ? (
                <p className="note">まだありません。</p>
              ) : (
                <ul className="ap-notes">
                  {[...saved]
                    .sort((a, b) => (a.part === b.part ? a.enteredAt.localeCompare(b.enteredAt) : a.part === 'assessment' ? -1 : 1))
                    .map((n) => (
                      <SavedNote key={`${n.id}:${n.updatedAt}`} note={n} record={record} busy={busy} run={run} />
                    ))}
                </ul>
              )}
            </div>
            <OwnForm busy={busy} onSave={(part, kind, text) => { run(() => addApNotes(encounter.id, [note(p.thread.id, part, kind, text, 'self', [])])); }} />
            <Discuss
              encounterId={encounter.id}
              threadId={p.thread.id}
              day={day}
              busy={busy}
              onLeft={onLeft}
              onAdopt={(part, s) => {
                run(() => addApNotes(encounter.id, [note(p.thread.id, part, part === 'plan' ? (s.kind ?? null) : null, s.text, 'ai', refsOf(s.cites))]));
              }}
            />
          </section>
        );
      })}
      {nd.unassigned.length > 0 && (
        <details className="note-part">
          <summary>どの問題にも入らない S・O（{String(nd.unassigned.length)}）</summary>
          {nd.unassigned.map((g, i) => (
            <p key={i} className="source-text">
              {textOf(record, g)}
            </p>
          ))}
        </details>
      )}
      {others.length > 0 && (
        <section className="note-problem">
          <h4 className="note-problem-title">いまの問題の一覧にない筋の A/P</h4>
          <ul className="ap-notes">
            {others.map((n) => (
              <SavedNote key={`${n.id}:${n.updatedAt}`} note={n} record={record} busy={busy} run={run} />
            ))}
          </ul>
        </section>
      )}

      {nd.problems.length > 0 && (
        <section className="ap-proposal" data-testid="ap-proposal">
          <h3 className="sub-title">AI の A/P の案（保存しません）</h3>
          <p className="note">
            この日までの、問題ごとの記載（A・P・S・O と、その問題の値・薬）を材料に、問題ごとの評価と方針の案を出します。書籍（設定があるとき）と、選べばネットのガイドラインも根拠にします。外の検索に送るのは、問題の名前だけです。文ごとに根拠を確かめ、根拠にない数（用量・閾値を含む）がある文・根拠のない文は出しません。案は、選んだものだけが残ります。
          </p>
          <div className="chips" role="group" aria-label="案を出す問題">
            {nd.problems.map((p) => (
              <button
                key={p.thread.id}
                type="button"
                className={left.has(p.thread.id) ? 'chip small' : 'chip small on'}
                aria-pressed={!left.has(p.thread.id)}
                onClick={() => {
                  const next = new Set(left);
                  if (next.has(p.thread.id)) next.delete(p.thread.id);
                  else next.add(p.thread.id);
                  setLeft(next);
                }}
                data-testid="ap-proposal-problem"
              >
                {p.thread.name}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={web} disabled={asking} onChange={(e) => { setWeb(e.target.checked); }} data-testid="ap-proposal-web" />
            ネットのガイドラインも探す（AI をもう 1 回使います）
          </label>
          <button type="button" className="button primary" disabled={asking || nd.problems.every((p) => left.has(p.thread.id))} onClick={ask} data-testid="ap-proposal-make">
            {asking ? '考えています…（1 分ほどかかることがあります）' : currentProposal === null ? 'A/P の案を出す' : 'もう一度出す'}
          </button>
          {currentProposal !== null && (
            <>
              {currentProposal.proposal.problems.length === 0 && <p className="note">確かめを通った案がありませんでした。</p>}
              {currentProposal.proposal.problems.map((p) => (
                <div key={p.problem.threadId} className="ap-proposal-problem" data-testid="ap-proposal-section">
                  <h4 className="note-problem-title">{p.problem.name}</h4>
                  {(['assessment', 'plan'] as const).map((part) =>
                    p[part].length === 0 ? null : (
                      <div key={part} className="note-part">
                        <span className="part-label">{part === 'assessment' ? 'A（評価）' : 'P（方針）'}</span>
                        <ul className="ap-sentences">
                          {p[part].map((s, i) => {
                            const k = key(p.problem.threadId, part, i);
                            return (
                              <li key={k} data-testid="ap-proposal-sentence">
                                <label className="check ap-pick">
                                  <input type="checkbox" checked={picked.has(k)} disabled={busy} onChange={() => { toggle(k); }} data-testid="ap-proposal-pick" />
                                  <span>
                                    {part === 'plan' && s.kind !== undefined && <span className="tag">{PLAN_KIND_NAMES[s.kind]}</span>} {s.text}
                                  </span>
                                </label>
                                <Cites sentence={s} />
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ),
                  )}
                </div>
              ))}
              <div className="actions">
                <button type="button" className="button primary" disabled={busy || picked.size === 0} onClick={adoptPicked} data-testid="ap-proposal-adopt">
                  選んだ {String(picked.size)} 件を A/P に残す
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    const all = new Set<string>();
                    for (const p of currentProposal.proposal.problems) {
                      p.assessment.forEach((_, i) => all.add(key(p.problem.threadId, 'assessment', i)));
                      p.plan.forEach((_, i) => all.add(key(p.problem.threadId, 'plan', i)));
                    }
                    setPicked(all);
                  }}
                  data-testid="ap-proposal-all"
                >
                  すべて選ぶ
                </button>
              </div>
              <p className="note" data-testid="ap-proposal-report">
                <Counts counts={currentProposal} /> <Rejected rejected={currentProposal.proposal.rejected} /> 残したあとで直すと「AI 案を直した」の印になります。
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
