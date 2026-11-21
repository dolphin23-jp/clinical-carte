// 段I：カルテ記載（CA-054。2026-11-21 の本人の決定）。種類（救急外来記録・外来初診・外来再診・入院時記録・プログレスノート・中間サマリー・
// 退院サマリー）と日を選んで「出す」を押すと、出来上がった1つの記載が出る（一文ずつの採用はしない）。
// - 出た記載は、そのまま自分で直すか、AI に頼んで直す（相談のやりとりは保存しない。画面のメモリだけ。CA-032）。
// - 残すのは「保存する」を押したときだけ。文はサーバーで選別（C-1）を通る。「AI が書いた」「AI が書いて先生が直した」「先生が書いた」の印。
// - 記載の中の数のうち、記録・出典に見つからないものに、下線と「※」の印を付ける（消さない。色で判定しない）。core の markNumbers。
// - 病院のカルテへ持っていく向き（コピーのボタン）は作らない（CA-001・CA-033）。
import {
  AP_ORIGIN_NAMES,
  type ApRef,
  type Backing,
  defaultDocDay,
  DOC_ORIGIN_NAMES,
  DOC_SECTION_MAX,
  DOC_SECTIONS,
  DOC_TALK_MAX,
  DOC_TYPE_NAMES,
  DOC_TYPES,
  DOC_TYPES_FOR,
  type DocNotes,
  type DocType,
  hospitalDay,
  markNumbers,
  SHAPE_LABELS,
  type ShapeKind,
  SOURCE_KIND_LABELS,
  threadViews,
} from '@clinical-carte/core';
import { Fragment, useEffect, useState } from 'react';

import { showDateTime } from './format.ts';
import { errorMessage } from './messages.ts';
import { type ApiError, deleteApNote, deleteDocument, documentBacking, type Encounter, generateDocument, patchDocument, type PatientRecord, type RefLabel, reviseDocument, saveDocument } from './net/api.ts';

/** 保存しない画面の誤りの文（「文は保存していません」は、ここでは要らない） */
const say = (error: ApiError): string => errorMessage(error).replace('文は保存していません。', '');

interface WorkSection {
  readonly key: string;
  readonly heading: string;
  readonly text: string;
  readonly refs: readonly ApRef[];
}

/** いま画面で開いている記載（画面のメモリだけ。保存するまで、どこにも残らない） */
interface Work {
  readonly type: DocType;
  readonly day: string;
  readonly sections: readonly WorkSection[];
  /** 誰の文か：AI が書いた（ai）か、先生が書いた（self） */
  readonly origin: 'ai' | 'self';
  /** 先生が自分で直したか */
  readonly edited: boolean;
  /** 残した記載を開いたもの（保存すると、その記載を直す） */
  readonly savedId: string | null;
  /** 保存してから変えたか */
  readonly dirty: boolean;
  readonly backing: Backing | null;
  readonly refLabels: readonly RefLabel[];
  readonly notes: DocNotes | null;
  readonly material: { readonly records: number; readonly shortened: number; readonly dropped: number } | null;
  readonly webFailed: boolean;
}

const withHeadings = (type: DocType, sections: readonly { readonly key: string; readonly text: string; readonly refs?: readonly ApRef[] }[]): WorkSection[] =>
  DOC_SECTIONS[type].map((d) => {
    const got = sections.find((x) => x.key === d.key);
    return { key: d.key, heading: d.heading, text: got?.text ?? '', refs: got?.refs ?? [] };
  });

