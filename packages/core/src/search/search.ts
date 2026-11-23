// 受け持ちを横断する検索（段K8。CA-070。CA-058 の A8）。決定論で、AI を使わない。純関数：読むだけで、何も書かない。
// 探す先は、保存した文（識別情報を置き換えた後）・問題の名前（記録に書かれた問題の筋と、AI のプロブレムリスト）・薬の名前・できごとの題・
// 経過の出来事の要約（AI の整理）と、値の項目の名前（名前の表の正規の名前・別名で引く）。外した事実・隠した項目は探さない（見方と同じ）。
// **問いは保存しない・外へ送らない**（サーバーが読み、この関数に渡すだけ）。識別情報の形の問いは、画面とサーバーが同じ関数（searchQueryProblem）で止める。
// 比べ方：NFKC・英字の小文字・空白を除いた形での、部分一致。返す字は、保存した字のまま（そろえない）。
import { z } from 'zod';

import { findShapes } from '../guard/shapes.ts';
import { LAB_NAMES } from '../labs/catalog.gen.ts';
import { EXTRA_ALIASES, EXTRA_LAB_NAMES } from '../labs/extra-names.ts';
import type { EncounterKind, Sex, SourceKind } from '../record/schema.ts';

/** 問いの長さの上限（字） */
export const SEARCH_QUERY_MAX = 100;
/** 返す当たりの上限（全体） */
export const SEARCH_HIT_MAX = 50;
/** 患者ごとに返す当たりの上限（ほかの患者の当たりを押し出さないため） */
export const SEARCH_HITS_PER_PATIENT = 10;
/** 当たりの前後に添える字の数 */
export const SEARCH_SNIPPET_CHARS = 24;

/** 問い（打った字。保存しない・外へ送らない） */
export const SearchRequest = z.strictObject({ q: z.string().trim().min(1).max(SEARCH_QUERY_MAX) });
export type SearchRequest = z.infer<typeof SearchRequest>;

/** 比べるための形：NFKC・小文字・空白を除く */
export const searchKey = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

/** 問いを送れないわけ（送れるなら null）：識別情報の形（電話・メールなど）があるか、そろえると空か。画面とサーバーが同じ関数を使う */
export function searchQueryProblem(q: string): 'shape' | 'empty' | 'long' | null {
  if (q.trim().length > SEARCH_QUERY_MAX) return 'long';
  if (findShapes(q).length > 0) return 'shape';
  if (searchKey(q) === '') return 'empty';
  return null;
}

interface Indexed {
  readonly key: string;
  /** そろえた形の字ごとの、元の字の始まりと終わり */
  readonly from: readonly number[];
  readonly to: readonly number[];
}

/** 元の字の位置を覚えながら、そろえた形にする（1字ずつ NFKC にする：位置を元の字に戻すため） */
function indexed(text: string): Indexed {
  let key = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const folded = ch.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
    for (const c of folded) {
      key += c;
      for (let k = 0; k < c.length; k++) {
        from.push(i);
        to.push(i + ch.length);
      }
    }
    i += ch.length;
  }
  return { key, from, to };
}

/** 文の中の、問いに当たる場所（元の字の位置。重ならない） */
export function findMatches(text: string, query: string): { start: number; end: number }[] {
  const q = searchKey(query);
  if (q === '') return [];
  const ix = indexed(text);
  const out: { start: number; end: number }[] = [];
  let at = ix.key.indexOf(q);
  while (at >= 0) {
    const start = ix.from[at] ?? 0;
    const end = ix.to[at + q.length - 1] ?? text.length;
    out.push({ start, end });
    at = ix.key.indexOf(q, at + q.length);
  }
  return out;
}

/** 問いが、値の項目の名前（正規の名前・別名）そのものなら、その正規の名前 */
export function valueNamesOf(query: string): string[] {
  const q = searchKey(query);
  if (q === '') return [];
  const out = new Set<string>();
  for (const e of [...LAB_NAMES, ...EXTRA_LAB_NAMES]) if ([e.name, ...e.aliases].some((n) => searchKey(n) === q)) out.add(e.name);
  for (const e of EXTRA_ALIASES) if (e.aliases.some((n) => searchKey(n) === q)) out.add(e.name);
  return [...out];
}

