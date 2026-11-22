// 段K6：記録への質問（出どころつき。CA-058 の A4・CA-066）。先生の問いに、記録だけから AI が答え、core の checkAnswer が根拠を確かめて返す。
// **保存しない**：問い・答え・資料のどれも、表に書かず、ログに出さない（画面のメモリだけ。カルテ記載の相談〔CA-054〕と同じ）。
// 問いの字は、カルテ記載の相談の頼みと同じ扱い：識別情報の形（電話・メールなど。core の findShapes）があれば送らない（routes.ts。画面も同じ関数で止める）。
// AI（Anthropic）に送るのは、記録から決定論で作った資料（core の askMaterial。識別情報を置き換えた後の記録から）と、問いだけ。外の検索はしない。
import { askMaterial, askMessage, type AskReply, checkAnswer } from '@clinical-carte/core';

import type { Db } from './db.ts';
import type { CallGate } from './documents.ts';
import type { Organizer } from './organizer.ts';
import { getRecord } from './records.ts';
import type { SelectorFailure } from './selector.ts';

export type AskOutcome =
  | { readonly ok: true; readonly reply: AskReply }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'empty' }
  | { readonly ok: false; readonly reason: 'ai_limit' }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure };

export async function askRecord(db: Db, patientId: string, question: string, options: { readonly organizer: Organizer; readonly gate: CallGate; readonly today: string }): Promise<AskOutcome> {
  const record = await getRecord(db, patientId);
  if (record === null) return { ok: false, reason: 'not_found' };
  const material = askMaterial({
    patient: record.patient,
    today: options.today,
    encounters: record.encounters,
    sources: record.sources,
    segments: record.segments,
    medications: record.medications.filter((m) => !m.excluded),
    events: record.events.filter((e) => !e.excluded),
    observations: record.observations.filter((o) => !o.excluded && o.unseen !== true),
    course: record.course,
  });
  // 資料にする記載がなければ、AI を呼ばない
  if (![...material.refs.values()].some((r) => r.kind === 'record')) return { ok: false, reason: 'empty' };
  if (!(await options.gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await options.organizer.ask(askMessage(material, question));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  return { ok: true, reply: checkAnswer(answered.answer, material) };
}
