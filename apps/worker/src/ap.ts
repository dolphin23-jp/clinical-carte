// 段5：A/P の記録（CA-030〜035。docs/04 の 12）。本人が書いた・AI の案から採用した、決まったことだけを残す（議論は保存しない）。
// 文は、保存の前に必ず選別（intake。C-1）を通す。まとめて足すときは、1回の選別で済むように区切りの行でつないで通し、また分ける。
// 参照は場所・題・頁・URL だけ（core の ApRef）。直す・消すたびに ap_history に残す（文は残さない）。
import { type ApNoteNew, type ApNotePatch, japanDateTime, ulid, ULID_RANDOM_BYTES } from '@clinical-carte/core';

import type { Db, Statement } from './db.ts';
import { intake } from './intake.ts';
import { AP_COLUMNS, apNoteOf, getEncounter } from './records.ts';
import type { Runtime } from './runtime.ts';
import type { Selector, SelectorFailure } from './selector.ts';

/** まとめて選別に通すときの区切りの行（置き換えの語にも、臨床の文にも出てこない字） */
const JOIN = '\n――――\n';

export type SelectOutcome = { readonly ok: true; readonly texts: readonly string[] } | { readonly ok: false; readonly error: 'empty' | 'selection' } | { readonly ok: false; readonly error: 'ai'; readonly failure: SelectorFailure };

/** いくつかの文を、1回の選別に通す（置き換えた後の文を、同じ数に分けて返す。数が合わなければ失敗） */
export async function selectTexts(texts: readonly string[], selector: Selector): Promise<SelectOutcome> {
  if (texts.some((t) => t.includes('――――'))) return { ok: false, error: 'selection' };
  const result = await intake({ kind: 'memo', authorRole: 'self', at: null, text: texts.join(JOIN) }, selector);
  if (!result.ok) {
    if (result.reason === 'empty') return { ok: false, error: 'empty' };
    if (result.reason === 'ai') return { ok: false, error: 'ai', failure: result.failure };
    return { ok: false, error: 'selection' };
  }
  const parts = result.text.split(JOIN.trim()).map((p) => p.trim());
  if (parts.length !== texts.length || parts.some((p) => p === '')) return { ok: false, error: 'selection' };
  return { ok: true, texts: parts };
}

function history(db: Db, runtime: Runtime, patientId: string, noteId: string, action: 'add' | 'edit' | 'kind' | 'delete', origin: string | null): Statement {
  return db
    .prepare('INSERT INTO ap_history (id, patient_id, at, note_id, action, origin) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES)), patientId, japanDateTime(runtime.now()), noteId, action, origin);
}

export type ApOutcome = { readonly ok: true; readonly ids: readonly string[] } | { readonly ok: false; readonly error: 'not_found' | 'bad_request' } | Exclude<SelectOutcome, { ok: true }>;

/** A/P を足す（まとめて）。どれも同じ受診のもので、その患者の筋であること */
export async function addApNotes(db: Db, notes: readonly ApNoteNew[], selector: Selector, runtime: Runtime): Promise<ApOutcome> {
  const encounterId = notes[0]?.encounterId ?? '';
  if (notes.some((n) => n.encounterId !== encounterId)) return { ok: false, error: 'bad_request' };
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return { ok: false, error: 'not_found' };
  for (const threadId of new Set(notes.map((n) => n.threadId))) {
    const row = await db.prepare('SELECT patient_id FROM problem_threads WHERE id = ?').bind(threadId).first();
    if (row?.['patient_id'] !== encounter.patientId) return { ok: false, error: 'not_found' };
  }
  const selected = await selectTexts(
    notes.map((n) => n.text),
    selector,
  );
  if (!selected.ok) return selected;
  const now = japanDateTime(runtime.now());
  const ids: string[] = [];
  const statements: Statement[] = [];
  notes.forEach((n, i) => {
    const id = ulid(runtime.now(), runtime.randomBytes(ULID_RANDOM_BYTES));
    ids.push(id);
    statements.push(
      db
        .prepare('INSERT INTO ap_notes (id, patient_id, encounter_id, thread_id, day, part, plan_kind, text, origin, refs, entered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, encounter.patientId, encounterId, n.threadId, n.day, n.part, n.part === 'plan' ? n.planKind : null, selected.texts[i] ?? '', n.origin, JSON.stringify(n.refs), now, now),
      history(db, runtime, encounter.patientId, id, 'add', n.origin),
    );
  });
  await db.batch(statements);
  return { ok: true, ids };
}

/** A/P を直す：文（選別を通す。AI 由来なら「AI 案を直した」になる）か、方針の種類 */
export async function patchApNote(db: Db, id: string, patch: ApNotePatch, selector: Selector | null, runtime: Runtime): Promise<ApOutcome> {
  const row = await db.prepare(`SELECT patient_id, ${AP_COLUMNS} FROM ap_notes WHERE id = ?`).bind(id).first();
  const note = row === null ? null : apNoteOf(row);
  const patientId = row?.['patient_id'];
  if (note === null || typeof patientId !== 'string') return { ok: false, error: 'not_found' };
  const now = japanDateTime(runtime.now());
  if ('planKind' in patch) {
    if (note.part !== 'plan') return { ok: false, error: 'bad_request' };
    await db.batch([db.prepare('UPDATE ap_notes SET plan_kind = ?, updated_at = ? WHERE id = ?').bind(patch.planKind, now, id), history(db, runtime, patientId, id, 'kind', note.origin)]);
    return { ok: true, ids: [id] };
  }
  if (selector === null) return { ok: false, error: 'bad_request' };
  const selected = await selectTexts([patch.text], selector);
  if (!selected.ok) return selected;
  const origin = note.origin === 'self' ? 'self' : 'ai_edited';
  await db.batch([
    db.prepare('UPDATE ap_notes SET text = ?, origin = ?, updated_at = ? WHERE id = ?').bind(selected.texts[0] ?? '', origin, now, id),
    history(db, runtime, patientId, id, 'edit', origin),
  ]);
  return { ok: true, ids: [id] };
}

export async function deleteApNote(db: Db, id: string, runtime: Runtime): Promise<boolean> {
  const row = await db.prepare('SELECT patient_id, origin FROM ap_notes WHERE id = ?').bind(id).first();
  const patientId = row?.['patient_id'];
  if (row === null || typeof patientId !== 'string') return false;
  await db.batch([db.prepare('DELETE FROM ap_notes WHERE id = ?').bind(id), history(db, runtime, patientId, id, 'delete', null)]);
  return true;
}