/** 数の印と「（推論）」を付けて、文を出す（字は変えない） */
function Marked({ text, backing }: { text: string; backing: Backing | null }) {
  const marks = backing === null ? [] : markNumbers(text, backing);
  const out: React.ReactNode[] = [];
  let at = 0;
  const plain = (s: string, key: string) => {
    // 「（推論）」は、AI の推し量りの印（指示で付けさせたもの）。目立たせるだけで、字は変えない
    const parts = s.split(/(（推論）)/u);
    parts.forEach((p, i) => {
      if (p === '') return;
      out.push(
        p === '（推論）' ? (
          <span key={`${key}-${String(i)}`} className="doc-inference">
            {p}
          </span>
        ) : (
          <Fragment key={`${key}-${String(i)}`}>{p}</Fragment>
        ),
      );
    });
  };
  marks.forEach((m, i) => {
    if (m.start > at) plain(text.slice(at, m.start), `t${String(i)}`);
    out.push(
      <span key={`m${String(i)}`} className="num-unbacked" title="記録・出典に見つからない数" data-testid="num-mark">
        {text.slice(m.start, m.end)}
        <sup aria-label="記録に見つからない">※</sup>
      </span>,
    );
    at = m.end;
  });
  if (at < text.length) plain(text.slice(at), 'end');
  return <>{out}</>;
}

function refText(ref: ApRef, record: PatientRecord): string {
  if (ref.k === 'record') {
    const s = record.sources.find((x) => x.id === ref.sourceId);
    return s === undefined ? '記録（消した記載）' : `記録 ${showDateTime(s.at)} ${SOURCE_KIND_LABELS[s.kind]}`;
  }
  if (ref.k === 'book') return `書籍 ${ref.title}${ref.page === null ? '' : ` ${ref.page}`}`;
  return `ネット ${ref.title || ref.url}（${ref.url}）`;
}

function notesText(work: Work): string[] {
  const out: string[] = [];
  const n = work.notes;
  if (n !== null) {
    if (n.unknownSections > 0) out.push(`決めた見出しにない見出し ${String(n.unknownSections)} 件は出していません`);
    if (n.cut > 0) out.push(`長すぎた見出し ${String(n.cut)} 件は ${String(DOC_SECTION_MAX)} 字で切りました`);
    const shapes = Object.entries(n.shapes).filter(([, c]) => c > 0);
    if (shapes.length > 0) out.push(`識別情報の形（${shapes.map(([k, c]) => `${SHAPE_LABELS[k as ShapeKind]} ${String(c)}`).join('・')}）は伏せました`);
    if (n.unknownRefs > 0) out.push(`実在しない根拠の記号 ${String(n.unknownRefs)} 件は、根拠にしていません`);
  }
  const m = work.material;
  if (m !== null) {
    if (m.shortened > 0) out.push(`資料が長いので、古い記載 ${String(m.shortened)} 件は評価と方針の部分だけを渡しました`);
    if (m.dropped > 0) out.push(`資料が長いので、古い記載 ${String(m.dropped)} 件は渡していません`);
  }
  if (work.webFailed) out.push('ネットの出典は集められませんでした（記録と書籍だけで書いています）');
  return out;
}

