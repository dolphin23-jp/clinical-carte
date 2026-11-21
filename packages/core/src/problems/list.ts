// AI のプロブレムリスト（CA-057。2026-11-21 の本人の決定）：記録全体（問題の筋・経過の出来事・できごと・薬・検査）から、AI が #1… のリストを組み、
// 問題のタブと「いま」の主な見方にする。名前は AI が整えてよい（書かれた名前は、結びつけた筋として並べて出す）。「AI の整理」の印。本人は直せる。純関数。
//
// 確かめること（決定論）：
//  - 結びつけ（記録に書かれた問題の筋 T…・経過の出来事 C…）が実在する。どれにも結びつかない項目は出さない（記録に根のない問題を作らない）。数を返す
//  - 名前・根拠の文の、識別情報の形は伏せる。長さの上限
//  - 始まった日は、AI に書かせず、結びつけた筋の最初の記載・経過の出来事の日時から決める
// 組み直したとき、先生が直した項目（名前・確からしさ・状態・外した）は、同じ筋に結びつく新しい項目へ引き継ぐ。
import { z } from 'zod';

import { replaceShapes } from '../guard/shapes.ts';
import { COURSE_CATEGORY_NAMES, type CourseCategory, PROBLEM_STATUS_NAMES } from '../organize/answer.ts';
import { compareDateTime } from '../time/datetime.ts';
import type { ThreadView } from './threads.ts';

export const LIST_CERTAINTIES = ['diagnosis', 'suspected', 'problem'] as const;
export type ListCertainty = (typeof LIST_CERTAINTIES)[number];
export const LIST_CERTAINTY_NAMES: Readonly<Record<ListCertainty, string>> = { diagnosis: '診断', suspected: '疑い', problem: '問題' };

export const LIST_ACTIVITIES = ['active', 'resolved', 'inactive', 'ruled_out'] as const;
export type ListActivity = (typeof LIST_ACTIVITIES)[number];
export const LIST_ACTIVITY_NAMES: Readonly<Record<ListActivity, string>> = { active: '活動中', resolved: '解決', inactive: '非活動・既往', ruled_out: '否定的' };

export const LIST_NAME_MAX = 60;
export const LIST_BASIS_MAX = 300;
export const LIST_ITEMS_MAX = 30;

/** AI の答えの形 */
export const ProblemListAnswer = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      certainty: z.enum(LIST_CERTAINTIES),
      activity: z.enum(LIST_ACTIVITIES),
      /** 結びつける、記録に書かれた問題の筋（T1…） */
      threads: z.array(z.string()),
      /** 結びつける、経過の出来事（C1…）：症状・所見・検査・治療 */
      course: z.array(z.string()),
      /** 根拠の短い文（何から、そう整理したか） */
      basis: z.string(),
    }),
  ),
});
export type ProblemListAnswer = z.infer<typeof ProblemListAnswer>;

/** 経過の出来事を指す場所（整理し直すと id が変わるので、文の id と場所で持つ） */
export interface CoursePointer {
  readonly sourceId: string;
  readonly start: number;
}

export interface ListItem {
  /** 項目の印（組み直しても、先生の直しを引き継ぐための鍵。サーバーが付ける） */
  readonly key: string;
  readonly name: string;
  readonly certainty: ListCertainty;
  readonly activity: ListActivity;
  readonly threadIds: readonly string[];
  readonly course: readonly CoursePointer[];
  readonly basis: string;
  /** 始まった日（結びつけた筋・出来事のいちばん早い日時。AI に書かせない） */
  readonly since: string | null;
  /** 先生が直した欄（名前・確からしさ・状態） */
  readonly self: readonly ('name' | 'certainty' | 'activity')[];
  /** 先生が外した */
  readonly hidden: boolean;
}

export interface ListThread {
  readonly id: string;
  readonly name: string;
  readonly status: ThreadView['status'];
  readonly group: ThreadView['group'];
  readonly first: string | null;
  readonly last: string | null;
  /** いちばん新しい評価・方針の文（短く） */
  readonly lastNote: string;
}

export interface ListCourse {
  readonly sourceId: string;
  readonly start: number;
  readonly at: string | null;
  readonly atApprox: string | null;
  readonly category: CourseCategory;
  readonly summary: string;
}

