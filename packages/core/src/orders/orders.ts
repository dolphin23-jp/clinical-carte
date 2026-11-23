// 段K11：指示簿（CA-074〜CA-079。2026-11-23 の本人の決定）。受診ごとに1つの指示簿を、欄ごとの項目で持つ。
// - 2つの入れ方：(a) 写す（記録の文に書いた指示を、AI が欄ごとに分け、先生が確かめて入れる。字は保存した文のまま）、
//   (b) 組み立てる（先生が打つ・テンプレから入れる・AI の案から1つずつ採用する）
// - **病院のカルテへ戻す向き（コピーのボタン）は作らない**（CA-001・CA-033 のまま。先生が病院のカルテに打ち直す）
// - 点滴は、ほかの欄と分けて持つ（輸液・持続投与〔スケールのテンプレを選べる〕・抗菌薬など。薬・量・速度・開始・予定の終わり）
// - 書かれていないことを補わない：空の欄は空のまま（開始・終わりの日時は、先生が入れたときだけ）
//
// 純関数（DOM・保存・通信・時計・乱数に触れない）。日時・id は呼ぶ側が渡す。
import { z } from 'zod';

import { DateTime } from '../record/schema.ts';
import { compareDateTime } from '../time/datetime.ts';
import { ScaleTemplateBody } from './scale.ts';

// ---------------------------------------------------------------------------
// 欄（本人の決めた並び。CA-077）

export const ORDER_CATEGORIES = ['rest', 'diet', 'respiratory', 'monitor', 'test', 'call', 'prn', 'oral', 'infusion', 'other'] as const;
export type OrderCategory = (typeof ORDER_CATEGORIES)[number];
export const ORDER_CATEGORY_NAMES: Readonly<Record<OrderCategory, string>> = {
  rest: '安静度',
  diet: '食事',
  respiratory: '酸素・呼吸器（NPPV・人工呼吸の設定を含む）',
  monitor: 'モニター・バイタル測定',
  test: '検査（採血・血液ガス・血糖測定などの予定と間隔）',
  call: '医師コール基準',
  prn: '頓用（不穏時・疼痛時・発熱時など、条件→対応）',
  oral: '内服（継続・中止・休薬・新規）',
  infusion: '点滴（輸液・持続投与・抗菌薬など）',
  other: 'その他（どの欄にも入らない指示）',
};
/** 札に出す短い名前 */
export const ORDER_CATEGORY_SHORT: Readonly<Record<OrderCategory, string>> = {
  rest: '安静度',
  diet: '食事',
  respiratory: '酸素・呼吸器',
  monitor: 'モニター・測定',
  test: '検査',
  call: 'コール基準',
  prn: '頓用',
  oral: '内服',
  infusion: '点滴',
  other: 'その他',
};
/** 点滴の欄は、ほかの欄と分けて出す */
export const SHEET_CATEGORIES: readonly OrderCategory[] = ORDER_CATEGORIES.filter((c) => c !== 'infusion');

/** 内服などの動き（書かれていなければ none） */
export const ORDER_ACTIONS = ['none', 'new', 'continue', 'change', 'hold', 'stop'] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];
export const ORDER_ACTION_NAMES: Readonly<Record<OrderAction, string>> = { none: '動きの記載なし', new: '新規', continue: '継続', change: '変更', hold: '休薬', stop: '中止' };

/** 誰が入れたか：先生が打った・AI の案を採用した・記録の文から写した（edited は、入れた後に先生が直したか） */
export const ORDER_ORIGINS = ['self', 'ai', 'transcribed'] as const;
export type OrderOrigin = (typeof ORDER_ORIGINS)[number];
export const ORDER_ORIGIN_NAMES: Readonly<Record<OrderOrigin, string>> = { self: '先生が入れた', ai: 'AI の案', transcribed: '記録の文から写した' };

