// 段K11：指示簿の AI（CA-074・CA-076）。2つの頼み：
// (a) 写す（transcribe）：保存した記載（識別情報を置き換えた後の字）の中の指示を、AI が欄ごとに分けて、**引用で指す**。
//     項目の字は、記録の字そのもの（AI は文を書かない）。薬・量・速度などの欄も、その引用の中の字だけ（引用の外の字は空にして数える）。
//     引用が記録の字に見つからないものは出さない（決定論の確かめ。checkTranscribe）
// (b) 案を出す（propose）：記録・AI のプロブレムリスト・AI の臨床支援（段K5）・先生のテンプレから、欄ごとの指示の案を AI が書く。
//     **用量を含めてよい**（CA-059 の「資料と出典にない用量・閾値・目標値を書かせない」の、指示簿の案に限った改訂。CA-076）。
//     ほかの守りは残す：資料・テンプレ・出典に見つからない数には印（※。markNumbers）を付けて消さない。すべて「AI の案」の印。
//     先生が1つずつ採用したものだけが指示簿に入る（採用までは画面のメモリだけ）。識別情報の形は伏せる。
//     **スケールの流量は AI に計算させない**（テンプレを指した案の速度の欄は空にして数える。流量は carte が計算する）
//
// 純関数（DOM・保存・通信・時計・乱数に触れない）。
import { z } from 'zod';

import { replaceShapes } from '../guard/shapes.ts';
import { type Backing, backingFrom, markNumbers, type NumberMark } from '../notes/document.ts';
import { SOURCE_KIND_LABELS, type SourceKind } from '../record/schema.ts';
import type { SupportBody, SupportMaterial } from '../support/support.ts';
import {
  ORDER_ACTIONS,
  ORDER_ACTION_NAMES,
  ORDER_BASIS_LABEL_MAX,
  ORDER_BASIS_MAX,
  ORDER_CATEGORIES,
  ORDER_CATEGORY_NAMES,
  ORDER_CATEGORY_SHORT,
  ORDER_FIELD_MAX,
  ORDER_STATUS_NAMES,
  ORDER_TEXT_FIELDS,
  ORDER_TEXT_MAX,
  type OrderAction,
  type OrderBasis,
  type OrderCategory,
  type OrderItem,
  type OrderOrigin,
  type OrderPointer,
  type OrderTextField,
  type ScaleUse,
} from './orders.ts';
import { concentrationText, numberText, type ScaleTemplate } from './scale.ts';

// ---------------------------------------------------------------------------
// 数の印（画面とサーバーが同じ関数を使う）

const fold = (text: string): string => text.replace(/[０-９]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/．/gu, '.');

/** 字の中の数のうち、資料に見つからないもの（そろえた数の字。markNumbers と同じ見方） */
export function unseenNumbers(text: string, backing: Backing): string[] {
  const folded = fold(text);
  return [...new Set(markNumbers(text, backing).map((m) => String(Number(folded.slice(m.start, m.end)))))];
}

/** 保存した AI の案の字に、※の印を付ける場所（資料に見つからなかった数〔unseen〕と同じ数の場所） */
export function unseenMarks(text: string, unseen: readonly string[]): NumberMark[] {
  if (unseen.length === 0) return [];
  const set = new Set(unseen);
  const folded = fold(text);
  return markNumbers(text, { body: [], when: [] }).filter((m) => set.has(String(Number(folded.slice(m.start, m.end)))));
}

/** 字の中の数（そろえた字）。直した後に残る印を決めるのに使う */
export function orderNumbersIn(text: string): string[] {
  return unseenNumbers(text, { body: [], when: [] });
}

/** 案（画面のメモリだけ。採用するまで指示簿に入らない） */
export interface OrderProposal {
  readonly key: string;
  readonly category: OrderCategory;
  readonly text: string;
  readonly condition: string;
  readonly drug: string;
  readonly dose: string;
  readonly rate: string;
  readonly interval: string;
  readonly duration: string;
  readonly action: OrderAction;
  readonly scale: ScaleUse | null;
  readonly origin: Extract<OrderOrigin, 'ai' | 'transcribed'>;
  readonly from: OrderPointer | null;
  readonly basis: readonly OrderBasis[];
  readonly unseen: readonly string[];
}

