// 段5：A/P（評価と方針）と記載ノート（CA-030〜035）。純関数。
//
// - A/P は、本人が書く・AI の案を採用する・議論から決めたことを残す。保存するのは決まったことだけ（CA-032）。
// - AI の案と議論の答えは、文ごとに根拠（記録の引用 Q・書籍 B・ネット W）の記号を付けさせ、決定論で確かめる（checkProposal）：
//   記号が実在する・その問題の記録の引用か出典である・文の中の数が根拠の出典にある（日付・病日の形の数だけは日時・病日でもよい）・
//   識別情報の形がない・長さ。通らない文は出さず、理由ごとの数を返す（黙って捨てない）。
// - 参照（ApRef）は、場所・題・頁・URL だけ。書籍・ページの本文は保存しない（CA-031・CA-035）。
import { z } from 'zod';

import { numbersBacked } from '../draft/course.ts';
import { findShapes } from '../guard/shapes.ts';
import { Day, Ulid } from '../record/schema.ts';

export const AP_PARTS = ['assessment', 'plan'] as const;
export type ApPart = (typeof AP_PARTS)[number];
export const AP_PART_NAMES: Readonly<Record<ApPart, string>> = { assessment: 'A（評価）', plan: 'P（方針）' };

/** 方針の種類（POMR の初期計画の分け方）。分けないなら other */
export const PLAN_KINDS = ['dx', 'tx', 'ex', 'other'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];
export const PLAN_KIND_NAMES: Readonly<Record<PlanKind, string>> = { dx: 'Dx（診断）', tx: 'Tx（治療）', ex: 'Ex（説明・教育）', other: 'その他' };

/** 誰の文か：本人が書いた・AI の案をそのまま採用した・AI の案を採用して本人が直した */
export const AP_ORIGINS = ['self', 'ai', 'ai_edited'] as const;
export type ApOrigin = (typeof AP_ORIGINS)[number];
export const AP_ORIGIN_NAMES: Readonly<Record<ApOrigin, string>> = { self: '先生', ai: 'AI 案から採用', ai_edited: 'AI 案を直した' };

/** A/P の1つの文の長さの上限 */
export const AP_TEXT_MAX = 600;
/** AI の案・議論の1つの文の長さの上限 */
export const PROPOSAL_SENTENCE_MAX = 300;

/** 根拠の参照（本文は持たない） */
export const ApRef = z.discriminatedUnion('k', [
  z.strictObject({ k: z.literal('record'), sourceId: Ulid, start: z.number().int().min(0), end: z.number().int().min(0) }),
  z.strictObject({ k: z.literal('book'), title: z.string().min(1).max(200), page: z.string().max(40).nullable(), path: z.string().max(300).nullable() }),
  z.strictObject({ k: z.literal('web'), title: z.string().max(300), url: z.url({ protocol: /^https?$/u }).max(2000) }),
]);
export type ApRef = z.infer<typeof ApRef>;

/** A/P を足す（打った文・採用した文。サーバーで選別を通す） */
export const ApNoteNew = z.strictObject({
  encounterId: Ulid,
  threadId: Ulid,
  day: Day,
  part: z.enum(AP_PARTS),
  planKind: z.enum(PLAN_KINDS).nullable(),
  text: z.string().min(1).max(AP_TEXT_MAX),
  origin: z.enum(['self', 'ai']),
  refs: z.array(ApRef).max(20),
});
export type ApNoteNew = z.infer<typeof ApNoteNew>;

/** まとめて足す（採用を一度に。選別は1回） */
export const ApNotesNew = z.strictObject({ notes: z.array(ApNoteNew).min(1).max(30) });

/** A/P を直す：文（選別を通す。AI 由来なら ai_edited になる）か、方針の種類 */
export const ApNotePatch = z.union([z.strictObject({ text: z.string().min(1).max(AP_TEXT_MAX) }), z.strictObject({ planKind: z.enum(PLAN_KINDS).nullable() })]);
export type ApNotePatch = z.infer<typeof ApNotePatch>;

