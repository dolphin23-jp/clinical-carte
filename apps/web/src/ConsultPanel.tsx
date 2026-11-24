// 相談の窓口（段M。CA-081）：この患者について、何でも相談する（全体の方針・いまのアセスメント・確かめる検査・治療の方針・小さな疑問）。
// carte が持っている記録（写した文と、整理した事実・プロブレムリスト・スコア）と、書籍（本人の clinical-RAG）・ネットの出典から、AI が答える。
// - 2つの答え方を、1つの窓口で切り替える：「相談する」（書籍・ガイドラインも踏まえる）と「記録だけから答える」（段K6 の記録に聞く。CA-066 のまま）
// - 問い・前のやりとり・答えは、画面のメモリだけ（患者の画面を開いているあいだ。読み込み直す・ほかの患者へ移ると消える）。端末の保存先は使わない
// - 残るのは、先生が「この答えを残す」を押した答えだけ（サーバーで選別を通す。問いの文は送らない・残さない）
// - 書籍・ネットの検索に渡すのは、問題の名前と、問いの一般的な語だけ。何を渡したかを、答えの下にいつも出す
// - 臨床支援の決まり（CA-059）：「臨床支援の草案・最終判断は先生」をいつも出す。出典の引用に基づかない文には「（推論）」、資料・出典にない数には下線と「※」。
//   出さなかった文は、理由ごとの数で出す（黙って捨てない）。画面の外への知らせは作らない
// - 問い・前のやりとりに電話番号・メールなどの形があれば、送らない（core の consultHasShapes・findShapes。サーバーも同じ関数で断る）
// 段M2（CA-082〜CA-085）：
// - 答えは、確かめた文から順に出る（CA-085。サーバーが確かめた後の文だけが届く。最後に、見出しの順に並べ直す）
// - 前の受診の記録も資料にできる（CA-084。受診が2つ以上あるとき。既定は入れる）
// - 残した答えは直せる（CA-083。打った字は、サーバーで選別を通す。「先生が直した」の印が付く）
// - 答えの文は、1つずつ押して、カルテ記載の下書きの候補（「記載へ」）と、指示簿（「指示簿へ」。欄を選び、字を確かめてから。「AI の案」の印）へ入れられる（CA-082）。
//   記載の候補は、画面のメモリだけ：残るのは、記載の「保存する」を押したとき。病院のカルテへ戻すコピーは作らない
import {
  type ApRef,
  ASK_QUESTION_MAX,
  askNoteRefs,
  askNoteText,
  type AskReply,
  CONSULT_NOTE_MAX,
  CONSULT_QUESTION_MAX,
  CONSULT_REJECT_NAMES,
  CONSULT_REJECT_REASONS,
  CONSULT_SECTION_NAMES,
  CONSULT_SECTIONS,
  CONSULT_STAGE_NAMES,
  CONSULT_TURN_TEXT_MAX,
  CONSULT_TURNS_MAX,
  consultHasShapes,
  type ConsultNote,
  consultNoteLabel,
  type ConsultNoteMode,
  consultNoteRefs,
  consultNoteText,
  consultOrderNew,
  consultOrderText,
  consultPick,
  type ConsultPick,
  type ConsultReply,
  type ConsultSection,
  type ConsultStage,
  type ConsultStatement,
  type ConsultTurn,
  findShapes,
  ORDER_CATEGORIES,
  ORDER_CATEGORY_SHORT,
  ORDER_TEXT_MAX,
  type OrderCategory,
  SOURCE_KIND_LABELS,
} from '@clinical-carte/core';
import { useEffect, useId, useRef, useState } from 'react';

import { AskAnswerView } from './AskView.tsx';
import { showDateTime } from './format.ts';
import { Icon } from './Icon.tsx';
import { errorMessage } from './messages.ts';
import { addConsultNote, addOrders, type ApiError, askRecord, consultPatient, deleteConsultNote, patchConsultNote, type PatientRecord } from './net/api.ts';
import { Marked } from './SupportView.tsx';