const showAt = (at: string | null): string => (at === null ? '日時不明' : at.replace('T', ' '));
export const ORDER_CATEGORY_LIST = ORDER_CATEGORIES.map((c) => `${c}（${ORDER_CATEGORY_NAMES[c]}）`).join('・');
export const ORDER_ACTION_LIST = ORDER_ACTIONS.map((a) => `${a}（${ORDER_ACTION_NAMES[a]}）`).join('・');

// ---------------------------------------------------------------------------
// (a) 写す

export const TRANSCRIBE_CATEGORIES = [...ORDER_CATEGORIES, 'not_an_order'] as const;
export type TranscribeCategory = (typeof TRANSCRIBE_CATEGORIES)[number];

/** AI の答え（引用だけ。null になりうる欄・必須でない欄は 0：書かれていない欄は ""） */
export const TranscribeAnswer = z.object({
  items: z.array(
    z.object({
      category: z.enum(TRANSCRIBE_CATEGORIES),
      /** その指示の字（記録の字そのまま） */
      quote: z.string(),
      condition: z.string(),
      drug: z.string(),
      dose: z.string(),
      rate: z.string(),
      interval: z.string(),
      duration: z.string(),
      action: z.enum(ORDER_ACTIONS),
    }),
  ),
});
export type TranscribeAnswer = z.infer<typeof TranscribeAnswer>;

/** 写す記載（保存した字。識別情報を置き換えた後） */
export interface TranscribeSource {
  readonly id: string;
  readonly kind: SourceKind;
  readonly at: string | null;
  readonly text: string;
}

/** 写す1回に出す項目の数の上限 */
export const TRANSCRIBE_ITEMS_MAX = 60;

/** AI に送る資料（その記載の字だけ） */
export function transcribeMessage(source: TranscribeSource): string {
  return JSON.stringify({ source: { kind: SOURCE_KIND_LABELS[source.kind], at: showAt(source.at), text: source.text } });
}

export const TRANSCRIBE_REJECT_REASONS = ['quote_not_found', 'duplicate', 'too_long', 'empty', 'too_many'] as const;
export type TranscribeRejectReason = (typeof TRANSCRIBE_REJECT_REASONS)[number];
export const TRANSCRIBE_REJECT_NAMES: Readonly<Record<TranscribeRejectReason, string>> = {
  quote_not_found: '引用が記録の字に見つからなかった',
  duplicate: '同じ字の項目が重なった',
  too_long: '引用が長すぎた',
  empty: '引用が空だった',
  too_many: '項目が多すぎた',
};

export interface CheckedTranscribe {
  readonly proposals: readonly OrderProposal[];
  /** 「指示ではない」と分けた数 */
  readonly notOrder: number;
  readonly rejected: Partial<Record<TranscribeRejectReason, number>>;
  /** 引用の外の字だったので空にした欄の数 */
  readonly cleared: number;
}

/** 写す答えを確かめる：引用が記録の字にあること（決定論）。欄は引用の中の字だけ。項目の字は記録の字そのもの */
export function checkTranscribe(answer: TranscribeAnswer, source: TranscribeSource): CheckedTranscribe {
  const rejected: Partial<Record<TranscribeRejectReason, number>> = {};
  const count = (r: TranscribeRejectReason): void => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  const used = new Set<number>();
  const proposals: OrderProposal[] = [];
  let notOrder = 0;
  let cleared = 0;
  let cursor = 0;
  for (const a of answer.items) {
    if (a.category === 'not_an_order') {
      notOrder += 1;
      continue;
    }
    if (proposals.length >= TRANSCRIBE_ITEMS_MAX) {
      count('too_many');
      continue;
    }
    const quote = a.quote.trim();
    if (quote === '') {
      count('empty');
      continue;
    }
    if (quote.length > ORDER_TEXT_MAX) {
      count('too_long');
      continue;
    }
    // 前の項目の後ろから探し、なければ頭から。同じ場所は2回使わない（同じ字が2か所にあれば、次の場所）
    const find = (from: number): number => {
      let at = source.text.indexOf(quote, from);
      while (at >= 0 && used.has(at)) at = source.text.indexOf(quote, at + 1);
      return at;
    };
    let start = find(cursor);
    if (start < 0) start = find(0);
    if (start < 0) {
      count(source.text.includes(quote) ? 'duplicate' : 'quote_not_found');
      continue;
    }
    used.add(start);
    const end = start + quote.length;
    cursor = end;
    const text = source.text.slice(start, end);
    const field = (value: string): string => {
      const v = value.trim();
      if (v === '') return '';
      if (v.length <= ORDER_FIELD_MAX && text.includes(v)) return v;
      cleared += 1;
      return '';
    };
    proposals.push({
      key: `t${String(start)}`,
      category: a.category,
      text,
      condition: field(a.condition),
      drug: field(a.drug),
      dose: field(a.dose),
      rate: field(a.rate),
      interval: field(a.interval),
      duration: field(a.duration),
      action: a.action,
      scale: null,
      origin: 'transcribed',
      from: { sourceId: source.id, start, end },
      basis: [],
      unseen: [],
    });
  }
  proposals.sort((x, y) => (x.from?.start ?? 0) - (y.from?.start ?? 0));
  return { proposals, notOrder, rejected, cleared };
}

