// 問題の筋（段3a。CA-024・CA-025。docs/04 の 9）：記載ごとの問題（problems の行）を、患者ごとの「問題の筋」につなぐ。純関数。
//
// - 名前が同じ（番号「#1」・全角半角・空白の違いを除いて）なら、決定論でつなぐ（rule）。
// - それ以外は、AI が「どの筋と同じか」「どの新しい記載どうしが同じか」を、参照の記号（T1・M1）で指す（ai）。
//   AI に見せるのは、すでに保存した問題の名前と、その記載の行（保存した文の一部）だけ。AI は名前を作らない。
// - AI の答えは確かめる：知らない記号・自分自身・1つの記載への2つの答え・食い違う2つの筋は、使わない（数だけ数える）。
// - 見方（threadViews）は、並べるだけ：確からしさと、解決・非活動は、いちばん新しい記載に書かれたとおり（CA-025）。判定しない。
import { z } from 'zod';

import { type ProblemActivity, type ProblemStatus, type SegmentLabel } from '../organize/answer.ts';
import { nameKey, problemKey } from '../organize/views.ts';
import { Ulid } from '../record/schema.ts';
import { compareDateTime } from '../time/datetime.ts';

/** 記載ごとの問題（problems の1行） */
export interface ThreadMention {
  readonly id: string;
  readonly sourceId: string;
  readonly threadId: string | null;
  readonly name: string;
  readonly status: ProblemStatus;
  readonly activity: ProblemActivity | null;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
}

/** 問題の筋（problem_threads の1行） */
export interface ThreadRow {
  readonly id: string;
  /** 本人が、書かれた名前から選んだ表示の名前（なければ null：いちばん新しい記載の名前） */
  readonly displayName: string | null;
  /** 本人が統合した先（なければ null） */
  readonly mergedInto: string | null;
}

/** 記載の順：日時（日時のないものは最後）→ 入れた順（文の id は ULID）→ 文の中の場所 */
export function compareMentions(a: ThreadMention, b: ThreadMention): number {
  return compareDateTime(a.at, b.at) || a.sourceId.localeCompare(b.sourceId) || a.start - b.start || a.id.localeCompare(b.id);
}

/** 統合をたどって、いまの筋の id（たどれない・輪になっているときは null） */
export function liveThreadId(threads: ReadonlyMap<string, ThreadRow>, id: string | null): string | null {
  let current = id;
  for (let i = 0; i <= threads.size && current !== null; i += 1) {
    const row = threads.get(current);
    if (row === undefined) return null;
    if (row.mergedInto === null) return row.id;
    current = row.mergedInto;
  }
  return null;
}

// ---------------------------------------------------------------------------
// つなぐ

/** まだ筋につないでいない記載を、同じ名前どうしでまとめたもの（AI には、まとまりごとに1つの記号で見せる） */
export interface PendingGroup {
  readonly key: string;
  readonly mentions: readonly ThreadMention[];
}

export interface LinkPlan {
  /** 名前が同じ筋が1つだけあったので、決定論でつないだもの（記載の id → 筋の id） */
  readonly rule: ReadonlyMap<string, string>;
  /** まだ決まらないもの（名前ごとのまとまり） */
  readonly pending: readonly PendingGroup[];
  /** AI に聞くか（すでに筋があるか、名前の違うまとまりが2つ以上あるとき） */
  readonly needsAi: boolean;
}

/**
 * つなぐ計画：threadId のない記載（todo）を、名前が同じ筋へ決定論でつなぎ、残りを名前ごとにまとめる。
 * 名前が同じ筋が2つ以上あるとき（本人が分けたなど）は、決めずに AI に回す。
 */
