// 段K5：AI の臨床支援（CA-059・CA-064。docs/04 の 17）。AI のプロブレムリストの活動中の問題ごとに、疑う疾患と確かめる検査の候補・
// ガイドライン・標準治療との照合・表にない基準の補いを、AI が書き、core の checkSupport が確かめて、患者ごとに1つ残す（clinical_support）。
//
// 外へ出すもの：(1) 書籍（本人の clinical-RAG。設定があるときだけ）と (2) ネット（Anthropic のウェブ検索。頼まれたときだけ）には、
// **活動中の問題の名前だけ**（documents.ts の gatherReferences。症例に固有の値・記録の文を渡さない）。
// (3) AI（Anthropic）には、記録から決定論で作った資料（core の supportMaterial。識別情報を置き換えた後の記録から）と、出典の抜き出し。
// 保存するのは、確かめた後の支援だけ（根拠は資料の短い名前、出典は題・頁・URL。本文・AI の答えそのものは残さない）。
import { checkSupport, compareDateTime, japanDateTime, type SupportBody, type SupportInput, supportBasis, supportMaterial, supportMessage } from '@clinical-carte/core';

import type { Db } from './db.ts';
import { type CallGate, gatherReferences } from './documents.ts';
import type { Organizer } from './organizer.ts';
import { listInputOf } from './problemlist.ts';
import { SUPPORT_PROMPT_VERSION } from './prompt.ts';
import { getRecord, type PatientRecord } from './records.ts';
import type { BookSearcher } from './references.ts';
import type { Runtime } from './runtime.ts';
import type { SelectorFailure } from './selector.ts';

/** 資料の入力を、記録から作る：いまの受診（いちばん新しい受診）の、外していない事実と、プロブレムリスト。なければ null */
export function supportInputOf(record: PatientRecord, today: string): SupportInput | null {
  const encounter = record.encounters.at(-1);
  if (encounter === undefined) return null;
  const here = <T extends { readonly encounterId: string; readonly excluded: boolean }>(list: readonly T[]): T[] => list.filter((x) => x.encounterId === encounter.id && !x.excluded);
  const observations = here(record.observations);
  const medications = here(record.medications);
  const events = here(record.events);
  // 記録の上で最後の日時（この受診の、記載・投薬・できごと・測定値のいちばん新しい日時。端末の時計ではない）
  const times = [...record.sources.filter((s) => s.encounterId === encounter.id).map((s) => s.at), ...observations.map((o) => o.at), ...medications.map((m) => m.at), ...events.map((e) => e.at)].filter(
    (t): t is string => t !== null,
  );
  const asOf = times.sort(compareDateTime).at(-1) ?? null;
  const list = listInputOf(record);
  return {
    patient: record.patient,
    today,
    encounter: { kind: encounter.kind, start: encounter.start, end: encounter.end },
    asOf,
    list: record.problemList?.items ?? [],
    threads: list.threads,
    course: list.course,
    observations,
    medications,
    events,
  };
}

export type SupportOutcome =
  | { readonly ok: true; readonly body: SupportBody }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'empty' }
  | { readonly ok: false; readonly reason: 'ai_limit' }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure };

export async function generateSupport(
  db: Db,
  patientId: string,
  options: { readonly web: boolean; readonly organizer: Organizer; readonly books: BookSearcher | null; readonly gate: CallGate; readonly runtime: Runtime; readonly today: string },
): Promise<SupportOutcome> {
  const record = await getRecord(db, patientId);
  if (record === null) return { ok: false, reason: 'not_found' };
  const input = supportInputOf(record, options.today);
  if (input === null) return { ok: false, reason: 'empty' };
  const material = supportMaterial(input);
  // 支援を書く問題（プロブレムリストの活動中の項目）がなければ、AI を呼ばない
  if (material.targets.size === 0) return { ok: false, reason: 'empty' };
  const refs = await gatherReferences(material.problemNames, { web: options.web, books: options.books, organizer: options.organizer, gate: options.gate });
  const citations = [...refs.books, ...refs.web];
  if (!(await options.gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await options.organizer.support(supportMessage(material, citations));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  const checked = checkSupport(answered.answer, material, citations);
  const body: SupportBody = {
    problems: [...checked.problems],
    rejected: checked.rejected,
    shapes: checked.shapes,
    research: { books: refs.books.length, web: refs.web.length, webFailed: refs.webFailed },
    dropped: material.dropped,
  };
  await db
    .prepare(
      'INSERT INTO clinical_support (patient_id, made_at, prompt_version, basis, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(patient_id) DO UPDATE SET made_at = excluded.made_at, prompt_version = excluded.prompt_version, basis = excluded.basis, body = excluded.body',
    )
    .bind(patientId, japanDateTime(options.runtime.now()), SUPPORT_PROMPT_VERSION, supportBasis(record.sources, record.problemList?.madeAt ?? null), JSON.stringify(body))
    .run();
  return { ok: true, body };
}
