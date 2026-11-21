// 段4：AI の草案（CA-023）。まず「入院後経過（問題ごと）」。純関数。
//
// - 草案は、保存しない・ログに残さない。その場で作り、画面に出すだけ（記録の正本にしない）。
// - AI に渡すのは、保存した文から決定論で切り出した「引用」（記号 Q1… 付き）だけ：問題ごとの A・P の区切り、
//   その問題の記載に書かれた投薬・できごと（段3c の範囲）。日付と病日を添える（数の確かめに使う）。
// - AI は文を書き、文ごとに根拠の引用の記号を付ける。確かめ（checkDraft）は決定論：
//   記号が実在する・その問題の引用である・文の中の数が根拠の引用にある（日付・時刻・病日の形の数だけは、引用の日時・病日でもよい）・識別情報の形がない・長さ。
//   通らない文は出さず、理由ごとの件数だけを返す（黙って捨てない）。
import { z } from 'zod';

import { findShapes } from '../guard/shapes.ts';
import { EVENT_KIND_NAMES, type EventKind, MEDICATION_ACTION_NAMES, type MedicationAction, type ProblemStatus, SEGMENT_LABEL_NAMES } from '../organize/answer.ts';
import { type NoteSegment, problemBlocks, problemNotes, type ThreadMention, type ThreadView, withinBlocks } from '../problems/threads.ts';
import { hospitalDay } from '../record/headline.ts';
import { compareDateTime } from '../time/datetime.ts';

/** 1つの引用の長さの上限（長い区切りは、先頭から切る） */
export const DRAFT_QUOTE_MAX = 400;
/** 資料の全体の長さの上限（超えるときは、古い引用から落とす） */
export const DRAFT_MATERIAL_MAX = 24_000;
/** 草案の1文の長さの上限 */
export const DRAFT_SENTENCE_MAX = 300;

export interface DraftQuote {
  readonly id: string;
  /** 問題の記号（T1…）。問題に結びつかない引用は null */
  readonly problem: string | null;
  readonly sourceId: string;
  readonly at: string | null;
  /** 病日（入院のときだけ） */
  readonly day: number | null;
  /** 何の引用か（A・P・A/P・#問題・投薬・できごと） */
  readonly from: string;
  readonly text: string;
}

export interface DraftProblem {
  readonly ref: string;
  readonly threadId: string;
  readonly name: string;
  readonly status: ProblemStatus;
}

export interface DraftMaterial {
  readonly problems: readonly DraftProblem[];
  readonly quotes: readonly DraftQuote[];
  /** AI に送る文（JSON） */
  readonly message: string;
  /** 長さの上限で落とした引用の数 */
  readonly dropped: number;
}

export interface MaterialInput {
  readonly encounter: { readonly id: string; readonly kind: 'er' | 'outpatient' | 'inpatient'; readonly start: string };
  readonly sources: readonly { readonly id: string; readonly encounterId: string; readonly at: string | null; readonly text: string }[];
  /** 問題の筋（段3a の threadViews） */
  readonly threads: readonly ThreadView[];
  readonly segments: readonly NoteSegment[];
  readonly medications: readonly { readonly sourceId: string; readonly start: number; readonly end: number; readonly name: string; readonly doseText: string | null; readonly action: MedicationAction | null; readonly at: string | null }[];
  readonly events: readonly { readonly sourceId: string; readonly start: number; readonly end: number; readonly kind: EventKind; readonly title: string; readonly at: string | null }[];
}

const showDate = (at: string | null): string => (at === null ? '日時不明' : at.replace('T', ' '));

/** 入院後経過の草案の資料：この受診の記載のうち、問題ごとの A・P と、その問題の記載に書かれた投薬・できごと */
export function courseMaterial(input: MaterialInput): DraftMaterial {
  const own = new Map(input.sources.filter((s) => s.encounterId === input.encounter.id).map((s) => [s.id, s]));
  const dayOf = (at: string | null): number | null => (input.encounter.kind === 'inpatient' && at !== null ? hospitalDay(input.encounter.start, at) : null);
  const problems: DraftProblem[] = [];
  const pool: Omit<DraftQuote, 'id'>[] = [];
  for (const t of input.threads) {
    const mentions: ThreadMention[] = t.mentions.filter((m) => own.has(m.sourceId));
    if (mentions.length === 0) continue;
    const ref = `T${String(problems.length + 1)}`;
    problems.push({ ref, threadId: t.id, name: t.name, status: t.status });
    for (const n of problemNotes(mentions, input.segments, input.threads.flatMap((x) => x.mentions))) {
      const text = own.get(n.sourceId)?.text.slice(n.start, n.end).trim() ?? '';
      if (text === '') continue;
      pool.push({ problem: ref, sourceId: n.sourceId, at: n.at, day: dayOf(n.at), from: SEGMENT_LABEL_NAMES[n.label], text: text.slice(0, DRAFT_QUOTE_MAX) });
    }
    const blocks = problemBlocks(mentions, input.segments);
    for (const m of withinBlocks(input.medications, blocks)) {
      const action = m.action === null ? '動きの記載なし' : MEDICATION_ACTION_NAMES[m.action];
      pool.push({ problem: ref, sourceId: m.sourceId, at: m.at, day: dayOf(m.at), from: '投薬', text: `${m.name}${m.doseText === null ? '' : ` ${m.doseText}`}（${action}）` });
    }
    for (const e of withinBlocks(input.events, blocks)) {
      pool.push({ problem: ref, sourceId: e.sourceId, at: e.at, day: dayOf(e.at), from: `できごと（${EVENT_KIND_NAMES[e.kind]}）`, text: e.title });
    }
  }
  // 古い順に並べ、長さの上限を超えたら、古いものから落とす
  pool.sort((a, b) => compareDateTime(a.at, b.at));
  let total = 0;
  const kept: Omit<DraftQuote, 'id'>[] = [];
  for (let i = pool.length - 1; i >= 0; i -= 1) {
    const q = pool[i];
    if (q === undefined) continue;
    total += q.text.length + 40;
    if (total > DRAFT_MATERIAL_MAX) break;
    kept.unshift(q);
  }
  const quotes: DraftQuote[] = kept.map((q, i) => ({ ...q, id: `Q${String(i + 1)}` }));
  const message = JSON.stringify({
    problems: problems.map((p) => ({ ref: p.ref, name: p.name })),
    quotes: quotes.map((q) => ({ id: q.id, problem: q.problem, date: showDate(q.at), day: q.day === null ? null : `${String(q.day)}病日`, from: q.from, text: q.text })),
  });
  return { problems, quotes, message, dropped: pool.length - kept.length };
}