// ---------------------------------------------------------------------------
// (b) 案を出す

/** AI の答え（null になりうる欄・必須でない欄は 0：書かない欄は ""・テンプレを使わなければ ""・根拠は記号の列） */
export const ProposeAnswer = z.object({
  items: z.array(
    z.object({
      category: z.enum(ORDER_CATEGORIES),
      text: z.string(),
      condition: z.string(),
      drug: z.string(),
      dose: z.string(),
      rate: z.string(),
      interval: z.string(),
      duration: z.string(),
      action: z.enum(ORDER_ACTIONS),
      /** 使ったテンプレの記号（X…）。使わなければ "" */
      template: z.string(),
      /** 根拠の記号（資料の P・T・C・V・M・D・S・K・X・O） */
      basis: z.array(z.string()),
    }),
  ),
});
export type ProposeAnswer = z.infer<typeof ProposeAnswer>;

/** 案の数の上限（1回） */
export const PROPOSE_ITEMS_MAX = 40;
/** 資料に入れる、臨床支援の項目・テンプレ・いまの指示の数 */
export const PROPOSE_FINDINGS_MAX = 60;
export const PROPOSE_TEMPLATES_MAX = 30;
export const PROPOSE_ORDERS_MAX = 120;

export interface ProposeInput {
  /** 記録から作った資料（臨床支援と同じ：年齢・性別・受診・プロブレムリスト P…・筋 T…・経過 C…・値 V…・薬 M…・デバイス D…・スコア S…） */
  readonly support: SupportMaterial;
  /** AI の臨床支援（段K5。確かめた後のもの。まだなければ null） */
  readonly findings: SupportBody | null;
  /** 先生のテンプレ（外したものを除く） */
  readonly templates: readonly ScaleTemplate[];
  /** いまの指示簿の項目 */
  readonly orders: readonly OrderItem[];
  /** 案を頼む欄（空なら、すべて） */
  readonly categories: readonly OrderCategory[];
}

export interface ProposeMaterial {
  readonly payload: Record<string, unknown>;
  /** 根拠に使える記号と、画面に出す短い名前 */
  readonly refs: ReadonlyMap<string, string>;
  readonly templates: ReadonlyMap<string, ScaleTemplate>;
  /** 印（※）の照らし合わせ：記録・テンプレ・臨床支援・いまの指示の数 */
  readonly backing: Backing;
  /** いまの指示中の項目（同じ欄・同じ字の案は出さない） */
  readonly active: ReadonlySet<string>;
  readonly categories: readonly OrderCategory[];
}