// ---------------------------------------------------------------------------
// 根拠の出典（AI に見せる・確かめに使う）

export type RefKind = 'record' | 'book' | 'web';

export interface RefSource {
  /** 記号（Q1・B1・W1） */
  readonly id: string;
  readonly kind: RefKind;
  /** 問題の記号（記録の引用だけ。書籍・ネットは null：どの問題にも使える） */
  readonly problem: string | null;
  readonly text: string;
  readonly at: string | null;
  readonly day: number | null;
  /** 画面に出す見出し（区切りの名前・書名と頁・ページの題） */
  readonly label: string;
  readonly ref: ApRef;
}

export interface MaterialProblem {
  readonly ref: string;
  readonly threadId: string;
  readonly name: string;
}

/** AI に送る資料（JSON）。記録の引用は保存した文の字、書籍は RAG の抜き出し、ネットは検索の引用 */
export function proposalMessage(problems: readonly MaterialProblem[], sources: readonly RefSource[], extra: { readonly day: string; readonly question?: string; readonly history?: readonly { readonly role: 'doctor' | 'ai'; readonly text: string }[] }): string {
  return JSON.stringify({
    day: extra.day,
    problems: problems.map((p) => ({ ref: p.ref, name: p.name })),
    sources: sources.map((s) => ({ id: s.id, kind: s.kind, problem: s.problem, date: s.at?.replace('T', ' ') ?? null, day: s.day === null ? null : `${String(s.day)}病日`, label: s.label, text: s.text })),
    ...(extra.history === undefined ? {} : { conversation: extra.history }),
    ...(extra.question === undefined ? {} : { question: extra.question }),
  });
}

/** AI の A/P の案の形 */
const Sentence = z.object({ text: z.string(), cites: z.array(z.string()), basis: z.enum(['record', 'source', 'inference']) });
export const ProposalAnswer = z.object({
  problems: z.array(
    z.object({
      problem: z.string(),
      assessment: z.array(Sentence),
      plan: z.array(Sentence.extend({ kind: z.enum(PLAN_KINDS) })),
    }),
  ),
});
export type ProposalAnswer = z.infer<typeof ProposalAnswer>;

/** 議論の答えの形 */
export const DiscussAnswer = z.object({ paragraphs: z.array(Sentence) });
export type DiscussAnswer = z.infer<typeof DiscussAnswer>;

export const PROPOSAL_REJECT_REASONS = ['unknown_problem', 'no_cite', 'unknown_cite', 'other_problem', 'number', 'shape', 'shape_of_text'] as const;
export type ProposalRejectReason = (typeof PROPOSAL_REJECT_REASONS)[number];
export const PROPOSAL_REJECT_NAMES: Readonly<Record<ProposalRejectReason, string>> = {
  unknown_problem: '知らない問題の記号',
  no_cite: '根拠がない',
  unknown_cite: '知らない根拠の記号',
  other_problem: '別の問題の記録を根拠にした',
  number: '根拠の出典にない数（用量・閾値を含む）がある',
  shape: '識別情報の形がある',
  shape_of_text: '文の形が違う（空・長すぎる・改行）',
};

/** 確かめた文。basis は、根拠に書籍・ネットがなければ「推論」か「記録」に直す（AI の申告を信じない） */
export interface CheckedSentence {
  readonly text: string;
  readonly cites: readonly RefSource[];
  readonly basis: 'record' | 'source' | 'inference';
  readonly kind?: (typeof PLAN_KINDS)[number];
}

type Reject = Partial<Record<ProposalRejectReason, number>>;

