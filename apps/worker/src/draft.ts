// 段4：AI の草案（CA-023）。入院後経過（問題ごと）。**保存しない・ログに残さない**：資料を作り、AI に送り、決定論で確かめて、答えるだけ。
// 資料は、保存した文から切り出した引用だけ（core の courseMaterial）。確かめは core の checkDraft。
import { checkDraft, type CheckedDraft, courseMaterial, threadViews } from '@clinical-carte/core';

import type { Db } from './db.ts';
import type { Organizer } from './organizer.ts';
import { getEncounter, getRecord } from './records.ts';
import type { SelectorFailure } from './selector.ts';

export type DraftOutcome =
  | { readonly ok: true; readonly draft: CheckedDraft; readonly quotes: number; readonly dropped: number }
  | { readonly ok: false; readonly reason: 'not_found' | 'empty' }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure };

/** 草案の資料を作る（AI を呼ぶ前に、資料が空かどうかを見るため、分けてある） */
export async function draftMaterialFor(db: Db, encounterId: string) {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return null;
  const record = await getRecord(db, encounter.patientId);
  if (record === null) return null;
  const threads = threadViews(record.problemThreads, record.problems).threads;
  return courseMaterial({
    encounter,
    sources: record.sources,
    threads,
    segments: record.segments,
    medications: record.medications.filter((m) => m.encounterId === encounterId && !m.excluded),
    events: record.events.filter((e) => e.encounterId === encounterId && !e.excluded),
  });
}

export async function draftCourse(material: NonNullable<Awaited<ReturnType<typeof draftMaterialFor>>>, drafter: Organizer): Promise<DraftOutcome> {
  if (material.quotes.length === 0) return { ok: false, reason: 'empty' };
  const answered = await drafter.draft(material.message);
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  return { ok: true, draft: checkDraft(answered.answer, material), quotes: material.quotes.length, dropped: material.dropped };
}
