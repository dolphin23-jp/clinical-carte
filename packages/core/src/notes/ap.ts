// 段5：A/P（評価と方針）の記録（CA-030〜035）と、根拠の参照・出典の形。純関数。
//
// - A/P（ap_notes）は、前の版の画面で、問題ごとに残したもの。段I（CA-054）からは、カルテ記載（notes/document.ts）を出して直して残す。
//   残した A/P は、読む・消す・直すことができ、カルテ記載の資料に入る。
// - 参照（ApRef）は、場所・題・頁・URL だけ。書籍・ページの本文は保存しない（CA-031・CA-035）。カルテ記載の根拠も同じ形。
import { z } from 'zod';

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