function checkSentence(
  s: { text: string; cites: readonly string[]; basis: 'record' | 'source' | 'inference' },
  problem: string | null,
  sources: ReadonlyMap<string, RefSource>,
  count: (r: ProposalRejectReason) => void,
): CheckedSentence | null {
  const text = s.text.trim();
  if (text === '' || text.length > PROPOSAL_SENTENCE_MAX || /[\r\n]/u.test(text)) {
    count('shape_of_text');
    return null;
  }
  if (s.cites.length === 0) {
    count('no_cite');
    return null;
  }
  const cited = s.cites.map((id) => sources.get(id));
  if (cited.some((c) => c === undefined)) {
    count('unknown_cite');
    return null;
  }
  const real = [...new Map(cited.filter((c): c is RefSource => c !== undefined).map((c) => [c.id, c])).values()];
  if (problem !== null && real.some((c) => c.kind === 'record' && c.problem !== null && c.problem !== problem)) {
    count('other_problem');
    return null;
  }
  if (!numbersBacked(text, real)) {
    count('number');
    return null;
  }
  if (findShapes(text).length > 0) {
    count('shape');
    return null;
  }
  const hasSource = real.some((c) => c.kind !== 'record');
  const basis = hasSource && s.basis === 'source' ? 'source' : s.basis === 'record' && !hasSource ? 'record' : 'inference';
  return { text, cites: real, basis };
}

export interface CheckedProposal {
  readonly problems: readonly { readonly problem: MaterialProblem; readonly assessment: readonly CheckedSentence[]; readonly plan: readonly CheckedSentence[] }[];
  readonly rejected: Reject;
}

export function checkProposal(answer: ProposalAnswer, problems: readonly MaterialProblem[], sources: readonly RefSource[]): CheckedProposal {
  const rejected: Reject = {};
  const count = (r: ProposalRejectReason): void => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  const byRef = new Map(problems.map((p) => [p.ref, p]));
  const bySource = new Map(sources.map((s) => [s.id, s]));
  const out: { problem: MaterialProblem; assessment: CheckedSentence[]; plan: CheckedSentence[] }[] = [];
  for (const p of answer.problems) {
    const problem = byRef.get(p.problem);
    if (problem === undefined) {
      for (let i = 0; i < p.assessment.length + p.plan.length; i += 1) count('unknown_problem');
      continue;
    }
    const assessment = p.assessment.map((s) => checkSentence(s, problem.ref, bySource, count)).filter((s): s is CheckedSentence => s !== null);
    const plan: CheckedSentence[] = [];
    for (const s of p.plan) {
      const c = checkSentence(s, problem.ref, bySource, count);
      if (c !== null) plan.push({ ...c, kind: s.kind });
    }
    if (assessment.length + plan.length > 0) out.push({ problem, assessment, plan });
  }
  return { problems: out, rejected };
}

export interface CheckedDiscussion {
  readonly paragraphs: readonly CheckedSentence[];
  readonly rejected: Reject;
}

/** 議論の答えを確かめる（問題は1つ。記録の引用は、その問題のものだけを根拠にできる） */
export function checkDiscussion(answer: DiscussAnswer, problemRef: string, sources: readonly RefSource[]): CheckedDiscussion {
  const rejected: Reject = {};
  const count = (r: ProposalRejectReason): void => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  const bySource = new Map(sources.map((s) => [s.id, s]));
  const paragraphs = answer.paragraphs.map((s) => checkSentence(s, problemRef, bySource, count)).filter((s): s is CheckedSentence => s !== null);
  return { paragraphs, rejected };
}

/** 議論の本文の形（打った問いと、これまでのやりとり。保存しない） */
export const DISCUSS_TEXT_MAX = 2000;
export const DiscussRequest = z.strictObject({
  threadId: Ulid,
  day: Day,
  web: z.boolean(),
  question: z.string().min(1).max(DISCUSS_TEXT_MAX),
  history: z.array(z.strictObject({ role: z.enum(['doctor', 'ai']), text: z.string().min(1).max(DISCUSS_TEXT_MAX) })).max(20),
});
export type DiscussRequest = z.infer<typeof DiscussRequest>;

/** A/P の案を頼む */
/** 1回の A/P の案に入れる問題の数の上限。超えるときは、画面が数を出して選んでもらう（黙って切らない） */
export const PROPOSAL_PROBLEMS_MAX = 10;
export const ProposalRequest = z.strictObject({ day: Day, threadIds: z.array(Ulid).min(1).max(PROPOSAL_PROBLEMS_MAX), web: z.boolean() });
export type ProposalRequest = z.infer<typeof ProposalRequest>;