const sameKey = (category: string, text: string): string => `${category}|${text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()}`;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function proposeMaterial(input: ProposeInput): ProposeMaterial {
  const base = input.support.payload;
  const refs = new Map<string, string>(input.support.refs);
  const problems = Array.isArray(base['problems']) ? (base['problems'] as { ref: string; name: string }[]) : [];
  for (const p of problems) refs.set(p.ref, `プロブレムリスト ${p.ref.replace('P', '#')} ${p.name}`);

  // 臨床支援（段K5）：問題ごとの、確かめる検査・照合・疑う疾患（確かめた後の字。出典は題だけ）
  const findings: { ref: string; problem: string; kind: string; name: string; text: string }[] = [];
  for (const p of input.findings?.problems ?? []) {
    const problem = `#${String(p.no)} ${p.name}`;
    const add = (kind: string, name: string, text: string): void => {
      if (findings.length >= PROPOSE_FINDINGS_MAX) return;
      const ref = `K${String(findings.length + 1)}`;
      findings.push({ ref, problem, kind, name, text });
      refs.set(ref, clip(`臨床支援 ${problem}：${kind}${name === '' ? '' : ` ${name}`}`, ORDER_BASIS_LABEL_MAX));
    };
    for (const t of p.tests) add('確かめる検査', t.name, t.why.text);
    for (const g of p.guideline) add('ガイドライン・標準治療との照合', '', g.statement.text);
    for (const d of p.differentials) add('疑う疾患', d.name, d.reasoning.text);
  }

  const templates = new Map(input.templates.slice(0, PROPOSE_TEMPLATES_MAX).map((t, i) => [`X${String(i + 1)}`, t]));
  for (const [ref, t] of templates) refs.set(ref, clip(`テンプレ「${t.body.name}」`, ORDER_BASIS_LABEL_MAX));
  const orders = input.orders.slice(-PROPOSE_ORDERS_MAX);
  const orderRefs = new Map(orders.map((o, i) => [`O${String(i + 1)}`, o]));
  for (const [ref, o] of orderRefs) refs.set(ref, clip(`いまの指示（${ORDER_CATEGORY_SHORT[o.category]}）${o.text}`, ORDER_BASIS_LABEL_MAX));

  const categories = input.categories.length === 0 ? [...ORDER_CATEGORIES] : [...new Set(input.categories)];
  const payload = {
    ...base,
    clinicalSupport: findings,
    templates: [...templates].map(([ref, t]) => ({
      ref,
      name: t.body.name,
      drug: t.body.drug,
      concentration: concentrationText(t.body),
      doseUnit: t.body.doseUnit,
      steps: t.body.steps.map((s) => ({ label: s.label, dose: s.dose === null ? '量の記載なし' : `${numberText(s.dose)} ${t.body.doseUnit}`, note: s.note })),
      note: t.body.note,
    })),
    orders: [...orderRefs].map(([ref, o]) => ({
      ref,
      category: ORDER_CATEGORY_SHORT[o.category],
      status: ORDER_STATUS_NAMES[o.status],
      text: o.text,
      drug: o.drug,
      dose: o.dose,
      rate: o.rate,
      condition: o.condition,
      interval: o.interval,
    })),
    request: { categories: categories.map((c) => ({ id: c, name: ORDER_CATEGORY_NAMES[c] })) },
  };

  const texts = [
    ...findings.flatMap((f) => [f.name, f.text]),
    ...input.templates.flatMap((t) => [
      t.body.name,
      t.body.drug,
      t.body.note,
      concentrationText(t.body),
      ...t.body.steps.flatMap((s) => [s.label, s.note, s.dose === null ? '' : numberText(s.dose)]),
    ]),
    ...orders.flatMap((o) => ORDER_TEXT_FIELDS.map((f) => o[f])),
  ];
  const extra = backingFrom(texts, []);
  const backing: Backing = { body: [...new Set([...input.support.backing.body, ...extra.body])], when: input.support.backing.when };
  return {
    payload,
    refs,
    templates,
    backing,
    active: new Set(input.orders.filter((o) => o.status === 'active').map((o) => sameKey(o.category, o.text))),
    categories,
  };
}

export function proposeMessage(material: ProposeMaterial): string {
  return JSON.stringify(material.payload);
}

