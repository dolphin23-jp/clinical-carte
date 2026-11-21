// 段I：カルテ記載（CA-054。docs/04 の 15）。「出す」を押すと、出来上がった1つの記載を返す（保存しない）。相談して直すのも、保存しない。
// 保存するのは、本人が「保存する」を押したものだけで、文は必ず選別（intake。C-1）を通した後の字。直す・消すたびに document_history に残す（文は残さない）。
//
// 資料は3つ：(1) 記録（保存した文と整理した事実。core の documentMaterial）、(2) 書籍（本人の clinical-RAG の検索。設定があるときだけ）、
// (3) ネットの出典（Anthropic のウェブ検索。本人が選んだときだけ）。**外へ出す検索語は、問題の名前だけ**（症例に固有の値・頼み・やりとりを渡さない）。
// 答えは core の checkDocument が整え（見出しの順・識別情報の形を伏せる・根拠の記号）、数の印は core の markNumbers（画面と同じ関数）。
import {
  backingWith,
  type Backing,
  type CheckedDocument,
  checkDocument,
  type DocMaterial,
  type DocType,
  type DocumentNew,
  type DocumentPatch,
  DOC_TALK_MAX,
  documentMaterial,
  documentMessage,
  findShapes,
  japanDateTime,
  type RefSource,
  replaceShapes,
  sectionsFit,
  threadViews,
  ulid,
  ULID_RANDOM_BYTES,
} from '@clinical-carte/core';

import { selectTexts, type SelectOutcome } from './ap.ts';
import type { Db, Statement } from './db.ts';
import type { Organizer } from './organizer.ts';
import { documentOf, DOCUMENT_COLUMNS, getEncounter, getRecord } from './records.ts';
import { type BookSearcher, bookSources, webSources } from './references.ts';
import type { Runtime } from './runtime.ts';
import type { Selector, SelectorFailure } from './selector.ts';

/** AI を呼ぶ前の確かめ（回数の上限）。呼ぶたびに数える */
export interface CallGate {
  /** 呼べるなら数えて true。上限なら false */
  take(): Promise<boolean>;
}

export interface References {
  readonly books: readonly RefSource[];
  readonly web: readonly RefSource[];
  /** ウェブ検索を頼んだが、できなかった（上限・失敗）。黙って捨てず、画面に出す */
  readonly webFailed: boolean;
}

/** 参照元を集める：書籍（設定があるとき）とネット（頼まれたとき）。送るのは問題の名前だけ */
export async function gatherReferences(names: readonly string[], options: { web: boolean; books: BookSearcher | null; organizer: Organizer; gate: CallGate }): Promise<References> {
  const books = options.books === null || names.length === 0 ? [] : bookSources(await options.books.search(names));
  if (!options.web || names.length === 0) return { books, web: [], webFailed: false };
  if (!(await options.gate.take())) return { books, web: [], webFailed: true };
  const researched = await options.organizer.research(JSON.stringify({ problems: names }));
  if (!researched.ok) return { books, web: [], webFailed: true };
  return { books, web: webSources(researched.hits), webFailed: false };
}

/** 資料を作る（AI を呼ぶ前に、空かどうかを見るため、分けてある）。受診がなければ null */
export async function documentMaterialFor(db: Db, encounterId: string, type: DocType, day: string): Promise<DocMaterial | null> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return null;
  const record = await getRecord(db, encounter.patientId);
  if (record === null) return null;
  return documentMaterial({
    type,
    day,
    patient: record.patient,
    encounter,
    encounters: record.encounters,
    sources: record.sources,
    segments: record.segments,
    threads: threadViews(record.problemThreads, record.problems).threads,
    observations: record.observations.filter((o) => !o.excluded),
    medications: record.medications.filter((m) => !m.excluded),
    events: record.events.filter((e) => !e.excluded),
    apNotes: record.apNotes,
  });
}

/** 画面に返す出典（題・頁・URL。抜き出しの字は返さない） */
export interface RefLabel {
  readonly id: string;
  readonly kind: 'book' | 'web';
  readonly label: string;
}

export interface DocumentReply {
  readonly document: CheckedDocument;
  /** 数の印の照らし合わせの表（数だけ） */
  readonly backing: Backing;
  readonly refs: readonly RefLabel[];
  readonly material: { readonly records: number; readonly shortened: number; readonly dropped: number };
  readonly webFailed: boolean;
}

export type DocumentOutcome =
  | ({ readonly ok: true } & DocumentReply)
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure }
  | { readonly ok: false; readonly reason: 'ai_limit' };

const replyOf = (document: CheckedDocument, material: DocMaterial, refs: References): DocumentReply => {
  const all = [...refs.books, ...refs.web];
  return {
    document,
    backing: backingWith(material.backing, all),
    refs: all.map((r) => ({ id: r.id, kind: r.kind === 'web' ? 'web' : 'book', label: r.label })),
    material: { records: material.records.length, shortened: material.shortened, dropped: material.dropped },
    webFailed: refs.webFailed,
  };
};