// ---------------------------------------------------------------------------
// 入れる形（サーバーの行の、使う分だけ）

export interface SearchPatient {
  readonly id: string;
  readonly age: number;
  readonly ageOn: string;
  readonly sex: Sex;
}

export interface SearchEncounter {
  readonly id: string;
  readonly patientId: string;
  readonly kind: EncounterKind;
  readonly start: string;
  readonly end: string | null;
}

export interface SearchSource {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly kind: SourceKind;
  readonly at: string | null;
  /** 保存した文（識別情報を置き換えた後） */
  readonly text: string;
}

interface Spanned {
  readonly id: string;
  readonly sourceId: string;
  readonly start: number;
  readonly end: number;
}

export interface SearchInput {
  readonly patients: readonly SearchPatient[];
  readonly encounters: readonly SearchEncounter[];
  readonly sources: readonly SearchSource[];
  readonly medications: readonly (Spanned & { readonly name: string; readonly excluded: boolean })[];
  readonly events: readonly (Spanned & { readonly title: string; readonly excluded: boolean })[];
  readonly course: readonly (Spanned & { readonly summary: string })[];
  readonly observations: readonly (Spanned & { readonly name: string | null; readonly excluded: boolean; readonly at: string | null })[];
  /** 記録に書かれた問題（記載ごと）。筋が外されたものは除いて渡す */
  readonly problems: readonly (Spanned & { readonly name: string })[];
  /** 問題の筋の、打って直した名前（選別を通したもの）。いちばん新しい記載の場所を添える */
  readonly typedThreads: readonly { readonly id: string; readonly patientId: string; readonly name: string; readonly sourceId: string | null; readonly start: number }[];
  /** AI のプロブレムリスト（隠した項目は除いて渡す） */
  readonly listItems: readonly { readonly patientId: string; readonly key: string; readonly name: string }[];
}

// ---------------------------------------------------------------------------
// 返す形（保存しない）

/** 当たりの種類 */
export const SEARCH_HIT_KINDS = ['source', 'problem', 'list', 'medication', 'event', 'course', 'value'] as const;
export type SearchHitKind = (typeof SEARCH_HIT_KINDS)[number];
export const SEARCH_HIT_KIND_LABELS: Readonly<Record<SearchHitKind, string>> = {
  source: '記載の文',
  problem: '記録に書かれた問題',
  list: 'AI のプロブレムリスト',
  medication: '薬',
  event: 'できごと',
  course: '経過の出来事（AI の整理）',
  value: '値の項目',
};

export interface SearchHit {
  readonly kind: SearchHitKind;
  /** どの記載か（AI のプロブレムリストの項目は null） */
  readonly sourceId: string | null;
  readonly sourceKind: SourceKind | null;
  readonly at: string | null;
  readonly encounterId: string | null;
  /** 当たりの前後の字（保存した字のまま）。match が当たった字 */
  readonly before: string;
  readonly match: string;
  readonly after: string;
  /** 前後の字を切ったか（文の始まり・終わりまで届かないとき。画面が「…」を付ける） */
  readonly clippedBefore: boolean;
  readonly clippedAfter: boolean;
  /** 開く場所：記載の id と、字の始まり（AI のプロブレムリストは null） */
  readonly anchor: { readonly sourceId: string; readonly start: number } | null;
  /** 値の項目の当たり：同じ患者・同じ項目の値の数（いちばん新しい値を代表にする） */
  readonly count?: number;
}

export interface SearchPatientHits {
  readonly patientId: string;
  readonly patient: SearchPatient;
  /** いちばん新しい受診（見出しに使う） */
  readonly encounter: SearchEncounter | null;
  /** この患者の当たりの数（返さなかった分を含む） */
  readonly total: number;
  readonly hits: readonly SearchHit[];
}

