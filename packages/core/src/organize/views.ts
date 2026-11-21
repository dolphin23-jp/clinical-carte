// 整理した事実の見方（docs/04 の 1 の層④。保存しない、計算するだけ）：投薬の時間軸、問題の一覧、できごとの並び。
// 判定しない：並べるだけ（色・評価の語を付けない）。
import { compareDateTime } from '../time/datetime.ts';
import type { EventKind, MedicationAction, ProblemStatus } from './answer.ts';

/** 名前を、同じものとしてまとめるための形（全角半角・大文字小文字・空白をそろえる） */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** 問題の名前を、まとめるための形（先頭の「#1」「＃２」などの番号を除く） */
export function problemKey(name: string): string {
  return nameKey(name.normalize('NFKC').replace(/^#\s*\d*[.)．:]?\s*/u, ''));
}

/**
 * 事実の並び：日時の順。同じ日時なら、同じ記載の中では書かれた順（文の中の場所）、別の記載どうしは入れた順（id の順）。
 * 入院時記載の「【内服】アジルサルタン（継続）」と「P）アジルサルタンは中止」は同じ日時になる。id（同じミリ秒の中は乱数の順）で決めると、
 * 「薬ごとの最後の記載」が、記載の順と逆になりうる（2026-11-21）。
 */
export function compareFacts(a: { readonly id: string; readonly sourceId: string; readonly at: string | null; readonly start?: number }, b: { readonly id: string; readonly sourceId: string; readonly at: string | null; readonly start?: number }): number {
  return compareDateTime(a.at, b.at) || a.sourceId.localeCompare(b.sourceId) || (a.start ?? 0) - (b.start ?? 0) || a.id.localeCompare(b.id);
}

export interface MedicationFact {
  readonly id: string;
  readonly sourceId: string;
  /** 文の中の場所（同じ日時の並びに使う） */
  readonly start?: number;
  readonly name: string;
  readonly doseText: string | null;
  readonly action: MedicationAction | null;
  readonly at: string | null;
}

export interface MedicationLine {
  /** 最初に書かれた名前 */
  readonly name: string;
  readonly entries: readonly MedicationFact[];
}

/** 投薬の時間軸：薬ごとに、書かれた動きを日時の順に。薬は、最初に出てきた日時の順 */
export function medicationTimeline(facts: readonly MedicationFact[]): MedicationLine[] {
  const groups = new Map<string, MedicationFact[]>();
  for (const f of facts) {
    const key = nameKey(f.name);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const lines = [...groups.values()].map((list) => {
    const entries = [...list].sort(compareFacts);
    return { name: entries[0]?.name ?? '', entries };
  });
  return lines.sort((a, b) => compareDateTime(a.entries[0]?.at ?? null, b.entries[0]?.at ?? null) || a.name.localeCompare(b.name));
}

export interface ProblemFact {
  readonly id: string;
  readonly sourceId: string;
  readonly start?: number;
  readonly name: string;
  readonly status: ProblemStatus;
  readonly at: string | null;
}

export interface ProblemLine {
  readonly name: string;
  /** 書かれた回数 */
  readonly mentions: number;
  readonly first: string | null;
  readonly last: string | null;
  /** いちばん新しい記載での、書かれた確からしさ */
  readonly latestStatus: ProblemStatus;
}

/** 問題の一覧：同じ名前をまとめ、最初と最後に書かれた日時、いちばん新しい記載の書かれ方。最初に出てきた順 */
export function problemList(facts: readonly ProblemFact[]): ProblemLine[] {
  const groups = new Map<string, ProblemFact[]>();
  for (const f of facts) {
    const key = problemKey(f.name);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const lines = [...groups.values()].map((list) => {
    const sorted = [...list].sort(compareFacts);
    const dated = sorted.filter((f) => f.at !== null);
    const latest = dated.at(-1) ?? sorted.at(-1);
    return {
      name: sorted[0]?.name ?? '',
      mentions: sorted.length,
      first: dated[0]?.at ?? null,
      last: dated.at(-1)?.at ?? null,
      latestStatus: latest?.status ?? 'problem',
    };
  });
  return lines.sort((a, b) => compareDateTime(a.first, b.first) || a.name.localeCompare(b.name));
}

export interface EventFact {
  readonly id: string;
  readonly sourceId: string;
  readonly start?: number;
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
}

/** できごとの並び：日時の順（日時のないものは最後） */
export function eventTimeline(facts: readonly EventFact[]): EventFact[] {
  return [...facts].sort(compareFacts);
}

const dayOf = (at: string | null): string | null => (at === null ? null : at.slice(0, 10));
const untimed = (at: string | null): boolean => at !== null && at.length === 10;

/**
 * 同じ日の二重をたたむ（見せ方だけ。消さない・事実を変えない。2026-11-21 の本人の決定）：
 * 時刻のない（日だけの）投薬の記載で、同じ薬・同じ動きの、同じ日の時刻つきの記載があるもの。
 * 方針（P）の行と、経過の行（実施の記録）が別の記載に書かれたとき、同じ投与が2つ並ばないように。
 */
export function foldedMedicationIds(facts: readonly MedicationFact[]): Set<string> {
  const out = new Set<string>();
  for (const f of facts) {
    if (!untimed(f.at) || f.action === null) continue;
    const twin = facts.some((g) => g !== f && !untimed(g.at) && dayOf(g.at) === f.at && g.action === f.action && nameKey(g.name) === nameKey(f.name));
    if (twin) out.add(f.id);
  }
  return out;
}

/** できごとの題を比べる形（そろえて、記号・空白を除く） */
const titleKey = (t: string): string => nameKey(t).replace(/[\p{P}\p{S}]/gu, '');
/** 頭の字が同じとみなす長さ（「血液培養2セット：提出済み」と「血液培養2セット・尿培養（提出済み、10:45）」） */
export const EVENT_FOLD_PREFIX = 6;

/** 時刻のない（日だけの）できごとで、同じ種類・題の頭の字が同じ、同じ日の時刻つきのできごとがあるもの（見せ方だけ） */
export function foldedEventIds(facts: readonly EventFact[]): Set<string> {
  const out = new Set<string>();
  for (const f of facts) {
    if (!untimed(f.at)) continue;
    const head = titleKey(f.title).slice(0, EVENT_FOLD_PREFIX);
    if (head.length < EVENT_FOLD_PREFIX) continue;
    const twin = facts.some((g) => g !== f && !untimed(g.at) && dayOf(g.at) === f.at && g.kind === f.kind && titleKey(g.title).startsWith(head));
    if (twin) out.add(f.id);
  }
  return out;
}