/** AI の答え：問題ごとに、文と、その文の根拠の引用の記号 */
export const DraftAnswer = z.object({
  sections: z.array(z.object({ problem: z.string(), sentences: z.array(z.object({ text: z.string(), cites: z.array(z.string()) })) })),
});
export type DraftAnswer = z.infer<typeof DraftAnswer>;

export const DRAFT_REJECT_REASONS = ['unknown_problem', 'no_cite', 'unknown_cite', 'other_problem', 'number', 'shape', 'shape_of_text'] as const;
export type DraftRejectReason = (typeof DRAFT_REJECT_REASONS)[number];
export const DRAFT_REJECT_NAMES: Readonly<Record<DraftRejectReason, string>> = {
  unknown_problem: '知らない問題の記号',
  no_cite: '根拠の引用がない',
  unknown_cite: '知らない引用の記号',
  other_problem: '別の問題の引用を根拠にした',
  number: '根拠の引用にない数がある',
  shape: '識別情報の形がある',
  shape_of_text: '文の形が違う（空・長すぎる・改行）',
};

export interface DraftSentence {
  readonly text: string;
  readonly cites: readonly DraftQuote[];
}

export interface CheckedDraft {
  readonly sections: readonly { readonly problem: DraftProblem; readonly sentences: readonly DraftSentence[] }[];
  readonly rejected: Partial<Record<DraftRejectReason, number>>;
}

/** 日付・時刻・病日の形（この形の数は、引用の日時・病日とも照らす） */
const WHEN_SHAPE = /\d{4}-\d{1,2}-\d{1,2}|\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}月|\d{1,2}日|\d{1,2}時(?:\d{1,2}分)?|\d{1,2}:\d{2}|第?\d+病日/gu;

/** 数をそろえる（先頭の 0 の違い「09」と「9」は同じ数） */
const numbers = (text: string): string[] => (text.match(/\d+/g) ?? []).map((n) => String(Number(n)));

/**
 * 文の中の数が、根拠の引用にあるか。日付・時刻・病日の形の数は、引用の本文・日時・病日のどれかにあればよい。
 * それ以外の数（検査値・用量など）は、引用の本文にあるものだけ（日時・病日の数で、検査値の数を通さない）。
 */
export function numbersBacked(text: string, cited: readonly { readonly text: string; readonly at: string | null; readonly day: number | null }[]): boolean {
  const normalized = text.normalize('NFKC');
  const body = new Set(cited.flatMap((q) => numbers(q.text.normalize('NFKC'))));
  const when = new Set([...body, ...cited.flatMap((q) => [...numbers(q.at ?? ''), ...(q.day === null ? [] : [String(q.day)])])]);
  const whenParts = normalized.match(WHEN_SHAPE) ?? [];
  if (whenParts.some((part) => numbers(part).some((n) => !when.has(n)))) return false;
  const rest = normalized.replace(WHEN_SHAPE, ' ');
  return numbers(rest).every((n) => body.has(n));
}

export function checkDraft(answer: DraftAnswer, material: DraftMaterial): CheckedDraft {
  const rejected: Partial<Record<DraftRejectReason, number>> = {};
  const count = (r: DraftRejectReason): void => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  const problems = new Map(material.problems.map((p) => [p.ref, p]));
  const quotes = new Map(material.quotes.map((q) => [q.id, q]));
  const sections: { problem: DraftProblem; sentences: DraftSentence[] }[] = [];
  for (const section of answer.sections) {
    const problem = problems.get(section.problem);
    if (problem === undefined) {
      for (let i = 0; i < section.sentences.length; i += 1) count('unknown_problem');
      continue;
    }
    const sentences: DraftSentence[] = [];
    for (const s of section.sentences) {
      const text = s.text.trim();
      if (text === '' || text.length > DRAFT_SENTENCE_MAX || text.includes('\n')) {
        count('shape_of_text');
        continue;
      }
      if (s.cites.length === 0) {
        count('no_cite');
        continue;
      }
      const cited = s.cites.map((id) => quotes.get(id));
      if (cited.some((q) => q === undefined)) {
        count('unknown_cite');
        continue;
      }
      const real = cited.filter((q): q is DraftQuote => q !== undefined);
      if (real.some((q) => q.problem !== problem.ref)) {
        count('other_problem');
        continue;
      }
      if (!numbersBacked(text, real)) {
        count('number');
        continue;
      }
      if (findShapes(text).length > 0) {
        count('shape');
        continue;
      }
      sentences.push({ text, cites: real });
    }
    if (sentences.length > 0) sections.push({ problem, sentences });
  }
  return { sections, rejected };
}