export const ORDER_STATUSES = ['active', 'stopped'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_STATUS_NAMES: Readonly<Record<OrderStatus, string>> = { active: '指示中', stopped: '中止した' };

/** 字の欄（指示の文と、薬・量・速度などの分けた欄）。どれも書かれたとおり（補わない） */
export const ORDER_TEXT_FIELDS = ['text', 'condition', 'drug', 'dose', 'rate', 'interval', 'duration'] as const;
export type OrderTextField = (typeof ORDER_TEXT_FIELDS)[number];
export const ORDER_FIELD_NAMES: Readonly<Record<OrderTextField, string>> = {
  text: '指示',
  condition: '条件',
  drug: '薬',
  dose: '量',
  rate: '速度',
  interval: '間隔・回数',
  duration: '期間',
};

export const ORDER_TEXT_MAX = 400;
export const ORDER_FIELD_MAX = 120;
/** 1つの指示簿の項目の数の上限 */
export const ORDER_ITEMS_MAX = 200;
/** 1回に足す数 */
export const ORDER_ADD_MAX = 40;
/** 根拠（AI の案）の数と、1つの名前の長さ */
export const ORDER_BASIS_MAX = 8;
export const ORDER_BASIS_LABEL_MAX = 160;
/** 1つの項目に残す、直した記録の数 */
export const ORDER_HISTORY_MAX = 50;

// ---------------------------------------------------------------------------
// 形

/** 記録の中の場所（写した項目の、元の字） */
export const OrderPointer = z.strictObject({ sourceId: z.string().min(1).max(40), start: z.number().int().min(0), end: z.number().int().min(0) });
export type OrderPointer = z.infer<typeof OrderPointer>;

/** 根拠（AI の案。記号は組み直すと変わるので、画面に出す短い名前で残す） */
export const OrderBasis = z.strictObject({ id: z.string().max(10), label: z.string().max(ORDER_BASIS_LABEL_MAX) });
export type OrderBasis = z.infer<typeof OrderBasis>;

/** スケールのテンプレを使う点滴：入れたときのテンプレの中身（あとでテンプレを直しても、この指示は変わらない）と、先生が入れた体重・いまの段 */
export const ScaleUse = z.strictObject({
  templateId: z.string().max(40),
  template: ScaleTemplateBody,
  weightKg: z.number().positive().max(500).nullable(),
  step: z.number().int().min(0).max(100).nullable(),
});
export type ScaleUse = z.infer<typeof ScaleUse>;

const textField = (max: number) => z.string().max(max);

/** 先生が入れる・直す欄（字は、サーバーで選別を通す。写した字そのままの欄は通さない。CA-079） */
export const OrderFields = z.strictObject({
  category: z.enum(ORDER_CATEGORIES),
  text: z.string().trim().min(1).max(ORDER_TEXT_MAX),
  condition: textField(ORDER_FIELD_MAX),
  drug: textField(ORDER_FIELD_MAX),
  dose: textField(ORDER_FIELD_MAX),
  rate: textField(ORDER_FIELD_MAX),
  interval: textField(ORDER_FIELD_MAX),
  duration: textField(ORDER_FIELD_MAX),
  action: z.enum(ORDER_ACTIONS),
  /** 開始・予定の終わり（先生が入れたときだけ。書かれていなければ null。推し量らない） */
  start: DateTime.nullable(),
  end: DateTime.nullable(),
  scale: ScaleUse.nullable(),
});
export type OrderFields = z.infer<typeof OrderFields>;

/** 資料に見つからない数（AI の案。※の印。数字だけ） */
const UnseenNumber = z.string().regex(/^\d+(?:\.\d+)?$/u).max(20);

/** 足す項目 */
export const OrderNew = OrderFields.extend({
  origin: z.enum(ORDER_ORIGINS),
  /** 写した項目の、元の字の場所（写したときだけ） */
  from: OrderPointer.nullable(),
  basis: z.array(OrderBasis).max(ORDER_BASIS_MAX),
  unseen: z.array(UnseenNumber).max(40),
});
export type OrderNew = z.infer<typeof OrderNew>;

export const OrderAdd = z.strictObject({ items: z.array(OrderNew).min(1).max(ORDER_ADD_MAX) });
export type OrderAdd = z.infer<typeof OrderAdd>;

/** 直す：欄を直す・中止する／再開する・スケールの体重といまの段を選ぶ（数だけ。字はない） */
export const OrderPatch = z.union([
  z.strictObject({ fields: OrderFields }),
  z.strictObject({ status: z.enum(ORDER_STATUSES) }),
  z.strictObject({ weightKg: z.number().positive().max(500).nullable(), step: z.number().int().min(0).max(100).nullable() }),
]);
export type OrderPatch = z.infer<typeof OrderPatch>;

export const ORDER_HISTORY_ACTIONS = ['add', 'edit', 'stop', 'restart', 'scale'] as const;
export type OrderHistoryAction = (typeof ORDER_HISTORY_ACTIONS)[number];
export const ORDER_HISTORY_NAMES: Readonly<Record<OrderHistoryAction, string>> = { add: '入れた', edit: '直した', stop: '中止した', restart: '再開した', scale: '体重・段を選んだ' };

/** 保存した項目 */
export const OrderItem = z.object({
  id: z.string(),
  category: z.enum(ORDER_CATEGORIES),
  text: z.string(),
  condition: z.string(),
  drug: z.string(),
  dose: z.string(),
  rate: z.string(),
  interval: z.string(),
  duration: z.string(),
  action: z.enum(ORDER_ACTIONS),
  start: z.string().nullable(),
  end: z.string().nullable(),
  scale: ScaleUse.nullable(),
  origin: z.enum(ORDER_ORIGINS),
  /** 入れた後に、先生が欄を直したか */
  edited: z.boolean(),
  from: OrderPointer.nullable(),
  basis: z.array(OrderBasis),
  unseen: z.array(z.string()),
  status: z.enum(ORDER_STATUSES),
  addedAt: z.string(),
  updatedAt: z.string(),
  stoppedAt: z.string().nullable(),
  history: z.array(z.object({ at: z.string(), action: z.enum(ORDER_HISTORY_ACTIONS) })),
});
export type OrderItem = z.infer<typeof OrderItem>;

export const OrderItems = z.array(OrderItem);

// ---------------------------------------------------------------------------
// 確かめ（画面とサーバーが同じ関数を使う）

export const ORDER_FIELD_PROBLEMS = ['end_before_start', 'scale_category', 'transcribed_without_source', 'pointer'] as const;
export type OrderFieldProblem = (typeof ORDER_FIELD_PROBLEMS)[number];

/** 欄の確かめ：終わりが開始より前・点滴でないのにスケール。null なら通る */
export function orderFieldsProblem(fields: OrderFields): OrderFieldProblem | null {
  if (fields.start !== null && fields.end !== null && compareDateTime(fields.end, fields.start) < 0) return 'end_before_start';
  if (fields.scale !== null && fields.category !== 'infusion') return 'scale_category';
  return null;
}

/** 足す項目の確かめ：写した項目には元の字の場所が要る（場所が字の中か、は呼ぶ側が文で確かめる） */
export function orderNewProblem(item: OrderNew): OrderFieldProblem | null {
  const p = orderFieldsProblem(item);
  if (p !== null) return p;
  if (item.origin === 'transcribed' && item.from === null) return 'transcribed_without_source';
  if (item.from !== null && item.from.end <= item.from.start) return 'pointer';
  return null;
}

/** 字の欄のうち、元の字（写した記載のその場所の字）にそのままあるもの。そのままの欄は、選別を通さない（保存した字のまま。CA-079） */
export function verbatimFields(fields: Pick<OrderFields, OrderTextField>, span: string | null): Set<OrderTextField> {
  const out = new Set<OrderTextField>();
  if (span === null) return out;
  for (const f of ORDER_TEXT_FIELDS) {
    const v = fields[f];
    if (v === '' || span.includes(v)) out.add(f);
  }
  return out;
}

/** 欄が同じか（字・動き・日時・スケール） */
export function sameFields(a: OrderFields, b: OrderFields): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 項目の欄だけ */
export function fieldsOf(item: OrderItem): OrderFields {
  return {
    category: item.category,
    text: item.text,
    condition: item.condition,
    drug: item.drug,
    dose: item.dose,
    rate: item.rate,
    interval: item.interval,
    duration: item.duration,
    action: item.action,
    start: item.start,
    end: item.end,
    scale: item.scale,
  };
}

/** 直した記録を足す（古いものから落とす） */
export function withHistory(item: OrderItem, at: string, action: OrderHistoryAction): OrderItem['history'] {
  return [...item.history, { at, action }].slice(-ORDER_HISTORY_MAX);
}

/** 新しい項目（保存する形）。字は、呼ぶ側が選別を通した後のもの */
export function newOrderItem(id: string, input: OrderNew, now: string): OrderItem {
  return {
    id,
    category: input.category,
    text: input.text,
    condition: input.condition,
    drug: input.drug,
    dose: input.dose,
    rate: input.rate,
    interval: input.interval,
    duration: input.duration,
    action: input.action,
    start: input.start,
    end: input.end,
    scale: input.scale,
    origin: input.origin,
    edited: false,
    from: input.from,
    basis: input.basis,
    unseen: input.origin === 'ai' ? [...new Set(input.unseen)] : [],
    status: 'active',
    addedAt: now,
    updatedAt: now,
    stoppedAt: null,
    history: [{ at: now, action: 'add' }],
  };
}

/** 欄を直す（字は選別の後）。AI の数の印（※）は、直した後の字に残る数だけ残す */
export function editOrderItem(item: OrderItem, fields: OrderFields, now: string, numbersIn: (text: string) => readonly string[]): OrderItem {
  const kept = new Set(ORDER_TEXT_FIELDS.flatMap((f) => numbersIn(fields[f])));
  return {
    ...item,
    ...fields,
    edited: item.edited || !sameFields(fieldsOf(item), fields),
    unseen: item.unseen.filter((n) => kept.has(n)),
    updatedAt: now,
    history: withHistory(item, now, 'edit'),
  };
}

/** 中止する・再開する（中止の日時は、押したとき。再開すると消える） */
export function setOrderStatus(item: OrderItem, status: OrderStatus, now: string): OrderItem {
  if (item.status === status) return item;
  return { ...item, status, stoppedAt: status === 'stopped' ? now : null, updatedAt: now, history: withHistory(item, now, status === 'stopped' ? 'stop' : 'restart') };
}

/** スケールの体重といまの段（スケールのない項目には付けない。段はテンプレの段の数の中） */
export function setOrderScale(item: OrderItem, weightKg: number | null, step: number | null, now: string): OrderItem | null {
  if (item.scale === null) return null;
  if (step !== null && step >= item.scale.template.steps.length) return null;
  return { ...item, scale: { ...item.scale, weightKg, step }, updatedAt: now, history: withHistory(item, now, 'scale') };
}

/** 欄ごとに並べる（欄の順、その中は入れた順。中止したものは後ろ） */
export function itemsByCategory(items: readonly OrderItem[]): { readonly category: OrderCategory; readonly items: readonly OrderItem[] }[] {
  return ORDER_CATEGORIES.map((category) => ({
    category,
    items: items
      .filter((i) => i.category === category)
      .sort((a, b) => (a.status === b.status ? a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id) : a.status === 'active' ? -1 : 1)),
  })).filter((g) => g.items.length > 0);
}

/** 項目の短い名前（札・経過表に出す）：薬の欄があれば薬、なければ指示の文の頭 */
export function orderLabel(item: Pick<OrderItem, 'drug' | 'text'>): string {
  const name = item.drug.trim() !== '' ? item.drug.trim() : item.text.trim();
  return name.length > 30 ? `${name.slice(0, 30)}…` : name;
}

// ---------------------------------------------------------------------------
// 頼みの形

/** 記録の文から写す（その受診の記載を1つ選ぶ） */
export const OrderTranscribeRequest = z.strictObject({ sourceId: z.string().min(1).max(40) });
export type OrderTranscribeRequest = z.infer<typeof OrderTranscribeRequest>;

/** AI の案を出す（頼む欄。空なら、すべての欄） */
export const OrderProposeRequest = z.strictObject({ categories: z.array(z.enum(ORDER_CATEGORIES)).max(ORDER_CATEGORIES.length) });
export type OrderProposeRequest = z.infer<typeof OrderProposeRequest>;