export function planLinks(threads: readonly ThreadRow[], mentions: readonly ThreadMention[]): LinkPlan {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const keyThreads = new Map<string, Set<string>>();
  for (const m of mentions) {
    const live = liveThreadId(byId, m.threadId);
    if (live === null) continue;
    const key = problemKey(m.name);
    const set = keyThreads.get(key) ?? new Set<string>();
    set.add(live);
    keyThreads.set(key, set);
  }
  const rule = new Map<string, string>();
  const groups = new Map<string, ThreadMention[]>();
  for (const m of [...mentions].sort(compareMentions)) {
    if (liveThreadId(byId, m.threadId) !== null) continue;
    const key = problemKey(m.name);
    const candidates = keyThreads.get(key);
    if (candidates?.size === 1) {
      rule.set(m.id, [...candidates][0] ?? '');
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  const pending = [...groups.entries()].map(([key, list]) => ({ key, mentions: list }));
  const liveThreads = new Set([...keyThreads.values()].flatMap((s) => [...s]));
  return { rule, pending, needsAi: pending.length > 0 && (liveThreads.size > 0 || pending.length >= 2) };
}

/** AI に見せる、筋の数と記載のまとまりの数の上限（多すぎる分は、次の機会に回す） */
export const LINK_THREADS_MAX = 60;
export const LINK_PENDING_MAX = 60;
/** 1つの筋について見せる名前の数 */
export const LINK_NAMES_MAX = 6;
/** 記載の行の長さの上限 */
export const LINK_LINE_MAX = 200;

/** 記載のある行（保存した文の、その行。長ければ、記載の前後だけ） */
export function mentionLine(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf('\n', end);
  const lineEnd = nl < 0 ? text.length : nl;
  let from = lineStart;
  let to = lineEnd;
  if (to - from > LINK_LINE_MAX) {
    const room = Math.max(0, LINK_LINE_MAX - (end - start));
    from = Math.max(lineStart, start - Math.floor(room / 2));
    to = Math.min(lineEnd, from + LINK_LINE_MAX);
  }
  return text.slice(from, to).trim();
}

export interface LinkRequest {
  /** AI に送る文（JSON）。中身は、保存した問題の名前と、保存した文の行だけ */
  readonly message: string;
  /** 記号 → 筋の id */
  readonly threadRefs: ReadonlyMap<string, string>;
  /** 記号 → 記載のまとまり */
  readonly groupRefs: ReadonlyMap<string, PendingGroup>;
}

/** AI への依頼を作る。textOf は、文の id から保存した文 */
export function linkRequest(threads: readonly ThreadRow[], mentions: readonly ThreadMention[], pending: readonly PendingGroup[], textOf: (sourceId: string) => string | null): LinkRequest {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const perThread = new Map<string, ThreadMention[]>();
  for (const m of mentions) {
    const live = liveThreadId(byId, m.threadId);
    if (live === null) continue;
    const list = perThread.get(live) ?? [];
    list.push(m);
    perThread.set(live, list);
  }
  // 新しい記載のある順に、上限まで
  const ordered = [...perThread.entries()]
    .map(([id, list]) => ({ id, list: [...list].sort(compareMentions) }))
    .sort((a, b) => compareMentions(b.list.at(-1) as ThreadMention, a.list.at(-1) as ThreadMention))
    .slice(0, LINK_THREADS_MAX);
  const threadRefs = new Map<string, string>();
  const problems = ordered.map(({ id, list }, i) => {
    const ref = `T${String(i + 1)}`;
    threadRefs.set(ref, id);
    const names: string[] = [];
    const seen = new Set<string>();
    for (const m of list) {
      const k = nameKey(m.name);
      if (seen.has(k)) continue;
      seen.add(k);
      names.push(m.name);
    }
    return { ref, names: names.slice(-LINK_NAMES_MAX) };
  });
  const groupRefs = new Map<string, PendingGroup>();
  const added = pending.slice(0, LINK_PENDING_MAX).map((g, i) => {
    const ref = `M${String(i + 1)}`;
    groupRefs.set(ref, g);
    const first = g.mentions[0];
    const text = first === undefined ? null : textOf(first.sourceId);
    return { ref, name: first?.name ?? '', line: first === undefined || text === null ? '' : mentionLine(text, first.start, first.end) };
  });
  return { message: JSON.stringify({ problems, added }), threadRefs, groupRefs };
}

/** AI の答え：新しい記載のまとまり（M）が、どの筋（T）か、どの別のまとまり（M）と同じか。同じものがなければ、挙げない */
export const LinkAnswer = z.object({
  links: z.array(z.object({ added: z.string(), same_as: z.string() })),
});
export type LinkAnswer = z.infer<typeof LinkAnswer>;

export const LINK_REPORT_REASONS = ['unknown_ref', 'self', 'twice', 'conflict'] as const;
export type LinkReportReason = (typeof LINK_REPORT_REASONS)[number];
export const LINK_REPORT_REASON_NAMES: Readonly<Record<LinkReportReason, string>> = {
  unknown_ref: '知らない記号を指した',
  self: '自分自身を指した',
  twice: '1つの記載に、2つの答えがあった',
  conflict: '別々の問題を、同じだと指した',
};

export interface ResolvedGroup {
  readonly mentions: readonly ThreadMention[];
  /** つなぐ筋（null：新しい筋を作る） */
  readonly threadId: string | null;
}

export interface ResolvedLinks {
  readonly groups: readonly ResolvedGroup[];
  readonly report: Partial<Record<LinkReportReason, number>>;
}

/**
 * AI の答えを確かめて、まとまりごとの行き先にする。答えにない・使えないまとまりは、新しい筋（同じ名前のまとまりは、1つの筋）。
 * aiAnswer が null（AI を使わない・失敗した）なら、どれも新しい筋。
 */
export function resolveLinks(request: Pick<LinkRequest, 'threadRefs' | 'groupRefs'>, pending: readonly PendingGroup[], aiAnswer: LinkAnswer | null): ResolvedLinks {
  const report: Partial<Record<LinkReportReason, number>> = {};
  const count = (r: LinkReportReason): void => {
    report[r] = (report[r] ?? 0) + 1;
  };
  const refOf = new Map<PendingGroup, string>();
  for (const [ref, g] of request.groupRefs) refOf.set(g, ref);

  // 記号ごとの答え（2つ以上あれば、どれも使わない）
  const answers = new Map<string, string[]>();
  for (const link of aiAnswer?.links ?? []) {
    if (!request.groupRefs.has(link.added) || !(request.threadRefs.has(link.same_as) || request.groupRefs.has(link.same_as))) {
      count('unknown_ref');
      continue;
    }
    if (link.added === link.same_as) {
      count('self');
      continue;
    }
    const list = answers.get(link.added) ?? [];
    list.push(link.same_as);
    answers.set(link.added, list);
  }

  // まとまりどうしを、つなぐ（union-find）
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) ?? r;
    parent.set(x, r);
    return r;
  };
  for (const ref of request.groupRefs.keys()) parent.set(ref, ref);
  const threadOf = new Map<string, Set<string>>();
  for (const [added, targets] of answers) {
    if (targets.length > 1) {
      count('twice');
      continue;
    }
    const target = targets[0] ?? '';
    if (request.groupRefs.has(target)) parent.set(find(added), find(target));
    else {
      const set = threadOf.get(added) ?? new Set<string>();
      set.add(request.threadRefs.get(target) ?? '');
      threadOf.set(added, set);
    }
  }
  const rootThreads = new Map<string, Set<string>>();
  for (const [ref, set] of threadOf) {
    const root = find(ref);
    const all = rootThreads.get(root) ?? new Set<string>();
    for (const t of set) all.add(t);
    rootThreads.set(root, all);
  }

  const byRoot = new Map<string, ThreadMention[]>();
  const loose: PendingGroup[] = [];
  for (const g of pending) {
    const ref = refOf.get(g);
    if (ref === undefined) {
      loose.push(g); // 上限で、AI に見せなかったもの
      continue;
    }
    const root = find(ref);
    const list = byRoot.get(root) ?? [];
    list.push(...g.mentions);
    byRoot.set(root, list);
  }
  const groups: ResolvedGroup[] = [];
  for (const [root, list] of byRoot) {
    const targets = rootThreads.get(root);
    let threadId: string | null = null;
    if (targets !== undefined && targets.size === 1) threadId = [...targets][0] ?? null;
    else if (targets !== undefined && targets.size > 1) count('conflict');
    groups.push({ mentions: list, threadId });
  }
  for (const g of loose) groups.push({ mentions: g.mentions, threadId: null });
  return { groups, report };
}

