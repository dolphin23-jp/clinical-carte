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
import {
  type ApRef,
  checkConsult,
  cleanTerms,
  consultMaterial,
  consultMessage,
  type ConsultNoteNew,
  type ConsultReply,
  type ConsultRequest,
  consultTermsMessage,
  japanDateTime,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';

import { type SelectOutcome, selectTexts } from './ap.ts';
import { supportInputOf } from './clinicalsupport.ts';
import type { Db } from './db.ts';
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
  options: { readonly organizer: Organizer; readonly books: BookSearcher | null; readonly gate: CallGate; readonly today: string },
): Promise<ConsultOutcome> {
  const record = await getRecord(db, patientId);
  if (record === null) return { ok: false, reason: 'not_found' };
  const support = supportInputOf(record, options.today);
  if (support === null) return { ok: false, reason: 'empty' };
  const material = consultMaterial({
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
  });
  // 資料にする記載がなければ、AI を呼ばない
  if (material.records === 0) return { ok: false, reason: 'empty' };

  // 外の検索に渡す語：外を探すとき（書籍の設定がある・ネットを頼まれた）だけ、問いと問題の名前から AI が取り出し、決定論で確かめる。
  // 取り出しに失敗したら、語なし（問題の名前だけ）で続ける。上限なら、ここで止める（この後の答えも呼べない）
  let terms: string[] = [];
  if (options.books !== null || request.web) {
    if (!(await options.gate.take())) return { ok: false, reason: 'ai_limit' };
    const picked = await options.organizer.consultTerms(consultTermsMessage(request.question, material.problemNames));
    if (picked.ok) {
      const names = new Set(material.problemNames.map((n) => n.normalize('NFKC').toLowerCase()));
      terms = cleanTerms(picked.answer.terms).filter((t) => !names.has(t.toLowerCase()));
    }
  }
  const refs = await gatherReferences(material.problemNames, { web: request.web, books: options.books, organizer: options.organizer, gate: options.gate, topics: terms });
  const citations = [...refs.books, ...refs.web];

  if (!(await options.gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await options.organizer.consult(consultMessage(material, citations, request.question, request.turns));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  const checked = checkConsult(answered.answer, material, citations);
  return {
    ok: true,
    reply: {
      ...checked,
      research: { books: refs.books.length, web: refs.web.length, webFailed: refs.webFailed, names: options.books !== null || request.web ? [...material.problemNames] : [], terms },
      dropped: material.dropped,
    },
  };
}

// ---------------------------------------------------------------------------
// 残す・消す（CA-032 の改訂）：先生が「残す」を押した答えだけ。文は選別（C-1）を通す。直す操作はない

export type ConsultNoteOutcome = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: 'not_found' } | Exclude<SelectOutcome, { ok: true }>;

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
  await db
    .prepare('INSERT INTO consult_notes (id, patient_id, mode, text, refs, entered_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, patientId, note.mode, selected.texts[0] ?? '', JSON.stringify(refs), japanDateTime(runtime.now()))
    .run();
  return { ok: true, id };
}

export async function deleteConsultNote(db: Db, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM consult_notes WHERE id = ?').bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}