/** やりとりの1つ（画面のメモリだけ） */
export type ConsultEntry = { readonly id: number; readonly question: string; readonly kept: boolean } & (
  | { readonly mode: 'consult'; readonly reply: ConsultReply }
  | { readonly mode: 'record'; readonly reply: AskReply }
);

export interface ConsultState {
  readonly mode: ConsultNoteMode;
  readonly setMode: (mode: ConsultNoteMode) => void;
  readonly draft: string;
  readonly setDraft: (text: string) => void;
  /** ネットの出典も探す（画面のメモリだけ。既定は探す） */
  readonly web: boolean;
  readonly setWeb: (web: boolean) => void;
  /** 前の受診の記録も資料にする（CA-084。画面のメモリだけ。既定は入れる） */
  readonly past: boolean;
  readonly setPast: (past: boolean) => void;
  /** 相談の途中（CA-085）：いま何をしているかと、届いた文（サーバーが確かめた後の文。書かれた順）。相談していなければ null */
  readonly progress: { readonly stage: ConsultStage | null; readonly statements: readonly ConsultStatement[] } | null;
  /** 新しいものが先 */
  readonly entries: readonly ConsultEntry[];
  readonly busy: boolean;
  readonly message: string | null;
  readonly keeping: number | null;
  readonly send: () => void;
  readonly keep: (id: number) => void;
  readonly reset: () => void;
}

/** よく使う問い（押すと、問いの欄に入る。送るのは、先生が押したとき） */
const QUICK: Readonly<Record<ConsultNoteMode, readonly string[]>> = {
  consult: ['全体の方針をまとめて', 'いまのアセスメントは？', '次に確かめる検査は？', '治療の方針は？', '見落としていることは？'],
  record: ['これまでの経過をまとめて', '抗菌薬はいつから、何を？', '家族への説明は何回？'],
};

const say = (error: ApiError): string => errorMessage(error).replace('文は保存していません。', '').replace('記載か頼みに', '問い・前のやりとりに');

/** 前のやりとりを、続きの相談の資料にする（古い順。新しいものから CONSULT_TURNS_MAX 個まで） */
function turnsOf(entries: readonly ConsultEntry[]): ConsultTurn[] {
  return entries
    .slice(0, CONSULT_TURNS_MAX)
    .reverse()
    .map((e) => ({ question: e.question.slice(0, CONSULT_QUESTION_MAX), answer: (e.mode === 'consult' ? consultNoteText(e.reply) : askNoteText(e.reply)).slice(0, CONSULT_TURN_TEXT_MAX) }));
}