// ---------------------------------------------------------------------------
// 本人の操作の形（API の本文）

/** 記載を、別の筋へ移す（new：新しい筋に分ける）。expected は、いまの筋（違えば、ほかの端末が先に直した） */
export const ProblemMove = z.strictObject({ thread: z.union([Ulid, z.literal('new')]), expected: Ulid.nullable() });
export type ProblemMove = z.infer<typeof ProblemMove>;

/** 筋を直す：別の筋へ統合する、または、表示の名前を、書かれた名前から選ぶ（null：いちばん新しい記載の名前に戻す） */
export const ThreadPatch = z.union([z.strictObject({ mergeInto: Ulid }), z.strictObject({ displayName: z.string().min(1).max(200).nullable() })]);
export type ThreadPatch = z.infer<typeof ThreadPatch>;

export const HISTORY_ACTIONS = ['move', 'merge', 'name'] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

// ---------------------------------------------------------------------------
// 見方

export type ThreadGroup = 'current' | 'closed' | 'ruled_out';
export const THREAD_GROUP_NAMES: Readonly<Record<ThreadGroup, string>> = {
  current: 'いまの問題',
  closed: '解決・非活動と書かれたもの',
  ruled_out: '否定的と書かれたもの',
};

export interface ThreadView {
  readonly id: string;
  /** 表示の名前：本人が選んだ名前（書かれた名前の1つ）か、いちばん新しい記載の名前 */
  readonly name: string;
  readonly chosenName: boolean;
  /** 名前の移り変わり：書かれた名前（同じ名前は1回）と、最初に書かれた日時 */
  readonly names: readonly { readonly name: string; readonly at: string | null }[];
  /** 記載（古い順） */
  readonly mentions: readonly ThreadMention[];
  /** いちばん新しい記載に書かれた確からしさ */
  readonly status: ProblemStatus;
  readonly statusAt: string | null;
  /** いちばん新しい記載に書かれた、解決・非活動（なければ null） */
  readonly activity: ProblemActivity | null;
  /** それより前の記載に、解決・非活動と書かれたことがあれば、そのいちばん新しいもの */
  readonly earlierActivity: { readonly activity: ProblemActivity; readonly at: string | null } | null;
  readonly first: string | null;
  readonly last: string | null;
  readonly group: ThreadGroup;
}

