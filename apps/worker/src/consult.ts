// 段M：相談の窓口（CA-081。docs/04 の 24）。先生が、この患者について何でも相談すると、carte が持っている記録と、書籍・ネットの出典から AI が答え、
// core の checkConsult が確かめて返す（臨床支援の決まり CA-059 のまま：点数を計算させない・資料と出典にない用量を出さない・出典のない文に「（推論）」・資料にない数に※）。
//
// 外へ出すもの：
// (1) AI（Anthropic）：記録から決定論で作った資料（core の consultMaterial。識別情報を置き換えた後の記録から）・出典の抜き出し・問い・画面のメモリの前のやりとり。
// (2) 書籍（本人の clinical-RAG。設定があるときだけ）と (3) ネット（Anthropic のウェブ検索。頼まれたときだけ）：**問題の名前と、問いから取り出した一般的な語だけ**
//     （CA-035 の改訂）。語は、AI（Anthropic）が問いと問題の名前だけから取り出し、core の cleanTerms が決定論で確かめる（数字・識別情報の形・文・年齢や病日の字のある語は渡さない）。
//     問いの文そのもの・記録の文・値は、書籍・ネットの検索に渡さない。
// 保存しない：問い・前のやりとり・資料・AI の答え・出典の抜き出し・検索の語のどれも、表に書かず、ログに出さない。
// 残すのは、先生が「残す」を押した答えだけ（addConsultNote。選別 C-1 を通した後の字。CA-032 の改訂）。
// 段M2：前の受診の記録も資料にする（CA-084。request.past）・答えを確かめた文から順に知らせる（CA-085。emit。確かめる前の字は知らせない）・
// 残した答えを直す（CA-083。patchConsultNote。選別を通す）。残した・直した・消した記録は consult_note_history（文は持たない）。
import {
  type ApRef,
  checkConsult,
  checkConsultStatement,
  cleanTerms,
  CONSULT_NOTE_MODES,
  CONSULT_STATEMENTS_MAX,
  type ConsultEvent,
  consultMaterial,
  consultMessage,
  type ConsultNoteAction,
  type ConsultNoteMode,
  type ConsultNoteNew,
  type ConsultNotePatch,
  type ConsultReply,
  type ConsultRequest,
  consultTermsMessage,
  japanDateTime,
  partialStatements,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';

import { type SelectOutcome, selectTexts } from './ap.ts';
import { supportInputOf } from './clinicalsupport.ts';
import { type Db, type Statement, text } from './db.ts';
import { type CallGate, gatherReferences } from './documents.ts';
import type { Organizer } from './organizer.ts';
import { getPatient, getRecord } from './records.ts';
import type { BookSearcher } from './references.ts';
import type { Runtime } from './runtime.ts';
import type { Selector, SelectorFailure } from './selector.ts';

export type ConsultOutcome =
  | { readonly ok: true; readonly reply: ConsultReply }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'empty' }
  | { readonly ok: false; readonly reason: 'ai_limit' }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure };

export async function consultPatient(
  db: Db,
  patientId: string,
  request: ConsultRequest,
  options: {
    readonly organizer: Organizer;
    readonly books: BookSearcher | null;
    readonly gate: CallGate;
    readonly today: string;
    /** 少しずつ知らせる（CA-085）：いま何をしているかと、確かめた後の文。確かめる前の字は知らせない。なければ、最後の答えだけ */
    readonly emit?: (event: ConsultEvent) => void;
  },
): Promise<ConsultOutcome> {
  const emit = options.emit;
  const record = await getRecord(db, patientId);
  if (record === null) return { ok: false, reason: 'not_found' };
  const support = supportInputOf(record, options.today);
  if (support === null) return { ok: false, reason: 'empty' };
  const material = consultMaterial(
    {
      support,
      ask: {
        patient: record.patient,
        today: options.today,
        encounters: record.encounters,
        sources: record.sources,
        segments: record.segments,
        medications: [],
        events: record.events.filter((e) => !e.excluded),
        observations: [],
        course: [],
      },
    },
    // 前の受診の記録も資料にする（CA-084）：記載とできごとの範囲を、患者のすべての受診に広げる
    { past: request.past },
  );
  // 資料にする記載がなければ、AI を呼ばない
  if (material.records === 0) return { ok: false, reason: 'empty' };

  // 外の検索に渡す語：外を探すとき（書籍の設定がある・ネットを頼まれた）だけ、問いと問題の名前から AI が取り出し、決定論で確かめる。
  // 取り出しに失敗したら、語なし（問題の名前だけ）で続ける。上限なら、ここで止める（この後の答えも呼べない）
  let terms: string[] = [];
  if (options.books !== null || request.web) {
    if (!(await options.gate.take())) return { ok: false, reason: 'ai_limit' };
    emit?.({ stage: 'terms' });
    const picked = await options.organizer.consultTerms(consultTermsMessage(request.question, material.problemNames));
    if (picked.ok) {
      const names = new Set(material.problemNames.map((n) => n.normalize('NFKC').toLowerCase()));
      terms = cleanTerms(picked.answer.terms).filter((t) => !names.has(t.toLowerCase()));
    }
  }
  if (options.books !== null || request.web) emit?.({ stage: 'references' });
  const refs = await gatherReferences(material.problemNames, { web: request.web, books: options.books, organizer: options.organizer, gate: options.gate, topics: terms });
  const citations = [...refs.books, ...refs.web];

  if (!(await options.gate.take())) return { ok: false, reason: 'ai_limit' };
  emit?.({ stage: 'answer' });
  // 少しずつ知らせるとき：書き終えた文を、1つずつ同じ確かめ（checkConsultStatement）に通し、通った文だけを知らせる（数の上限まで）
  let seen = 0;
  let shown = 0;
  const onText =
    emit === undefined
      ? undefined
      : (snapshot: string): void => {
          const list = partialStatements(snapshot);
          for (; seen < list.length; seen += 1) {
            const raw = list[seen];
            if (raw === undefined) continue;
            const checked = checkConsultStatement(raw, material, citations);
            if (checked.statement === null || shown >= CONSULT_STATEMENTS_MAX) continue;
            shown += 1;
            emit({ statement: checked.statement });
          }
        };
  const answered = await options.organizer.consult(consultMessage(material, citations, request.question, request.turns), onText);
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  const checked = checkConsult(answered.answer, material, citations);
  return {
    ok: true,
    reply: {
      ...checked,
      research: { books: refs.books.length, web: refs.web.length, webFailed: refs.webFailed, names: options.books !== null || request.web ? [...material.problemNames] : [], terms },
      dropped: material.dropped,
      scope: { records: material.records, encounters: material.encounters, past: request.past },
    },
  };
}