export const PROPOSE_REJECT_REASONS = ['empty', 'category', 'ungrounded', 'unknown_ref', 'unknown_template', 'template_category', 'rate_dropped', 'duplicate', 'cut', 'too_many'] as const;
export type ProposeRejectReason = (typeof PROPOSE_REJECT_REASONS)[number];
export const PROPOSE_REJECT_NAMES: Readonly<Record<ProposeRejectReason, string>> = {
  empty: '指示の文が空だった（出していません）',
  category: '頼んでいない欄だった（出していません）',
  ungrounded: '記録・テンプレ・臨床支援のどれにも結びつかなかった（出していません）',
  unknown_ref: '資料にない記号を根拠にしていた（その根拠だけ外しました）',
  unknown_template: '資料にないテンプレを指していた（テンプレだけ外しました）',
  template_category: '点滴でない欄でテンプレを指していた（テンプレだけ外しました）',
  rate_dropped: 'テンプレを使う案に流量が書かれていた（流量は carte が計算するので、速度の欄を空にしました）',
  duplicate: 'いまの指示・ほかの案と同じだった（出していません）',
  cut: '長すぎたので切った',
  too_many: '案が多すぎた（出していません）',
};

export interface CheckedPropose {
  readonly proposals: readonly OrderProposal[];
  readonly rejected: Partial<Record<ProposeRejectReason, number>>;
  /** 伏せた識別情報の形の数 */
  readonly shapes: number;
}

/** 案を確かめる：根拠の記号の実在・テンプレ・同じ案・長さ。識別情報の形は伏せ、資料に見つからない数は※（unseen） */
export function checkPropose(answer: ProposeAnswer, material: ProposeMaterial): CheckedPropose {
  const rejected: Partial<Record<ProposeRejectReason, number>> = {};
  const count = (r: ProposeRejectReason, n = 1): void => {
    rejected[r] = (rejected[r] ?? 0) + n;
  };
  const seen = new Set(material.active);
  const proposals: OrderProposal[] = [];
  let shapes = 0;
  for (const a of answer.items) {
    if (proposals.length >= PROPOSE_ITEMS_MAX) {
      count('too_many');
      continue;
    }
    if (!material.categories.includes(a.category)) {
      count('category');
      continue;
    }
    const clean = (value: string, max: number): string => {
      const replaced = replaceShapes(value.trim());
      for (const n of Object.values(replaced.counts)) shapes += n;
      if (replaced.text.length > max) {
        count('cut');
        return replaced.text.slice(0, max);
      }
      return replaced.text;
    };
    const fields: Record<OrderTextField, string> = {
      text: clean(a.text, ORDER_TEXT_MAX),
      condition: clean(a.condition, ORDER_FIELD_MAX),
      drug: clean(a.drug, ORDER_FIELD_MAX),
      dose: clean(a.dose, ORDER_FIELD_MAX),
      rate: clean(a.rate, ORDER_FIELD_MAX),
      interval: clean(a.interval, ORDER_FIELD_MAX),
      duration: clean(a.duration, ORDER_FIELD_MAX),
    };
    if (fields.text === '') {
      count('empty');
      continue;
    }
    const basis: OrderBasis[] = [];
    for (const ref of [...new Set(a.basis)]) {
      const label = material.refs.get(ref);
      if (label === undefined) {
        count('unknown_ref');
        continue;
      }
      if (basis.length < ORDER_BASIS_MAX) basis.push({ id: ref, label });
    }
    if (basis.length === 0) {
      count('ungrounded');
      continue;
    }
    let scale: ScaleUse | null = null;
    const ref = a.template.trim();
    if (ref !== '') {
      const t = material.templates.get(ref);
      if (t === undefined) count('unknown_template');
      else if (a.category !== 'infusion') count('template_category');
      else {
        scale = { templateId: t.id, template: t.body, weightKg: null, step: null };
        // 流量は AI に計算させない（carte がテンプレと体重から計算する）
        if (fields.rate !== '') {
          fields.rate = '';
          count('rate_dropped');
        }
      }
    }
    const key = sameKey(a.category, fields.text);
    if (seen.has(key)) {
      count('duplicate');
      continue;
    }
    seen.add(key);
    const unseen = [...new Set(ORDER_TEXT_FIELDS.flatMap((f) => unseenNumbers(fields[f], material.backing)))];
    proposals.push({ key: `p${String(proposals.length + 1)}`, category: a.category, ...fields, action: a.action, scale, origin: 'ai', from: null, basis, unseen });
  }
  return { proposals, rejected, shapes };
}