export interface ThreadViews {
  readonly threads: readonly ThreadView[];
  /** まだ筋につないでいない記載 */
  readonly unlinked: readonly ThreadMention[];
}

/** 筋ごとに、記載を束ねて並べる。統合した筋は、統合先にまとめる。記載のない筋は出さない。最初の記載の順 */
export function threadViews(threads: readonly ThreadRow[], mentions: readonly ThreadMention[]): ThreadViews {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const per = new Map<string, ThreadMention[]>();
  const unlinked: ThreadMention[] = [];
  for (const m of mentions) {
    const live = liveThreadId(byId, m.threadId);
    if (live === null) {
      unlinked.push(m);
      continue;
    }
    const list = per.get(live) ?? [];
    list.push(m);
    per.set(live, list);
  }
  const views: ThreadView[] = [];
  for (const [id, list] of per) {
    const sorted = [...list].sort(compareMentions);
    const latest = sorted.at(-1);
    if (latest === undefined) continue;
    const names: { name: string; at: string | null }[] = [];
    const seen = new Set<string>();
    for (const m of sorted) {
      const k = nameKey(m.name);
      if (seen.has(k)) continue;
      seen.add(k);
      names.push({ name: m.name, at: m.at });
    }
    const chosen = byId.get(id)?.displayName ?? null;
    const chosenOk = chosen !== null && sorted.some((m) => m.name === chosen);
    const earlier = [...sorted.slice(0, -1)].reverse().find((m) => m.activity !== null);
    const dated = sorted.filter((m) => m.at !== null);
    views.push({
      id,
      name: chosenOk ? chosen : latest.name,
      chosenName: chosenOk,
      names,
      mentions: sorted,
      status: latest.status,
      statusAt: latest.at,
      activity: latest.activity,
      earlierActivity: earlier?.activity == null ? null : { activity: earlier.activity, at: earlier.at },
      first: dated[0]?.at ?? null,
      last: dated.at(-1)?.at ?? null,
      group: latest.status === 'ruled_out' ? 'ruled_out' : latest.activity !== null ? 'closed' : 'current',
    });
  }
  views.sort((a, b) => compareMentions(a.mentions[0] as ThreadMention, b.mentions[0] as ThreadMention));
  return { threads: views, unlinked: [...unlinked].sort(compareMentions) };
}