export interface ListMaterialInput {
  readonly patient: { readonly age: number; readonly sex: string };
  readonly threads: readonly ListThread[];
  readonly course: readonly ListCourse[];
  readonly events: readonly { readonly at: string | null; readonly kind: string; readonly title: string }[];
  readonly medications: readonly { readonly name: string; readonly last: string }[];
  readonly labs: readonly { readonly name: string; readonly values: string }[];
  /** 前のリスト（あれば。名前と結びつけだけを、参考として渡す） */
  readonly previous: readonly ListItem[];
}

export interface ListMaterial {
  readonly message: string;
  readonly threadRefs: ReadonlyMap<string, ListThread>;
  readonly courseRefs: ReadonlyMap<string, ListCourse>;
}

/** 1回の資料に入れる経過の出来事の数（新しいものから） */
export const LIST_COURSE_MAX = 150;

export function listMaterial(input: ListMaterialInput): ListMaterial {
  const threadRefs = new Map(input.threads.map((t, i) => [`T${String(i + 1)}`, t]));
  const course = [...input.course].sort((a, b) => compareDateTime(a.at, b.at)).slice(-LIST_COURSE_MAX);
  const courseRefs = new Map(course.map((c, i) => [`C${String(i + 1)}`, c]));
  const refOfThread = new Map([...threadRefs].map(([ref, t]) => [t.id, ref]));
  const message = JSON.stringify({
    patient: input.patient,
    threads: [...threadRefs].map(([ref, t]) => ({
      ref,
      name: t.name,
      written: PROBLEM_STATUS_NAMES[t.status],
      group: t.group === 'current' ? 'いまの問題' : t.group === 'closed' ? '解決・非活動と書かれた' : '否定的と書かれた',
      first: t.first,
      last: t.last,
      lastNote: t.lastNote,
    })),
    course: [...courseRefs].map(([ref, c]) => ({ ref, at: c.at, approx: c.atApprox, category: COURSE_CATEGORY_NAMES[c.category], summary: c.summary })),
    events: input.events.slice(-80),
    medications: input.medications,
    labs: input.labs,
    previous: input.previous
      .filter((p) => !p.hidden)
      .map((p) => ({ name: p.name, threads: p.threadIds.map((id) => refOfThread.get(id)).filter((r): r is string => r !== undefined) })),
  });
  return { message, threadRefs, courseRefs };
}

export const LIST_REJECT_REASONS = ['ungrounded', 'empty_name', 'duplicate', 'too_many'] as const;
export type ListRejectReason = (typeof LIST_REJECT_REASONS)[number];
export const LIST_REJECT_NAMES: Readonly<Record<ListRejectReason, string>> = {
  ungrounded: '記録の問題・経過のどれにも結びつかなかった',
  empty_name: '名前がなかった',
  duplicate: '同じ名前が重なった',
  too_many: '多すぎた',
};

export interface CheckedList {
  readonly items: readonly Omit<ListItem, 'key' | 'self' | 'hidden'>[];
  readonly rejected: Partial<Record<ListRejectReason, number>>;
  /** 伏せた識別情報の形の数 */
  readonly shapes: number;
}

export function checkProblemList(answer: ProblemListAnswer, material: ListMaterial): CheckedList {
  const rejected: Partial<Record<ListRejectReason, number>> = {};
  const count = (r: ListRejectReason): void => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  let shapes = 0;
  const clean = (text: string, max: number): string => {
    const r = replaceShapes(text.replace(/\s+/gu, ' ').trim());
    shapes += Object.values(r.counts).reduce((n, c) => n + c, 0);
    return r.text.slice(0, max);
  };
  const out: Omit<ListItem, 'key' | 'self' | 'hidden'>[] = [];
  const names = new Set<string>();
  for (const a of answer.items) {
    if (out.length >= LIST_ITEMS_MAX) {
      count('too_many');
      continue;
    }
    const name = clean(a.name, LIST_NAME_MAX);
    if (name === '') {
      count('empty_name');
      continue;
    }
    const threads = [...new Set(a.threads)].map((r) => material.threadRefs.get(r)).filter((t): t is ListThread => t !== undefined);
    const course = [...new Set(a.course)].map((r) => material.courseRefs.get(r)).filter((c): c is ListCourse => c !== undefined);
    if (threads.length === 0 && course.length === 0) {
      count('ungrounded');
      continue;
    }
    if (names.has(name)) {
      count('duplicate');
      continue;
    }
    names.add(name);
    const dates = [...threads.map((t) => t.first), ...course.map((c) => c.at)].filter((d): d is string => d !== null).sort(compareDateTime);
    out.push({
      name,
      certainty: a.certainty,
      activity: a.activity,
      threadIds: threads.map((t) => t.id),
      course: course.map((c) => ({ sourceId: c.sourceId, start: c.start })),
      basis: clean(a.basis, LIST_BASIS_MAX),
      since: dates[0] ?? null,
    });
  }
  return { items: out, rejected, shapes };
}