/** 相談の窓口の係（患者の画面に1つ）。やりとりは、ここのメモリだけ */
export function useConsult(patientId: string, onChanged: () => void, onLeft: () => void): ConsultState {
  const [mode, setMode] = useState<ConsultNoteMode>('consult');
  const [draft, setDraft] = useState('');
  const [web, setWeb] = useState(true);
  const [past, setPast] = useState(true);
  const [progress, setProgress] = useState<ConsultState['progress']>(null);
  const [entries, setEntries] = useState<readonly ConsultEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [keeping, setKeeping] = useState<number | null>(null);
  const [serial, setSerial] = useState(1);

  const failed = (error: ApiError) => {
    if (error === 'unregistered') onLeft();
    else setMessage(say(error));
  };
  const send = () => {
    const question = draft.trim();
    if (question === '' || busy) return;
    const turns = mode === 'consult' ? turnsOf(entries) : [];
    // 識別情報の形があれば、送らない
    if (mode === 'consult' ? consultHasShapes({ question, turns }) : findShapes(question).length > 0) {
      setMessage(say('shape'));
      return;
    }
    setBusy(true);
    setMessage(null);
    const id = serial;
    setSerial(serial + 1);
    const add = (entry: ConsultEntry) => {
      setEntries((list) => [entry, ...list]);
      setDraft('');
    };
    if (mode === 'consult') {
      setProgress({ stage: null, statements: [] });
      void consultPatient(
        patientId,
        { question, turns, web, past },
        {
          onStage: (stage) => {
            setProgress((p) => ({ stage, statements: p?.statements ?? [] }));
          },
          onStatement: (statement) => {
            setProgress((p) => ({ stage: p?.stage ?? 'answer', statements: [...(p?.statements ?? []), statement] }));
          },
        },
      ).then((r) => {
        setBusy(false);
        setProgress(null);
        if (r.ok) add({ id, mode: 'consult', question, kept: false, reply: r.value });
        else failed(r.error);
      });
    } else {
      void askRecord(patientId, question.slice(0, ASK_QUESTION_MAX)).then((r) => {
        setBusy(false);
        if (r.ok) add({ id, mode: 'record', question, kept: false, reply: r.value });
        else failed(r.error);
      });
    }
  };
  const keep = (id: number) => {
    const entry = entries.find((e) => e.id === id);
    if (entry === undefined || entry.kept || keeping !== null) return;
    const note = entry.mode === 'consult' ? { mode: entry.mode, text: consultNoteText(entry.reply), refs: consultNoteRefs(entry.reply) } : { mode: entry.mode, text: askNoteText(entry.reply), refs: askNoteRefs(entry.reply) };
    if (note.text.trim() === '') return;
    setKeeping(id);
    setMessage(null);
    void addConsultNote(patientId, note).then((r) => {
      setKeeping(null);
      if (r.ok) {
        setEntries((list) => list.map((e) => (e.id === id ? { ...e, kept: true } : e)));
        onChanged();
      } else if (r.error === 'unregistered') onLeft();
      else setMessage(`残せませんでした（${errorMessage(r.error).replace('文は保存していません。', '')}）`);
    });
  };
  const reset = () => {
    setEntries([]);
    setMessage(null);
  };
  return { mode, setMode, draft, setDraft, web, setWeb, past, setPast, progress, entries, busy, message, keeping, send, keep, reset };
}

/** 出典の字（書籍は題と頁、ネットは題と URL。外へのリンクにはしない） */
function citeText(ref: ApRef): string {
  if (ref.k === 'book') return `書籍 ${ref.title}${ref.page === null ? '' : ` ${ref.page}`}${ref.path === null ? '' : `（${ref.path}）`}`;
  if (ref.k === 'web') return `ネット ${ref.title || ref.url}（${ref.url}）`;
  return '記録';
}

/** 見出しごとの、指示簿の欄の初めの選び（先生が選び直す） */
const ORDER_CATEGORY_FOR: Readonly<Record<ConsultSection, OrderCategory>> = { summary: 'other', assessment: 'other', workup: 'test', treatment: 'other', caution: 'call', other: 'other' };

/** 答えの文を、記載の下書き・指示簿へ入れる先（CA-082） */
export interface ConsultTargets {
  /** 記載の下書きに足す候補（画面のメモリ）と、その出し入れ */
  readonly picks: readonly ConsultPick[];
  readonly onTogglePick: (pick: ConsultPick) => void;
  /** 指示簿に入れる受診（いちばん新しい受診。なければ null） */
  readonly orderEncounterId: string | null;
  readonly onChanged: () => void;
  readonly onLeft: () => void;
}

