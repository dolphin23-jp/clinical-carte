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

export interface MedicationFact {
  readonly id: string;
  readonly sourceId: string;
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
    const entries = [...list].sort((a, b) => compareDateTime(a.at, b.at) || a.id.localeCompare(b.id));
    return { name: entries[0]?.name ?? '', entries };
  });
  return lines.sort((a, b) => compareDateTime(a.entries[0]?.at ?? null, b.entries[0]?.at ?? null) || a.name.localeCompare(b.name));
}

export interface ProblemFact {
  readonly id: string;
  readonly sourceId: string;
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
    const sorted = [...list].sort((a, b) => compareDateTime(a.at, b.at) || a.id.localeCompare(b.id));
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
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
}

/** できごとの並び：日時の順（日時のないものは最後） */
export function eventTimeline(facts: readonly EventFact[]): EventFact[] {
  return [...facts].sort((a, b) => compareDateTime(a.at, b.at) || a.id.localeCompare(b.id));
}