// ---------------------------------------------------------------------------
// 残す・直す・消す（CA-032 の改訂・CA-083）：先生が「残す」を押した答えだけ。文は選別（C-1）を通す。記録（consult_note_history）に、文は残さない

export type ConsultNoteOutcome = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: 'not_found' } | Exclude<SelectOutcome, { ok: true }>;

function history(db: Db, runtime: Runtime, patientId: string, noteId: string, action: ConsultNoteAction, mode: ConsultNoteMode): Statement {
  return db
    .prepare('INSERT INTO consult_note_history (id, patient_id, at, note_id, action, mode) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)), patientId, japanDateTime(runtime.now()), noteId, action, mode);
}

export async function addConsultNote(db: Db, patientId: string, note: ConsultNoteNew, selector: Selector, runtime: Runtime): Promise<ConsultNoteOutcome> {
  if ((await getPatient(db, patientId)) === null) return { ok: false, error: 'not_found' };
  // 記録の参照は、この患者の文を指すものだけを残す（ほかの患者の文の id を、残さない）
  const recordIds = [...new Set(note.refs.flatMap((r) => (r.k === 'record' ? [r.sourceId] : [])))];
  const own = new Set<string>();
  for (const sourceId of recordIds) {
    const row = await db.prepare('SELECT patient_id FROM sources WHERE id = ?').bind(sourceId).first();
    if (row?.['patient_id'] === patientId) own.add(sourceId);
  }
  const refs: ApRef[] = note.refs.filter((r) => r.k !== 'record' || own.has(r.sourceId));
  const selected = await selectTexts([note.text], selector);
  if (!selected.ok) return selected;
  const id = ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));
  await db.batch([
    db
      .prepare('INSERT INTO consult_notes (id, patient_id, mode, text, refs, entered_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, patientId, note.mode, selected.texts[0] ?? '', JSON.stringify(refs), japanDateTime(runtime.now())),
    history(db, runtime, patientId, id, 'add', note.mode),
  ]);
  return { ok: true, id };
}

/** その答えの患者と、どちらの答えか（なければ null） */
async function noteOwner(db: Db, id: string): Promise<{ patientId: string; mode: ConsultNoteMode } | null> {
  const row = await db.prepare('SELECT patient_id, mode FROM consult_notes WHERE id = ?').bind(id).first();
  const patientId = row === null ? null : text(row, 'patient_id');
  const mode = CONSULT_NOTE_MODES.find((m) => m === (row === null ? null : text(row, 'mode')));
  return patientId === null || mode === undefined ? null : { patientId, mode };
}

/** 残した答えを直す（CA-083）：先生が打った字を、選別に通してから置き換える（前の字は残さない）。「先生が直した」の印が付く。参照は変えない */
export async function patchConsultNote(db: Db, id: string, patch: ConsultNotePatch, selector: Selector, runtime: Runtime): Promise<ConsultNoteOutcome> {
  const owner = await noteOwner(db, id);
  if (owner === null) return { ok: false, error: 'not_found' };
  const selected = await selectTexts([patch.text], selector);
  if (!selected.ok) return selected;
  await db.batch([
    db.prepare('UPDATE consult_notes SET text = ?, edited = 1, updated_at = ? WHERE id = ?').bind(selected.texts[0] ?? '', japanDateTime(runtime.now()), id),
    history(db, runtime, owner.patientId, id, 'edit', owner.mode),
  ]);
  return { ok: true, id };
}

export async function deleteConsultNote(db: Db, id: string, runtime: Runtime): Promise<boolean> {
  const owner = await noteOwner(db, id);
  if (owner === null) return false;
  await db.batch([db.prepare('DELETE FROM consult_notes WHERE id = ?').bind(id), history(db, runtime, owner.patientId, id, 'delete', owner.mode)]);
  return true;
}