export interface SearchResult {
  /** すべての当たりの数 */
  readonly total: number;
  /** 返した当たりの数 */
  readonly shown: number;
  readonly patients: readonly SearchPatientHits[];
}

/** 新しい順（日時のないものは最後） */
function newestFirst(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

/** 古い順（日時のないものは前。いちばん新しいものを最後に取るため） */
const oldestFirst = (a: string | null, b: string | null): number => -newestFirst(a, b);

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }): boolean => a.start < b.end && b.start < a.end;

/** 受け持ち（すべての患者）から探す。問いは、送る前に searchQueryProblem を通したもの */
export function searchRecords(input: SearchInput, query: string): SearchResult {
  const sourceOf = new Map(input.sources.map((s) => [s.id, s]));
  const latestEncounter = new Map<string, SearchEncounter>();
  for (const e of [...input.encounters].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))) latestEncounter.set(e.patientId, e);

  const around = (text: string, start: number, end: number): Pick<SearchHit, 'before' | 'match' | 'after' | 'clippedBefore' | 'clippedAfter'> => ({
    before: text.slice(Math.max(0, start - SEARCH_SNIPPET_CHARS), start),
    match: text.slice(start, end),
    after: text.slice(end, end + SEARCH_SNIPPET_CHARS),
    clippedBefore: start - SEARCH_SNIPPET_CHARS > 0,
    clippedAfter: end + SEARCH_SNIPPET_CHARS < text.length,
  });
  const placed = (sourceId: string): Pick<SearchHit, 'sourceId' | 'sourceKind' | 'at' | 'encounterId'> | null => {
    const s = sourceOf.get(sourceId);
    return s === undefined ? null : { sourceId: s.id, sourceKind: s.kind, at: s.at, encounterId: s.encounterId };
  };

  const byPatient = new Map<string, SearchHit[]>();
  const push = (patientId: string, hit: SearchHit) => {
    byPatient.set(patientId, [...(byPatient.get(patientId) ?? []), hit]);
  };
  // 事実の当たりが覆う、記載の文の場所（同じ字の「記載の文」の当たりは、事実の当たりにまとめる）
  const claimed = new Map<string, { start: number; end: number }[]>();
  const claim = (sourceId: string, span: { start: number; end: number }) => {
    claimed.set(sourceId, [...(claimed.get(sourceId) ?? []), span]);
  };

  // 名前・題の当たり（字は、記載の中の場所の字。場所の字に当たりがなければ、名前の字から）
  const factHits = (kind: 'medication' | 'event' | 'problem', rows: readonly (Spanned & { readonly label: string })[]) => {
    for (const r of rows) {
      const s = sourceOf.get(r.sourceId);
      if (s === undefined) continue;
      if (findMatches(r.label, query).length === 0) continue;
      const inText = findMatches(s.text.slice(r.start, r.end), query)[0];
      const span = inText === undefined ? { start: r.start, end: r.end } : { start: r.start + inText.start, end: r.start + inText.end };
      claim(s.id, { start: r.start, end: r.end });
      const where = placed(s.id);
      if (where === null) continue;
      push(s.patientId, { kind, ...where, ...around(s.text, span.start, span.end), anchor: { sourceId: s.id, start: span.start } });
    }
  };
  factHits('medication', input.medications.filter((m) => !m.excluded).map((m) => ({ ...m, label: m.name })));
  factHits('event', input.events.filter((e) => !e.excluded).map((e) => ({ ...e, label: e.title })));
  factHits('problem', input.problems.map((p) => ({ ...p, label: p.name })));

  // 値の項目：問いが項目の名前そのものなら、患者・項目ごとに、いちばん新しい値を代表にする（数を添える）
  const names = new Set(valueNamesOf(query));
  if (names.size > 0) {
    const groups = new Map<string, { patientId: string; rows: SearchInput['observations'][number][] }>();
    for (const o of input.observations) {
      if (o.excluded || o.name === null || !names.has(o.name)) continue;
      const s = sourceOf.get(o.sourceId);
      if (s === undefined) continue;
      claim(s.id, { start: o.start, end: o.end });
      const k = `${s.patientId}\u0000${o.name}`;
      const g = groups.get(k) ?? { patientId: s.patientId, rows: [] };
      g.rows.push(o);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      const last = [...g.rows].sort((a, b) => oldestFirst(a.at, b.at)).at(-1);
      const s = last === undefined ? undefined : sourceOf.get(last.sourceId);
      if (last === undefined || s === undefined) continue;
      const where = placed(s.id);
      if (where === null) continue;
      push(g.patientId, { kind: 'value', ...where, at: last.at ?? s.at, ...around(s.text, last.start, last.end), anchor: { sourceId: s.id, start: last.start }, count: g.rows.length });
    }
  }

  // 記載の文（事実の当たりが覆う場所は除く）
  for (const s of input.sources) {
    const taken = claimed.get(s.id) ?? [];
    for (const m of findMatches(s.text, query)) {
      if (taken.some((t) => overlaps(t, m))) continue;
      const where = placed(s.id);
      if (where === null) continue;
      push(s.patientId, { kind: 'source', ...where, ...around(s.text, m.start, m.end), anchor: { sourceId: s.id, start: m.start } });
    }
  }

  // 経過の出来事の要約（AI の整理の字）。開く場所は、その出来事が書かれた記載
  for (const c of input.course) {
    const s = sourceOf.get(c.sourceId);
    const m = findMatches(c.summary, query)[0];
    if (s === undefined || m === undefined) continue;
    const where = placed(s.id);
    if (where === null) continue;
    push(s.patientId, { kind: 'course', ...where, ...around(c.summary, m.start, m.end), anchor: { sourceId: s.id, start: c.start } });
  }

  // 問題の筋の、打って直した名前（選別を通したもの）
  for (const t of input.typedThreads) {
    const m = findMatches(t.name, query)[0];
    if (m === undefined) continue;
    const where = t.sourceId === null ? null : placed(t.sourceId);
    push(t.patientId, {
      kind: 'problem',
      sourceId: where?.sourceId ?? null,
      sourceKind: where?.sourceKind ?? null,
      at: where?.at ?? null,
      encounterId: where?.encounterId ?? null,
      ...around(t.name, m.start, m.end),
      anchor: where === null || t.sourceId === null ? null : { sourceId: t.sourceId, start: t.start },
    });
  }

  // AI のプロブレムリストの項目（開く場所は、問題のタブ）
  for (const item of input.listItems) {
    const m = findMatches(item.name, query)[0];
    if (m === undefined) continue;
    push(item.patientId, { kind: 'list', sourceId: null, sourceKind: null, at: null, encounterId: null, ...around(item.name, m.start, m.end), anchor: null });
  }

  // 並び：患者は、いちばん新しい受診の開始が新しい順（回診リストと同じ）。患者の中は、新しい記載の順（日時のないものは最後）
  const patients = input.patients
    .filter((p) => (byPatient.get(p.id) ?? []).length > 0)
    .map((p) => ({ p, encounter: latestEncounter.get(p.id) ?? null }))
    .sort((a, b) => (b.encounter?.start ?? '').localeCompare(a.encounter?.start ?? '') || b.p.id.localeCompare(a.p.id));
  let shown = 0;
  let total = 0;
  const out: SearchPatientHits[] = [];
  for (const { p, encounter } of patients) {
    const all = (byPatient.get(p.id) ?? [])
      .map((h, i) => ({ h, i }))
      .sort((a, b) => newestFirst(a.h.at, b.h.at) || a.i - b.i)
      .map(({ h }) => h);
    total += all.length;
    const room = Math.max(0, Math.min(SEARCH_HITS_PER_PATIENT, SEARCH_HIT_MAX - shown));
    const hits = all.slice(0, room);
    shown += hits.length;
    out.push({ patientId: p.id, patient: p, encounter, total: all.length, hits });
  }
  return { total, shown, patients: out };
}