/** 答えの文の1つを、指示簿へ入れる（CA-082）：欄を選び、字を確かめて（直せる）から。字はサーバーで選別を通り、「AI の案」の印で入る */
function OrderFromConsult({ statement, encounterId, onChanged, onLeft }: { statement: ConsultStatement; encounterId: string; onChanged: () => void; onLeft: () => void }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<OrderCategory>(ORDER_CATEGORY_FOR[statement.section]);
  const [text, setText] = useState(() => consultOrderText(statement));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<OrderCategory | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const textId = useId();
  if (done !== null) {
    return (
      <span className="note consult-ordered" data-testid="consult-ordered">
        <Icon name="check" />
        指示簿（{ORDER_CATEGORY_SHORT[done]}）に入れました
      </span>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        className="chip small"
        onClick={() => {
          setOpen(true);
        }}
        data-testid="consult-to-order"
      >
        <Icon name="orders" />
        指示簿へ
      </button>
    );
  }
  return (
    <div className="consult-order-form" data-testid="consult-order-form">
      <label className="ask-label">
        欄
        <select
          value={category}
          onChange={(e) => {
            const picked = ORDER_CATEGORIES.find((c) => c === e.target.value);
            if (picked !== undefined) setCategory(picked);
          }}
          data-testid="consult-order-category"
        >
          {ORDER_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {ORDER_CATEGORY_SHORT[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="ask-label" htmlFor={textId}>
        指示の字（確かめて、指示の形に直してください。用量・速度は、指示簿で足します）
      </label>
      <textarea
        id={textId}
        rows={3}
        maxLength={ORDER_TEXT_MAX}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        data-testid="consult-order-text"
      />
      <div className="actions">
        <button
          type="button"
          className="button small primary"
          disabled={busy || text.trim() === ''}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            void addOrders(encounterId, [consultOrderNew(statement, category, text)]).then((r) => {
              setBusy(false);
              if (r.ok) {
                setDone(category);
                onChanged();
              } else if (r.error === 'unregistered') onLeft();
              else setMessage(`指示簿に入れられませんでした（${errorMessage(r.error).replace('文は保存していません。', '')}）`);
            });
          }}
          data-testid="consult-order-add"
        >
          {busy ? '入れています…' : '指示簿に入れる（AI の案の印）'}
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => {
            setOpen(false);
          }}
        >
          やめる
        </button>
      </div>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

/** 答えの文の1つ：文（※・「（推論）」）・根拠の札・出典。targets があれば、記載の下書き・指示簿へ入れるボタン */
function StatementView({ statement: s, pickKey, onOpenSource, targets }: { statement: ConsultStatement; pickKey: string; onOpenSource: (sourceId: string) => void; targets: ConsultTargets | null }) {
  const picked = targets?.picks.some((p) => p.key === pickKey) ?? false;
  return (
    <li className={s.inferred ? 'consult-statement inferred' : 'consult-statement cited'} data-testid="consult-statement">
      <p className="support-text">
        <Marked value={{ text: s.text, marks: [...s.marks] }} />
      </p>
      {s.support.length > 0 && (
        <div className="chips consult-refs">
          {s.support.map((ref) =>
            ref.sourceId === null ? (
              <span key={ref.id} className="tag" data-testid="consult-ref">
                {ref.label}
              </span>
            ) : (
              <button
                key={ref.id}
                type="button"
                className="chip small"
                onClick={() => {
                  if (ref.sourceId !== null) onOpenSource(ref.sourceId);
                }}
                data-testid="consult-ref-open"
              >
                <Icon name="notes" />
                {ref.label}
              </button>
            ),
          )}
        </div>
      )}
      {s.citations.map((c, j) => (
        <p key={String(j)} className="thread-sub consult-cite" data-testid="consult-cite">
          <Icon name="book" />
          {citeText(c)}
        </p>
      ))}
      {targets !== null && (
        <div className="chips consult-to" data-testid="consult-to">
          <button
            type="button"
            className={picked ? 'chip small on' : 'chip small'}
            aria-pressed={picked}
            onClick={() => {
              targets.onTogglePick(consultPick(pickKey, s));
            }}
            data-testid="consult-to-note"
          >
            <Icon name={picked ? 'check' : 'edit'} />
            {picked ? '記載の候補に入れた' : '記載へ'}
          </button>
          {targets.orderEncounterId !== null && <OrderFromConsult statement={s} encounterId={targets.orderEncounterId} onChanged={targets.onChanged} onLeft={targets.onLeft} />}
        </div>
      )}
    </li>
  );
}

/** 相談の答え：見出しごとの文・根拠の札・出典・答えられなかったこと・出さなかったものの数・外の検索に渡した語・資料の範囲 */
function ConsultAnswerView({ entryId, reply, onOpenSource, targets }: { entryId: number; reply: ConsultReply; onOpenSource: (sourceId: string) => void; targets: ConsultTargets }) {
  const rejected = CONSULT_REJECT_REASONS.flatMap((r) => ((reply.rejected[r] ?? 0) > 0 ? [`${CONSULT_REJECT_NAMES[r]} ${String(reply.rejected[r] ?? 0)} 件`] : []));
  const marks = reply.statements.reduce((n, s) => n + s.marks.length, 0);
  const dropped = reply.dropped.records + reply.dropped.shortened + reply.dropped.values + reply.dropped.course;
  const sent = [...reply.research.names, ...reply.research.terms];
  return (
    <div className="consult-answer" data-testid="consult-answer">
      {CONSULT_SECTIONS.map((section) => {
        const list = reply.statements.map((s, index) => ({ s, index })).filter(({ s }) => s.section === section);
        return list.length === 0 ? null : (
          <section key={section} className="consult-section" data-testid={`consult-section-${section}`}>
            <h4 className="consult-section-title">{CONSULT_SECTION_NAMES[section]}</h4>
            <ul className="support-list">
              {list.map(({ s, index }) => (
                <StatementView key={String(index)} statement={s} pickKey={`${String(entryId)}-${String(index)}`} onOpenSource={onOpenSource} targets={targets} />
              ))}
            </ul>
          </section>
        );
      })}
      {reply.statements.length === 0 && <p className="note">確かめに通った答えは、ありませんでした。問いを変えて、もう一度相談してください。</p>}
      {reply.unknown !== '' && (
        <p className="note consult-unknown" data-testid="consult-unknown">
          答えられなかったこと：{reply.unknown}
        </p>
      )}
      <div className="consult-foot">
        {marks > 0 && <p className="note">下線と「※」の数は、記録・出典に見つかりませんでした。確かめてください。</p>}
        {rejected.length > 0 && (
          <p className="note" data-testid="consult-rejected">
            出さなかったもの：{rejected.join('・')}
          </p>
        )}
        {reply.shapes > 0 && <p className="note">電話番号・メールなどの形 {String(reply.shapes)} 個を伏せました。</p>}
        {dropped > 0 && (
          <p className="note" data-testid="consult-dropped">
            資料の長さのため、古い記載 {String(reply.dropped.records)} 件・評価と方針だけにした記載 {String(reply.dropped.shortened)} 件・値 {String(reply.dropped.values)} 件・経過の出来事 {String(reply.dropped.course)} 件は、AI に全文を渡していません。
          </p>
        )}
        <p className="note" data-testid="consult-scope">
          資料にした記載：{String(reply.scope.records)} 件（{reply.scope.encounters <= 1 ? 'いまの受診の分' : reply.scope.past ? `前の受診を含む、受診 ${String(reply.scope.encounters)} 回の分` : 'いまの受診と、直前の救急の受診の分'}）。値・薬・スコアは、いまの受診の分です。
        </p>
        <p className="note" data-testid="consult-research">
          {sent.length === 0
            ? '書籍・ネットは探していません（どの文も、記録からの推論です）。'
            : `資料にした出典：書籍 ${String(reply.research.books)} 件・ネット ${String(reply.research.web)} 件${reply.research.webFailed ? '（ネットは、探せませんでした）' : ''}。検索に渡した語：${sent.join('・')}`}
        </p>
      </div>
    </div>
  );
}

/** 残した答えの1つ（選別を通した後の字）。直せる（CA-083。打った字は、サーバーで選別を通す。「先生が直した」の印が付く）・消せる */
function KeptNote({ note, record, onChanged, onLeft }: { note: ConsultNote; record: PatientRecord; onChanged: () => void; onLeft: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 直している字（画面のメモリだけ。null は、直していない）
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveEdit = () => {
    if (draft === null || draft.trim() === '' || saving) return;
    setSaving(true);
    setMessage(null);
    void patchConsultNote(note.id, draft).then((r) => {
      setSaving(false);
      if (r.ok) {
        setDraft(null);
        onChanged();
      } else if (r.error === 'unregistered') onLeft();
      else setMessage(`直したものを残せませんでした（${errorMessage(r.error).replace('文は保存していません。', '')}）`);
    });
  };
  const refText = (ref: ApRef): string => {
    if (ref.k !== 'record') return citeText(ref);
    const s = record.sources.find((x) => x.id === ref.sourceId);
    return s === undefined ? '記録（消した記載）' : `記録 ${SOURCE_KIND_LABELS[s.kind]}・${showDateTime(s.at)}`;
  };
  const refs = [...new Set(note.refs.map(refText))];
  return (
    <details className="consult-kept" data-testid="consult-kept">
      <summary>
        <span className="tag ai-tag" data-testid="consult-kept-label">
          {consultNoteLabel(note)}
        </span>
        <span className="consult-kept-when">{showDateTime(note.edited ? note.updatedAt : note.enteredAt)}</span>
        <span className="consult-kept-head">{note.text.split('\n').find((l) => !l.startsWith('【')) ?? ''}</span>
      </summary>
      {draft === null ? (
        <p className="source-text consult-kept-text" data-testid="consult-kept-text">
          {note.text}
        </p>
      ) : (
        <>
          <textarea
            className="consult-kept-edit"
            rows={Math.min(16, Math.max(4, draft.split('\n').length + 1))}
            maxLength={CONSULT_NOTE_MAX}
            value={draft}
            aria-label="残した答えを直す"
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            data-testid="consult-kept-edit-text"
          />
          <p className="note">直した字は、選別を通してから残ります（名前などは置き換わります）。「先生が直した」の印が付きます。</p>
        </>
      )}
      {refs.length > 0 && <p className="thread-sub">根拠：{refs.join(' ／ ')}</p>}
      <div className="actions">
        {draft !== null ? (
          <>
            <button type="button" className="button small primary" disabled={saving || draft.trim() === '' || draft === note.text} onClick={saveEdit} data-testid="consult-kept-edit-save">
              {saving ? '残しています…' : '直したものを残す'}
            </button>
            <button
              type="button"
              className="button small"
              disabled={saving}
              onClick={() => {
                setDraft(null);
              }}
            >
              やめる
            </button>
          </>
        ) : confirm ? (
          <>
            <button
              type="button"
              className="button small danger"
              onClick={() => {
                void deleteConsultNote(note.id).then((r) => {
                  if (r.ok || r.error === 'not_found') onChanged();
                  else if (r.error === 'unregistered') onLeft();
                  else setMessage(errorMessage(r.error));
                });
              }}
              data-testid="consult-kept-delete-confirm"
            >
              消す（戻せません）
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => {
                setConfirm(false);
              }}
            >
              やめる
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button small"
              onClick={() => {
                setDraft(note.text);
              }}
              data-testid="consult-kept-edit"
            >
              直す
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => {
                setConfirm(true);
              }}
              data-testid="consult-kept-delete"
            >
              消す
            </button>
          </>
        )}
      </div>
      {message !== null && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}
    </details>
  );
}

export function ConsultPanel({
  consult,
  record,
  onClose,
  onOpenSource,
  onChanged,
  onLeft,
  picks,
  onTogglePick,
  onOpenDocument,
}: {
  consult: ConsultState;
  record: PatientRecord;
  onClose: () => void;
  /** 根拠の記載を、記録のタブで開く */
  onOpenSource: (sourceId: string) => void;
  onChanged: () => void;
  onLeft: () => void;
  /** 記載の下書きに足す候補（CA-082。画面のメモリ）と、その出し入れ・カルテ記載を開く */
  picks: readonly ConsultPick[];
  onTogglePick: (pick: ConsultPick) => void;
  onOpenDocument: () => void;
}) {
  // 指示簿に入れる先は、いちばん新しい受診（相談の資料の、値・薬・スコアと同じ受診）
  const targets: ConsultTargets = { picks, onTogglePick, orderEncounterId: record.encounters.at(-1)?.id ?? null, onChanged, onLeft };
  const { mode, entries, busy } = consult;
  const max = mode === 'consult' ? CONSULT_QUESTION_MAX : ASK_QUESTION_MAX;
  const [latest, ...older] = entries;
  // 新しい答えが届いたら、その答えの頭へ動かす（画面の位置だけ。開き直したときは動かさない）
  const newestRef = useRef<HTMLElement>(null);
  const seen = useRef(latest?.id ?? 0);
  useEffect(() => {
    const id = latest?.id ?? 0;
    if (id === seen.current) return;
    seen.current = id;
    if (id !== 0) newestRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [latest?.id]);
  const entryView = (e: ConsultEntry) => (
    <>
      {e.mode === 'consult' ? <ConsultAnswerView entryId={e.id} reply={e.reply} onOpenSource={onOpenSource} targets={targets} /> : <AskAnswerView record={record} reply={e.reply} />}
      <div className="consult-keep">
        {e.kept ? (
          <span className="note" data-testid="consult-kept-done">
            <Icon name="check" />
            残しました（下の「残した答え」に入っています）
          </span>
        ) : (
          <button
            type="button"
            className="button small"
            disabled={consult.keeping !== null || (e.mode === 'consult' ? e.reply.statements.length === 0 && e.reply.unknown === '' : e.reply.answer.length === 0 && e.reply.notFound === '')}
            onClick={() => {
              consult.keep(e.id);
            }}
            data-testid="consult-keep"
          >
            {consult.keeping === e.id ? '残しています…' : 'この答えを残す'}
          </button>
        )}
        {!e.kept && <span className="note">押した答えだけが残ります（問いは残しません）。</span>}
      </div>
    </>
  );

  return (
    <section className="consult" data-testid="consult" aria-labelledby="consult-title">
      <div className="consult-head">
        <h2 id="consult-title" className="section-head">
          <Icon name="consult" />
          相談 <span className="tag ai-tag">AI</span>
          {mode === 'consult' && <span className="tag support-tag">臨床支援</span>}
        </h2>
        <button type="button" className="button small" onClick={onClose} data-testid="consult-close">
          閉じる
        </button>
      </div>

      <div className="consult-modes" role="group" aria-label="答え方">
        {(['consult', 'record'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={mode === m ? 'chip on' : 'chip'}
            aria-pressed={mode === m}
            onClick={() => {
              consult.setMode(m);
            }}
            data-testid={`consult-mode-${m}`}
          >
            <Icon name={m === 'consult' ? 'book' : 'notes'} />
            <span className="consult-mode-text">
              <span className="consult-mode-name">{m === 'consult' ? '相談する' : '記録に聞く'}</span>
              <span className="consult-mode-sub">{m === 'consult' ? '書籍・ガイドラインも踏まえる' : '記録だけから答える'}</span>
            </span>
          </button>
        ))}
      </div>
      {mode === 'consult' ? (
        <p className="support-caution" data-testid="consult-caution">
          臨床支援の草案です。最終判断は先生です。この患者の記録と、書籍・ネットの出典から答えます（記録に書かれていないことは補いません）。
        </p>
      ) : (
        <p className="support-caution" data-testid="ask-caution">
          記録だけから答えます。書かれていないことは答えません。
        </p>
      )}

      <div className="chips consult-quick" aria-label="よく使う問い">
        {QUICK[mode].map((q) => (
          <button
            key={q}
            type="button"
            className="chip small"
            onClick={() => {
              consult.setDraft(q);
            }}
            data-testid="consult-quick"
          >
            {q}
          </button>
        ))}
      </div>
      <label className="ask-label" htmlFor="consult-question">
        {mode === 'consult' ? (entries.length > 0 ? '続けて相談する（前のやりとりを踏まえて答えます）' : '相談したいこと（方針・アセスメント・検査・治療から、小さな疑問まで）') : '問い（例：K をいつ、どれだけ補正した？・抗菌薬を変えた理由は？）'}
      </label>
      <textarea
        id="consult-question"
        rows={3}
        maxLength={max}
        value={consult.draft}
        onChange={(e) => {
          consult.setDraft(e.target.value);
        }}
        data-testid="consult-question"
      />
      <div className="ask-actions">
        <button type="button" className="button primary" disabled={busy || consult.draft.trim() === ''} onClick={consult.send} data-testid="consult-send">
          {busy ? (mode === 'consult' ? '記録を読んで、出典を探しています…' : '記録を読んでいます…') : mode === 'consult' ? '相談する' : '聞く'}
        </button>
        {mode === 'consult' && (
          <label className="check">
            <input
              type="checkbox"
              checked={consult.web}
              onChange={(e) => {
                consult.setWeb(e.target.checked);
              }}
              data-testid="consult-web"
            />
            ネットの出典も探す（学会・公的機関・主要誌）
          </label>
        )}
        {mode === 'consult' && record.encounters.length > 1 && (
          <label className="check">
            <input
              type="checkbox"
              checked={consult.past}
              onChange={(e) => {
                consult.setPast(e.target.checked);
              }}
              data-testid="consult-past"
            />
            前の受診の記録も資料にする（受診 {String(record.encounters.length)} 回）
          </label>
        )}
      </div>
      {busy && mode === 'consult' && (
        <div className="consult-progress" data-testid="consult-progress" aria-live="polite">
          <p className="note" data-testid="consult-stage">
            {consult.progress?.stage === null || consult.progress === null ? '記録を読んでいます' : CONSULT_STAGE_NAMES[consult.progress.stage]}
            …（1〜2分かかることがあります。閉じても、この患者の画面を開いているあいだは続きます）
          </p>
          {consult.progress !== null && consult.progress.statements.length > 0 && (
            <>
              <p className="note">書けた文から出しています（どれも、確かめた後の文です。書き終えたら、見出しの順に並べ直します）。</p>
              <ul className="support-list">
                {consult.progress.statements.map((st, i) => (
                  <StatementView key={String(i)} statement={st} pickKey={`p-${String(i)}`} onOpenSource={onOpenSource} targets={null} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <p className="note consult-privacy">
        問いと答えは保存しません（残るのは「この答えを残す」を押した答えだけ）。
        {mode === 'consult' && '書籍・ネットの検索に渡すのは、問題の名前と、問いの一般的な語だけです（問いの文・値・日付は渡しません）。'}
      </p>
      {consult.message !== null && (
        <p className="alert" role="alert" data-testid="consult-message">
          {consult.message}
        </p>
      )}

      {picks.length > 0 && (
        <div className="consult-tray" data-testid="consult-tray">
          <span className="note">記載の下書きに足す候補：{String(picks.length)} 件（まだ、どこにも残っていません）</span>
          <button type="button" className="chip small" onClick={onOpenDocument} data-testid="consult-open-document">
            <Icon name="edit" />
            カルテ記載を開いて、見出しに足す
          </button>
        </div>
      )}
      {latest !== undefined && (
        <article className="consult-entry newest" data-testid="consult-entry" ref={newestRef}>
          <p className="consult-asked" data-testid="consult-asked">
            <span className="tag">{latest.mode === 'consult' ? '相談' : '記録だけから'}</span>
            {latest.question}
          </p>
          {entryView(latest)}
        </article>
      )}
      {older.length > 0 && (
        <div className="consult-older" data-testid="consult-older">
          <h3 className="sub-title">この前のやりとり（画面を閉じると消えます）</h3>
          {older.map((e) => (
            <details key={e.id} className="consult-entry">
              <summary>
                <span className="tag">{e.mode === 'consult' ? '相談' : '記録だけから'}</span>
                {e.question}
              </summary>
              {entryView(e)}
            </details>
          ))}
        </div>
      )}
      {entries.length > 0 && (
        <div className="actions">
          <button type="button" className="button small" disabled={busy} onClick={consult.reset} data-testid="consult-reset">
            新しい相談にする（このやりとりを消す）
          </button>
        </div>
      )}

      <div className="consult-notes" data-testid="consult-notes">
        <h3 className="sub-title with-icon">
          <Icon name="check" />
          残した答え <span className="tag">{String(record.consultNotes.length)}</span>
        </h3>
        {record.consultNotes.length === 0 ? (
          <p className="note">まだありません。答えの下の「この答えを残す」を押すと、ここに残ります。</p>
        ) : (
          record.consultNotes.map((n) => <KeptNote key={n.id} note={n} record={record} onChanged={onChanged} onLeft={onLeft} />)
        )}
      </div>
    </section>
  );
}
