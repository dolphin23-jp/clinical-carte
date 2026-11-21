// 段5：A/P の案と議論（CA-030〜035）。**保存しない・ログに残さない**：資料を作り、AI に送り、決定論で確かめて、答えるだけ。
// 資料は3つ：(1) 記録の引用（保存した文の字。core の recordSources）、(2) 書籍（本人の clinical-RAG の検索。設定があるときだけ）、
// (3) ネットの出典（Anthropic のウェブ検索。本人が選んだときだけ）。
// **外へ出す検索語は、問題の名前だけ**：RAG に送るのも、ウェブ検索の係に渡すのも、問題の名前だけ（症例に固有の値・問い・やりとりを渡さない）。
// 確かめは core の checkProposal・checkDiscussion（根拠の記号・根拠にない数・識別情報の形）。
import {
  checkDiscussion,
  type CheckedDiscussion,
  type CheckedProposal,
  checkProposal,
  findShapes,
  type MaterialProblem,
  type NoteInput,
  proposalMessage,
  recordSources,
  type RefSource,
  threadViews,
} from '@clinical-carte/core';

import type { Db } from './db.ts';
import type { Organizer } from './organizer.ts';
import { getEncounter, getRecord } from './records.ts';
import { type BookSearcher, bookSources, webSources } from './references.ts';
import type { SelectorFailure } from './selector.ts';

export interface Material {
  readonly problems: readonly MaterialProblem[];
  readonly record: readonly RefSource[];
}

/** 記録の引用を作る（AI を呼ぶ前に、空かどうか・筋がこの受診の患者のものかを見るため、分けてある） */
export async function materialFor(db: Db, encounterId: string, threadIds: readonly string[], day: string): Promise<Material | null> {
  const encounter = await getEncounter(db, encounterId);
  if (encounter === null) return null;
  const record = await getRecord(db, encounter.patientId);
  if (record === null) return null;
  const threads = threadViews(record.problemThreads, record.problems).threads;
  const chosen = threadIds.map((id) => threads.find((t) => t.id === id));
  if (chosen.some((t) => t === undefined)) return null;
  const problems: MaterialProblem[] = chosen.flatMap((t, i) => (t === undefined ? [] : [{ ref: `T${String(i + 1)}`, threadId: t.id, name: t.name }]));
  const input: NoteInput = {
    encounter,
    day,
    sources: record.sources,
    segments: record.segments,
    threads,
    observations: record.observations.filter((o) => !o.excluded),
    medications: record.medications.filter((m) => m.encounterId === encounterId && !m.excluded),
  };
  return { problems, record: recordSources(input, problems) };
}

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
  const books = options.books === null ? [] : bookSources(await options.books.search(names));
  if (!options.web) return { books, web: [], webFailed: false };
  if (!(await options.gate.take())) return { books, web: [], webFailed: true };
  const researched = await options.organizer.research(JSON.stringify({ problems: names }));
  if (!researched.ok) return { books, web: [], webFailed: true };
  return { books, web: webSources(researched.hits), webFailed: false };
}

/** 記号を振り直す：書籍 B1…・ネット W1… は、記録の引用と同じ表で、記号がぶつからないようにする */
const allSources = (material: Material, refs: References): RefSource[] => [...material.record, ...refs.books, ...refs.web];

export type ProposalOutcome =
  | { readonly ok: true; readonly proposal: CheckedProposal; readonly sources: readonly RefSource[]; readonly webFailed: boolean }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure }
  | { readonly ok: false; readonly reason: 'ai_limit' };

export async function propose(material: Material, day: string, refs: References, organizer: Organizer, gate: CallGate): Promise<ProposalOutcome> {
  const sources = allSources(material, refs);
  if (!(await gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await organizer.propose(proposalMessage(material.problems, sources, { day }));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  return { ok: true, proposal: checkProposal(answered.answer, material.problems, sources), sources, webFailed: refs.webFailed };
}

export type DiscussOutcome =
  | { readonly ok: true; readonly discussion: CheckedDiscussion; readonly sources: readonly RefSource[]; readonly webFailed: boolean }
  | { readonly ok: false; readonly reason: 'ai'; readonly failure: SelectorFailure }
  | { readonly ok: false; readonly reason: 'ai_limit' };

export async function discuss(
  material: Material,
  day: string,
  talk: { readonly question: string; readonly history: readonly { readonly role: 'doctor' | 'ai'; readonly text: string }[] },
  refs: References,
  organizer: Organizer,
  gate: CallGate,
): Promise<DiscussOutcome> {
  const sources = allSources(material, refs);
  const problem = material.problems[0];
  if (problem === undefined) return { ok: false, reason: 'ai', failure: 'bad_answer' };
  if (!(await gate.take())) return { ok: false, reason: 'ai_limit' };
  const answered = await organizer.discuss(proposalMessage(material.problems, sources, { day, question: talk.question, history: talk.history }));
  if (!answered.ok) return { ok: false, reason: 'ai', failure: answered.reason };
  return { ok: true, discussion: checkDiscussion(answered.answer, problem.ref, sources), sources, webFailed: refs.webFailed };
}

/** 打った問い・やりとりに、識別情報の形（電話・メールなど）があれば送らない（保存しないが、外へ出さない） */
export function talkHasShapes(talk: { readonly question: string; readonly history: readonly { readonly text: string }[] }): boolean {
  return [talk.question, ...talk.history.map((h) => h.text)].some((t) => findShapes(t).length > 0);
}