export async function generateDocument(material: DocMaterial, refs: References, organizer: Organizer, gate: CallGate): Promise<DocumentOutcome> {
  const sources = [...refs.books, ...refs.web];
  if (!(await gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await organizer.document(documentMessage(material, sources));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  return { ok: true, ...replyOf(checkDocument(answered.answer, material, sources), material, refs) };
}

export interface Talk {
  readonly sections: readonly { readonly key: string; readonly text: string }[];
  readonly history: readonly { readonly role: 'doctor' | 'ai'; readonly text: string }[];
  readonly instruction: string;
}

export type ReviseOutcome =
  | ({ readonly ok: true; readonly reply: string } & DocumentReply)
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure }
  | { readonly ok: false; readonly reason: 'ai_limit' };

export async function reviseDocument(material: DocMaterial, talk: Talk, refs: References, organizer: Organizer, gate: CallGate): Promise<ReviseOutcome> {
  const sources = [...refs.books, ...refs.web];
  if (!(await gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await organizer.revise(documentMessage(material, sources, talk));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  // 答えの文も、識別情報の形は伏せる（保存しない。画面に出すだけ）
  const reply = replaceShapes(answered.answer.reply.trim().slice(0, DOC_TALK_MAX)).text;
  return { ok: true, reply, ...replyOf(checkDocument(answered.answer, material, sources), material, refs) };
}

/** いまの記載・頼み・やりとりに、識別情報の形（電話・メールなど）があれば送らない（保存しないが、外へ出さない） */
export function talkHasShapes(talk: Talk): boolean {
  return [talk.instruction, ...talk.history.map((h) => h.text), ...talk.sections.map((x) => x.text)].some((t) => findShapes(t).length > 0);
}

// ---------------------------------------------------------------------------
// 残す・直す・消す

function history(db: Db, runtime: Runtime, patientId: string, documentId: string, action: 'add' | 'edit' | 'delete', origin: string | null): Statement {
  return db
    .prepare('INSERT INTO document_history (id, patient_id, at, document_id, action, origin) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)), patientId, japanDateTime(runtime.now()), documentId, action, origin);
}

export type SaveOutcome = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: 'not_found' | 'bad_request' } | Exclude<SelectOutcome, { ok: true }>;

/** 見出しごとの文を、1回の選別に通す（中身のない見出しは通さず、空のまま） */
async function selectSections<T extends { readonly key: string; readonly text: string }>(sections: readonly T[], selector: Selector): Promise<{ ok: true; sections: T[] } | Exclude<SelectOutcome, { ok: true }>> {
  const filled = sections.filter((x) => x.text.trim() !== '');
  const selected = await selectTexts(
    filled.map((x) => x.text),
    selector,
  );
  if (!selected.ok) return selected;
  const byKey = new Map(filled.map((x, i) => [x.key, selected.texts[i] ?? '']));
  return { ok: true, sections: sections.map((x) => ({ ...x, text: byKey.get(x.key) ?? '' })) };
}

export async function addDocument(db: Db, encounterId: string, body: DocumentNew, selector: Selector, runtime: Runtime): Promise<SaveOutcome> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return { ok: false, error: 'not_found' };
  if (!sectionsFit(body.type, body.sections)) return { ok: false, error: 'bad_request' };
  const selected = await selectSections(body.sections, selector);
  if (!selected.ok) return selected;
  const id = ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));
  const now = japanDateTime(runtime.now());
  // 誰の文か：先生が書いた（self）・AI が書いたまま（ai）・AI が書いたものを直した（ai_edited）
  const origin = body.origin === 'self' ? 'self' : body.edited ? 'ai_edited' : 'ai';
  await db.batch([
    db
      .prepare('INSERT INTO documents (id, patient_id, encounter_id, type, day, sections, origin, entered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, encounter.patientId, encounterId, body.type, body.day, JSON.stringify(selected.sections), origin, now, now),
    history(db, runtime, encounter.patientId, id, 'add', origin),
  ]);
  return { ok: true, id };
}

/** 残した記載を直す（文は選別を通す。AI が書いたものは「AI が書いて先生が直した」になる） */
export async function patchDocument(db: Db, id: string, patch: DocumentPatch, selector: Selector, runtime: Runtime): Promise<SaveOutcome> {
  const row = await db.prepare(`SELECT patient_id, ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`).bind(id).first();
  const doc = row === null ? null : documentOf(row);
  const patientId = row?.['patient_id'];
  if (doc === null || typeof patientId !== 'string') return { ok: false, error: 'not_found' };
  if (!sectionsFit(doc.type, patch.sections)) return { ok: false, error: 'bad_request' };
  const selected = await selectSections(patch.sections, selector);
  if (!selected.ok) return selected;
  const origin = doc.origin === 'self' ? 'self' : 'ai_edited';
  await db.batch([
    db.prepare('UPDATE documents SET sections = ?, origin = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(selected.sections), origin, japanDateTime(runtime.now()), id),
    history(db, runtime, patientId, id, 'edit', origin),
  ]);
  return { ok: true, id };
}

export async function deleteDocument(db: Db, id: string, runtime: Runtime): Promise<boolean> {
  const row = await db.prepare('SELECT patient_id FROM documents WHERE id = ?').bind(id).first();
  const patientId = row?.['patient_id'];
  if (row === null || typeof patientId !== 'string') return false;
  await db.batch([db.prepare('DELETE FROM documents WHERE id = ?').bind(id), history(db, runtime, patientId, id, 'delete', null)]);
  return true;
}