export function DocumentView({
  record,
  encounter,
  days,
  selectedDay,
  onChanged,
  onLeft,
}: {
  record: PatientRecord;
  encounter: Encounter;
  /** 受診の日（古い順。日の帯と同じ） */
  days: readonly string[];
  /** 日の帯で選んだ日（なければ null） */
  selectedDay: string | null;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const offered = DOC_TYPES_FOR[encounter.kind];
  const [type, setType] = useState<DocType>(offered[0] ?? 'progress');
  const [chosenDay, setChosenDay] = useState<string | null>(null);
  const [web, setWeb] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'revise' | 'save' | null>(null);
  const [work, setWork] = useState<Work | null>(null);
  const [undo, setUndo] = useState<readonly Work[]>([]);
  const [editing, setEditing] = useState(false);
  const [talk, setTalk] = useState<readonly { role: 'doctor' | 'ai'; text: string }[]>([]);
  const [ask, setAsk] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [askRegenerate, setAskRegenerate] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const lastDay = days.at(-1) ?? null;
  const day = chosenDay ?? defaultDocDay(type, encounter, lastDay, selectedDay);
  const dayLabel = (d: string): string => {
    const hd = encounter.kind === 'inpatient' ? hospitalDay(encounter.start, d) : null;
    return `${d.slice(5).replace('-', '/')}${hd === null ? '' : `（${String(hd)}病日）`}`;
  };
  const saved = record.documents.filter((d) => d.encounterId === encounter.id);
  const threads = threadViews(record.problemThreads, record.problems).threads;
  const apNotes = record.apNotes.filter((n) => n.encounterId === encounter.id);

  // 保存した後、サーバーの字（選別で置き換えた後）に合わせる（保存してから変えていなければ）
  useEffect(() => {
    if (work?.savedId === null || work === null || work.dirty) return;
    const doc = record.documents.find((d) => d.id === work.savedId);
    if (doc === undefined) return;
    const sections = withHeadings(doc.type, doc.sections);
    if (sections.some((x, i) => x.text !== work.sections[i]?.text)) setWork({ ...work, sections });
  }, [record.documents, work]);

  const fail = (error: ApiError): void => {
    if (error === 'unregistered') onLeft();
    else setMessage(say(error));
  };

  const generate = () => {
    setBusy('generate');
    setMessage(null);
    setAskRegenerate(false);
    void generateDocument(encounter.id, { type, day, web }).then((r) => {
      setBusy(null);
      if (!r.ok) {
        fail(r.error);
        return;
      }
      setUndo([]);
      setTalk([]);
      setEditing(false);
      setWork({
        type,
        day,
        sections: r.value.document.sections,
        origin: 'ai',
        edited: false,
        savedId: null,
        dirty: true,
        backing: r.value.backing,
        refLabels: r.value.refs,
        notes: r.value.document.notes,
        material: r.value.material,
        webFailed: r.value.webFailed,
      });
    });
  };

  const revise = () => {
    if (work === null || ask.trim() === '') return;
    const instruction = ask.trim();
    setBusy('revise');
    setMessage(null);
    void reviseDocument(encounter.id, { type: work.type, day: work.day, web: false, sections: work.sections.map((x) => ({ key: x.key, text: x.text })), instruction, history: talk }).then((r) => {
      setBusy(null);
      if (!r.ok) {
        fail(r.error);
        return;
      }
      setUndo([...undo, work].slice(-10));
      setTalk([...talk, { role: 'doctor' as const, text: instruction }, { role: 'ai' as const, text: r.value.reply === '' ? '（答えの文はありませんでした）' : r.value.reply }].slice(-20));
      setAsk('');
      // 直した記載：根拠は、AI の答えの根拠（なければ、前の根拠のまま）
      const sections = r.value.document.sections.map((x, i) => ({ ...x, refs: x.refs.length > 0 ? x.refs : (work.sections[i]?.refs ?? []) }));
      setWork({ ...work, sections, dirty: true, backing: r.value.backing, notes: r.value.document.notes, refLabels: r.value.refs.length > 0 ? r.value.refs : work.refLabels, webFailed: false });
    });
  };

  const save = () => {
    if (work === null) return;
    setBusy('save');
    setMessage(null);
    const sections = work.sections.map((x) => ({ key: x.key, text: x.text, refs: [...x.refs] }));
    const done = (id: string) => {
      setBusy(null);
      setWork({ ...work, savedId: id, dirty: false });
      setEditing(false);
      setMessage('保存しました（文は選別を通しています。名前などは置き換わります）。');
      onChanged();
    };
    if (work.savedId !== null) {
      const id = work.savedId;
      void patchDocument(id, sections).then((r) => {
        if (r.ok) done(id);
        else {
          setBusy(null);
          fail(r.error);
        }
      });
      return;
    }
    void saveDocument(encounter.id, { type: work.type, day: work.day, sections, origin: work.origin, edited: work.edited }).then((r) => {
      if (r.ok) done(r.value);
      else {
        setBusy(null);
        fail(r.error);
      }
    });
  };

  const openSaved = (id: string) => {
    const doc = saved.find((d) => d.id === id);
    if (doc === undefined) return;
    setMessage(null);
    setUndo([]);
    setTalk([]);
    setEditing(false);
    setType(doc.type);
    setChosenDay(doc.day);
    const base: Work = {
      type: doc.type,
      day: doc.day,
      sections: withHeadings(doc.type, doc.sections),
      origin: doc.origin === 'self' ? 'self' : 'ai',
      edited: doc.origin === 'ai_edited',
      savedId: doc.id,
      dirty: false,
      backing: null,
      refLabels: [],
      notes: null,
      material: null,
      webFailed: false,
    };
    setWork(base);
    // 数の印の照らし合わせの表（AI を使わない）
    void documentBacking(encounter.id, { type: doc.type, day: doc.day }).then((r) => {
      if (r.ok) setWork((w) => (w !== null && w.savedId === doc.id ? { ...w, backing: r.value } : w));
    });
  };

  const startBlank = () => {
    setMessage(null);
    setUndo([]);
    setTalk([]);
    setWork({ type, day, sections: withHeadings(type, []), origin: 'self', edited: false, savedId: null, dirty: true, backing: null, refLabels: [], notes: null, material: null, webFailed: false });
    setEditing(true);
    void documentBacking(encounter.id, { type, day }).then((r) => {
      if (r.ok) setWork((w) => (w !== null && w.savedId === null && w.origin === 'self' ? { ...w, backing: r.value } : w));
    });
  };

  const marks = work === null || work.backing === null ? 0 : work.sections.reduce((n, x) => n + markNumbers(x.text, work.backing as Backing).length, 0);
  const others = DOC_TYPES.filter((t) => !offered.includes(t));
  const changedKeys = (() => {
    const prev = undo.at(-1);
    if (work === null || prev === undefined) return new Set<string>();
    return new Set(work.sections.filter((x, i) => x.text !== prev.sections[i]?.text).map((x) => x.key));
  })();

  return (
    <div className="doc-view" data-testid="doc-view">
      <div className="doc-pick">
        <div className="chips" role="radiogroup" aria-label="記載の種類" data-testid="doc-types">
          {offered.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              className={type === t ? 'chip on' : 'chip'}
              onClick={() => {
                setType(t);
                setChosenDay(null);
              }}
              data-testid={`doc-type-${t}`}
            >
              {DOC_TYPE_NAMES[t]}
            </button>
          ))}
          <label className="doc-other">
            <span className="sr-only">ほかの種類</span>
            <select
              value={offered.includes(type) ? '' : type}
              onChange={(e) => {
                if (e.target.value !== '') {
                  setType(e.target.value as DocType);
                  setChosenDay(null);
                }
              }}
              data-testid="doc-type-other"
            >
              <option value="">ほかの種類…</option>
              {others.map((t) => (
                <option key={t} value={t}>
                  {DOC_TYPE_NAMES[t]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="doc-options">
          <label>
            {type === 'progress' ? 'その日' : 'この日の時点'}
            <select
              value={day}
              onChange={(e) => {
                setChosenDay(e.target.value);
              }}
              data-testid="doc-day"
            >
              {[...new Set([...days, day])].sort().reverse().map((d) => (
                <option key={d} value={d}>
                  {dayLabel(d)}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={web}
              onChange={(e) => {
                setWeb(e.target.checked);
              }}
              data-testid="doc-web"
            />
            ネットの出典も探す（時間と AI の回数が増えます）
          </label>
        </div>
        <div className="row-actions">
          {askRegenerate ? (
            <>
              <button type="button" className="button primary" onClick={generate} disabled={busy !== null} data-testid="doc-generate-confirm">
                直したところを捨てて出し直す
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setAskRegenerate(false);
                }}
              >
                やめる
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button primary big"
              disabled={busy !== null}
              onClick={() => {
                if (work !== null && work.dirty && work.savedId === null && (work.edited || undo.length > 0)) setAskRegenerate(true);
                else generate();
              }}
              data-testid="doc-generate"
            >
              {busy === 'generate' ? '書いています…' : `${DOC_TYPE_NAMES[type]}を出す`}
            </button>
          )}
          <button type="button" className="button small" disabled={busy !== null} onClick={startBlank} data-testid="doc-blank">
            見出しだけで、自分で書く
          </button>
        </div>
        {busy === 'generate' && (
          <p className="note" data-testid="doc-busy">
            記録から書いています。1分ほどかかることがあります。
          </p>
        )}
        <p className="note">記録（保存した文と整理した事実）だけから書きます。書かれていないことは空欄のままです。病院のカルテの正本ではありません。</p>
      </div>

      {message !== null && (
        <p className="alert" role="alert" data-testid="doc-message">
          {message}
        </p>
      )}

      {work !== null && (
        <section className="doc card-inner" data-testid="doc" aria-label="記載">
          <div className="doc-head">
            <h3 className="sub-title">
              {DOC_TYPE_NAMES[work.type]} {dayLabel(work.day)}
            </h3>
            <span className="tag" data-testid="doc-origin">
              {work.origin === 'self' ? DOC_ORIGIN_NAMES.self : work.edited ? DOC_ORIGIN_NAMES.ai_edited : DOC_ORIGIN_NAMES.ai}
            </span>
            <span className="tag" data-testid="doc-state">
              {work.savedId === null ? 'まだ保存していません' : work.dirty ? '保存してから変えました' : '保存しました'}
            </span>
          </div>
          {work.backing !== null && (
            <p className="note" data-testid="doc-marks-legend">
              {marks === 0 ? '記載の中の数は、すべて記録・出典に見つかりました。' : `下線と「※」の数（${String(marks)} 個）は、記録・出典に見つかりませんでした。確かめてください。`}
            </p>
          )}
          {notesText(work).length > 0 && (
            <ul className="doc-notes" data-testid="doc-notes">
              {notesText(work).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}

          {work.sections.map((x, i) => (
            <div key={x.key} className={changedKeys.has(x.key) ? 'doc-section changed' : 'doc-section'} data-testid="doc-section" data-key={x.key}>
              <h4 className="doc-heading">
                【{x.heading}】{changedKeys.has(x.key) && <span className="tag">AI が直した</span>}
              </h4>
              {editing ? (
                <textarea
                  className="doc-edit"
                  value={x.text}
                  rows={Math.min(16, Math.max(2, x.text.split('\n').length + 1))}
                  maxLength={DOC_SECTION_MAX}
                  aria-label={`${x.heading}を直す`}
                  onChange={(e) => {
                    const sections = work.sections.map((y, j) => (j === i ? { ...y, text: e.target.value } : y));
                    setWork({ ...work, sections, edited: work.origin === 'ai' ? true : work.edited, dirty: true });
                  }}
                  data-testid="doc-edit-text"
                />
              ) : x.text === '' ? (
                <p className="doc-empty">（記録に書かれていません）</p>
              ) : (
                <p className="doc-text" data-testid="doc-section-text">
                  <Marked text={x.text} backing={work.backing} />
                </p>
              )}
              {x.refs.length > 0 && <p className="doc-refs">根拠：{x.refs.map((r) => refText(r, record)).join('・')}</p>}
            </div>
          ))}

          <div className="row-actions doc-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setEditing(!editing);
              }}
              data-testid="doc-edit"
            >
              {editing ? '直すのを終える' : '自分で直す'}
            </button>
            <button type="button" className="button primary" disabled={busy !== null || (work.savedId !== null && !work.dirty) || work.sections.every((x) => x.text.trim() === '')} onClick={save} data-testid="doc-save">
              {busy === 'save' ? '保存しています…' : work.savedId === null ? '保存する' : '直したものを保存する'}
            </button>
            {undo.length > 0 && (
              <button
                type="button"
                className="button small"
                onClick={() => {
                  const prev = undo.at(-1);
                  if (prev !== undefined) {
                    setWork({ ...prev, dirty: true });
                    setUndo(undo.slice(0, -1));
                  }
                }}
                data-testid="doc-undo"
              >
                AI が直す前に戻す
              </button>
            )}
          </div>

          <div className="doc-talk" data-testid="doc-talk">
            <h4 className="part-label">AI と相談して直す（やりとりは保存しません）</h4>
            {talk.length > 0 && (
              <ul className="talk">
                {talk.map((t, i) => (
                  <li key={i} className={t.role === 'ai' ? 'talk-ai' : 'talk-doctor'} data-testid={t.role === 'ai' ? 'doc-reply' : 'doc-asked'}>
                    <span className="tag">{t.role === 'ai' ? 'AI' : '先生'}</span>
                    {t.text}
                  </li>
                ))}
              </ul>
            )}
            <textarea
              value={ask}
              maxLength={DOC_TALK_MAX}
              rows={2}
              placeholder="例：A/P を問題ごとに短く。#2 の評価に、○○の可能性も書いて。経過を時系列に。"
              onChange={(e) => {
                setAsk(e.target.value);
              }}
              data-testid="doc-ask-text"
            />
            <div className="row-actions">
              <button type="button" className="button" disabled={busy !== null || ask.trim() === ''} onClick={revise} data-testid="doc-ask">
                {busy === 'revise' ? '直しています…' : 'AI に頼む・聞く'}
              </button>
            </div>
          </div>
          {refLabelsLine(work.refLabels)}
        </section>
      )}

      <section className="doc-saved" data-testid="doc-saved-list" aria-label="保存した記載">
        <h3 className="sub-title">保存した記載（{String(saved.length)}）</h3>
        {saved.length === 0 ? (
          <p className="note">まだ保存した記載はありません。</p>
        ) : (
          <ul className="fact-list">
            {saved.map((d) => (
              <li key={d.id} className="fact-row" data-testid="doc-saved-item">
                <span className="fact-when">{dayLabel(d.day)}</span>
                <span className="fact-main">
                  {DOC_TYPE_NAMES[d.type]}
                  <span className="tag">{DOC_ORIGIN_NAMES[d.origin]}</span>
                  <span className="row-sub">更新 {showDateTime(d.updatedAt)}</span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="button small"
                    onClick={() => {
                      openSaved(d.id);
                    }}
                    data-testid="doc-saved-open"
                  >
                    開く
                  </button>
                  {deleting === d.id ? (
                    <>
                      <button
                        type="button"
                        className="button danger small"
                        onClick={() => {
                          void deleteDocument(d.id).then((r) => {
                            setDeleting(null);
                            if (r.ok || r.error === 'not_found') {
                              if (work?.savedId === d.id) setWork(null);
                              onChanged();
                            } else fail(r.error);
                          });
                        }}
                        data-testid="doc-saved-confirm-delete"
                      >
                        消す（戻せません）
                      </button>
                      <button
                        type="button"
                        className="button small"
                        onClick={() => {
                          setDeleting(null);
                        }}
                      >
                        やめる
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button small"
                      onClick={() => {
                        setDeleting(d.id);
                      }}
                      data-testid="doc-saved-delete"
                    >
                      消す
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {apNotes.length > 0 && (
        <details className="doc-old-ap" data-testid="doc-old-ap">
          <summary>これまでに残した A/P（問題ごと。{String(apNotes.length)} 件）</summary>
          <p className="note">前の版の画面で、問題ごとに残した A/P です。記載を出すときの資料に入ります。</p>
          <ul className="fact-list">
            {apNotes.map((n) => (
              <li key={n.id} className="fact-row">
                <span className="fact-when">{dayLabel(n.day)}</span>
                <span className="fact-main">
                  <span className="tag">{threads.find((t) => t.id === n.threadId)?.name ?? '問題'}</span>
                  <span className="tag">{n.part === 'assessment' ? 'A' : 'P'}</span>
                  {n.text}
                  <span className="tag">{AP_ORIGIN_NAMES[n.origin]}</span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="button small"
                    onClick={() => {
                      void deleteApNote(n.id).then((r) => {
                        if (r.ok || r.error === 'not_found') onChanged();
                        else fail(r.error);
                      });
                    }}
                  >
                    消す
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function refLabelsLine(refs: readonly RefLabel[]) {
  if (refs.length === 0) return null;
  return (
    <details className="doc-refs-all" data-testid="doc-refs">
      <summary>資料にした出典（{String(refs.length)}）</summary>
      <ul>
        {refs.map((r) => (
          <li key={r.id}>
            {r.kind === 'book' ? '書籍' : 'ネット'}：{r.label}
          </li>
        ))}
      </ul>
    </details>
  );
}