/**
 * 組み直したリストに、前のリストの先生の直しを引き継ぐ：同じ筋に結びつく（なければ、同じ名前の）前の項目の、先生が直した欄と「外した」。
 * key も引き継ぐ（なければ newKey で付ける）
 */
export function carryListEdits(items: CheckedList['items'], previous: readonly ListItem[], newKey: () => string): ListItem[] {
  const used = new Set<string>();
  return items.map((item) => {
    const prev =
      previous.find((p) => !used.has(p.key) && p.threadIds.some((id) => item.threadIds.includes(id))) ?? previous.find((p) => !used.has(p.key) && p.name === item.name);
    if (prev === undefined) return { ...item, key: newKey(), self: [], hidden: false };
    used.add(prev.key);
    return {
      ...item,
      key: prev.key,
      name: prev.self.includes('name') ? prev.name : item.name,
      certainty: prev.self.includes('certainty') ? prev.certainty : item.certainty,
      activity: prev.self.includes('activity') ? prev.activity : item.activity,
      self: prev.self,
      hidden: prev.hidden,
    };
  });
}

/** リストの元になった記録の印（記録が増えた・整理し直したら変わる。組み直すかを決めるため） */
export function listBasis(sources: readonly { readonly id: string; readonly organized: string | null; readonly organizedVersion?: string | null }[]): string {
  const done = sources.filter((s) => s.organized === 'done');
  const last = [...sources.map((s) => s.id)].sort().at(-1) ?? '';
  return `${String(sources.length)}:${String(done.length)}:${last}`;
}

/** 先生の直し（名前は、サーバーが選別を通してから） */
export const ListPatch = z.union([
  z.strictObject({ key: z.string().min(1).max(40), name: z.string().min(1).max(LIST_NAME_MAX) }),
  z.strictObject({ key: z.string().min(1).max(40), certainty: z.enum(LIST_CERTAINTIES) }),
  z.strictObject({ key: z.string().min(1).max(40), activity: z.enum(LIST_ACTIVITIES) }),
  z.strictObject({ key: z.string().min(1).max(40), hidden: z.boolean() }),
  z.strictObject({ key: z.string().min(1).max(40), move: z.enum(['up', 'down']) }),
]);
export type ListPatch = z.infer<typeof ListPatch>;

/** 直しを当てる（純関数）。名前は、選別を通した後の字を渡す */
export function applyListPatch(items: readonly ListItem[], patch: ListPatch): ListItem[] | null {
  const i = items.findIndex((x) => x.key === patch.key);
  const item = items[i];
  if (item === undefined) return null;
  const mark = (field: 'name' | 'certainty' | 'activity'): ListItem['self'] => (item.self.includes(field) ? item.self : [...item.self, field]);
  const next = [...items];
  if ('name' in patch) next[i] = { ...item, name: patch.name, self: mark('name') };
  else if ('certainty' in patch) next[i] = { ...item, certainty: patch.certainty, self: mark('certainty') };
  else if ('activity' in patch) next[i] = { ...item, activity: patch.activity, self: mark('activity') };
  else if ('hidden' in patch) next[i] = { ...item, hidden: patch.hidden };
  else {
    const j = patch.move === 'up' ? i - 1 : i + 1;
    const other = next[j];
    if (other === undefined) return next;
    next[j] = item;
    next[i] = other;
  }
  return next;
}

/** 保存した形を読む（読めない項目は捨てる） */
export const ListItemShape = z.object({
  key: z.string(),
  name: z.string(),
  certainty: z.enum(LIST_CERTAINTIES),
  activity: z.enum(LIST_ACTIVITIES),
  threadIds: z.array(z.string()),
  course: z.array(z.object({ sourceId: z.string(), start: z.number() })),
  basis: z.string(),
  since: z.string().nullable(),
  self: z.array(z.enum(['name', 'certainty', 'activity'])),
  hidden: z.boolean(),
});