// ---------------------------------------------------------------------------
// 問題ごとの記載（A・P）

export interface NoteSegment {
  readonly sourceId: string;
  readonly label: SegmentLabel;
  readonly start: number;
  readonly end: number;
}

export interface ProblemNote {
  readonly sourceId: string;
  readonly at: string | null;
  readonly label: SegmentLabel;
  readonly start: number;
  readonly end: number;
}

const SOAP: readonly SegmentLabel[] = ['subjective', 'objective', 'assessment', 'plan', 'assessment_plan'];
const AP: readonly SegmentLabel[] = ['assessment', 'plan', 'assessment_plan'];

/**
 * 問題ごとの記載：その問題の記載が、
 *  - 「#問題」の見出しの区切りにあれば、その見出しから次の見出しまで（S・O・A・P が続くあいだ）の A・P・A/P の区切り（なければ、見出しの区切りそのもの）
 *  - A・P・A/P の区切りの中にあれば、その区切り
 * を返す（同じ場所は1回。記載の順）。文の字は持たない（場所だけ。画面が保存した文から切り出す）。
 */
export function problemNotes(mentions: readonly ThreadMention[], segments: readonly NoteSegment[]): ProblemNote[] {
  const bySource = new Map<string, NoteSegment[]>();
  for (const s of segments) {
    const list = bySource.get(s.sourceId) ?? [];
    list.push(s);
    bySource.set(s.sourceId, list);
  }
  for (const list of bySource.values()) list.sort((a, b) => a.start - b.start);
  const out: ProblemNote[] = [];
  const seen = new Set<string>();
  const push = (m: ThreadMention, s: NoteSegment): void => {
    const key = `${s.sourceId}:${String(s.start)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ sourceId: s.sourceId, at: m.at, label: s.label, start: s.start, end: s.end });
  };
  for (const m of [...mentions].sort(compareMentions)) {
    const list = bySource.get(m.sourceId) ?? [];
    const i = list.findIndex((s) => s.start <= m.start && m.start < s.end);
    const seg = list[i];
    if (seg === undefined) continue;
    if (seg.label === 'problem_heading') {
      const block: NoteSegment[] = [];
      for (let j = i + 1; j < list.length; j += 1) {
        const next = list[j];
        if (next === undefined || !SOAP.includes(next.label)) break;
        block.push(next);
      }
      const ap = block.filter((s) => AP.includes(s.label));
      if (ap.length > 0) for (const s of ap) push(m, s);
      else push(m, seg);
    } else if (AP.includes(seg.label)) push(m, seg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 問題の記載の範囲と、その中に書かれた事実（段3c）

export interface Block {
  readonly sourceId: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 問題の記載の範囲：その問題の記載が
 *  - 「#問題」の見出しの区切りにあれば、見出しから、続く S・O・A・P・A/P の区切りの終わりまで
 *  - S・O・A・P・A/P の区切りの中にあれば、その区切り
 * （ほかの区切り・区切りのない文の中の記載は、範囲を持たない。推し量らない）
 */
export function problemBlocks(mentions: readonly ThreadMention[], segments: readonly NoteSegment[]): Block[] {
  const bySource = new Map<string, NoteSegment[]>();
  for (const s of segments) {
    const list = bySource.get(s.sourceId) ?? [];
    list.push(s);
    bySource.set(s.sourceId, list);
  }
  for (const list of bySource.values()) list.sort((a, b) => a.start - b.start);
  const out: Block[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    const list = bySource.get(m.sourceId) ?? [];
    const i = list.findIndex((s) => s.start <= m.start && m.start < s.end);
    const seg = list[i];
    if (seg === undefined) continue;
    let block: Block | null = null;
    if (seg.label === 'problem_heading') {
      let end = seg.end;
      for (let j = i + 1; j < list.length; j += 1) {
        const next = list[j];
        if (next === undefined || !SOAP.includes(next.label)) break;
        end = next.end;
      }
      block = { sourceId: seg.sourceId, start: seg.start, end };
    } else if (SOAP.includes(seg.label)) block = { sourceId: seg.sourceId, start: seg.start, end: seg.end };
    if (block === null) continue;
    const key = `${block.sourceId}:${String(block.start)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out;
}

/** 範囲の中に書かれたもの（文の中の場所が、範囲の中にあるもの） */
export function withinBlocks<T extends { readonly sourceId: string; readonly start: number; readonly end: number }>(items: readonly T[], blocks: readonly Block[]): T[] {
  return items.filter((item) => blocks.some((b) => b.sourceId === item.sourceId && item.start >= b.start && item.end <= b.end));
}

export interface RelatedFacts<O, M, E> {
  /** 問題の記載の中に書かれた検査・バイタルの名前（書かれた順。同じ名前は1回） */
  readonly valueNames: readonly string[];
  readonly observations: readonly O[];
  /** 問題の記載の中に書かれた薬の名前（同じ名前は1回） */
  readonly medicationNames: readonly string[];
  readonly medications: readonly M[];
  readonly events: readonly E[];
}

/** 問題の記載の中に書かれた、値・薬・できごと（段3c。推し量らない：その問題の記載の範囲に書かれたものだけ） */
export function relatedFacts<
  O extends { readonly sourceId: string; readonly start: number; readonly end: number; readonly name: string | null; readonly nameRaw: string },
  M extends { readonly sourceId: string; readonly start: number; readonly end: number; readonly name: string },
  E extends { readonly sourceId: string; readonly start: number; readonly end: number },
>(mentions: readonly ThreadMention[], segments: readonly NoteSegment[], facts: { observations: readonly O[]; medications: readonly M[]; events: readonly E[] }): RelatedFacts<O, M, E> {
  const blocks = problemBlocks(mentions, segments);
  const observations = withinBlocks(facts.observations, blocks);
  const medications = withinBlocks(facts.medications, blocks);
  const valueNames: string[] = [];
  for (const o of observations) {
    const name = o.name ?? o.nameRaw;
    if (!valueNames.includes(name)) valueNames.push(name);
  }
  const medicationNames: string[] = [];
  const seen = new Set<string>();
  for (const m of medications) {
    const k = nameKey(m.name);
    if (seen.has(k)) continue;
    seen.add(k);
    medicationNames.push(m.name);
  }
  return { valueNames, observations, medicationNames, medications, events: withinBlocks(facts.events, blocks) };
}
