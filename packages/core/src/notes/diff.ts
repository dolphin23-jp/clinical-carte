// 段K7：前の記載との違い（CA-068。CA-058 の A6）。決定論で、AI を使わない。純関数。保存しない。
//
// - 前の記載（previousNote）：同じ受診の、同じ種類の、日時が前の記載のうち、いちばん新しいもの。書いた人が同じものがあれば、それを先に選ぶ。
// - 比べ方（noteDiff）：保存した区切り（S・O・A・P・#問題 など）ごとに、行で比べる。比べるときだけ、全角・半角（NFKC）と空白をそろえる
//   （画面に出すのは、記載の字のまま）。同じ見出しに同じ行がなければ、ほかの見出しにある同じ行も「前と同じ」として数える（区切りが日ごとに少し違っても、写し続けた行を数えるため）。
// - 「ほぼ前回と同じ」は、行の数え方だけ（前と同じ行が 8 割を超える）。良い・悪いを決めない。
import { type SegmentLabel, SEGMENT_LABEL_NAMES } from '../organize/answer.ts';
import type { AuthorRole, SourceKind } from '../record/schema.ts';
import { compareDateTime } from '../time/datetime.ts';

/** 前の記載と比べる記載の種類（記載の文。検査結果・バイタル・処方は、比べない） */
export const DIFF_KINDS: readonly SourceKind[] = ['er_note', 'outpatient_first', 'outpatient_revisit', 'admission_note', 'progress_note', 'interim_summary', 'discharge_summary', 'nursing', 'memo'];

/** 「ほぼ前回と同じ」の割合（前と同じ行が、これを超える）。数え方の目安で、臨床の値ではない */
export const NEARLY_SAME_RATIO = 0.8;

export interface DiffSourceRow {
  readonly id: string;
  readonly encounterId: string;
  readonly kind: SourceKind;
  readonly authorRole: AuthorRole;
  readonly at: string | null;
  readonly enteredAt: string;
}

/** 前の記載：同じ受診・同じ種類・日時が前（同じ日時なら、先に入れたもの）。書いた人が同じものを先に選ぶ。日時のない記載は比べない */
export function previousNote<T extends DiffSourceRow>(sources: readonly T[], current: DiffSourceRow): { readonly source: T; readonly sameRole: boolean } | null {
  if (current.at === null || !DIFF_KINDS.includes(current.kind)) return null;
  const earlier = sources.filter(
    (s) =>
      s.id !== current.id &&
      s.encounterId === current.encounterId &&
      s.kind === current.kind &&
      s.at !== null &&
      (compareDateTime(s.at, current.at) < 0 || (s.at === current.at && (s.enteredAt < current.enteredAt || (s.enteredAt === current.enteredAt && s.id < current.id)))),
  );
  const latest = (list: readonly T[]): T | undefined => [...list].sort((a, b) => compareDateTime(a.at, b.at) || a.enteredAt.localeCompare(b.enteredAt) || a.id.localeCompare(b.id)).at(-1);
  const same = latest(earlier.filter((s) => s.authorRole === current.authorRole));
  if (same !== undefined) return { source: same, sameRole: true };
  const any = latest(earlier);
  return any === undefined ? null : { source: any, sameRole: false };
}

export interface DiffNote {
  readonly text: string;
  readonly segments: readonly { readonly label: SegmentLabel; readonly start: number; readonly end: number }[];
}

export interface DiffSection {
  /** 見出しの鍵（区切りの種類、または #問題の見出しの行をそろえたもの） */
  readonly key: string;
  /** 画面に出す名前（「S」「#1 心不全」「区切りのない部分」など） */
  readonly name: string;
  /** 前の記載と同じ行の数 */
  readonly unchanged: number;
  /** 前の記載になかった行（この記載の字のまま。書かれた順） */
  readonly added: readonly string[];
}

export interface NoteDiff {
  /** この記載の見出し（書かれた順） */
  readonly sections: readonly DiffSection[];
  /** 前の記載にあって、この記載にない行（前の記載の字のまま。前の記載の見出しの名前と、書かれた順） */
  readonly removed: readonly { readonly section: string; readonly line: string }[];
  /** この記載の行の数（空の行は数えない） */
  readonly lines: number;
  readonly unchanged: number;
  readonly added: number;
  /** 前の記載の行の数（空の行は数えない） */
  readonly previousLines: number;
  /** 前と同じ行が NEARLY_SAME_RATIO を超える（数え方だけ） */
  readonly nearlySame: boolean;
}

/** 比べるためだけのそろえ（全角・半角と、空白） */
export const diffKey = (line: string): string => line.normalize('NFKC').replace(/\s+/gu, ' ').trim();

const NONE_KEY = 'none';
const NONE_NAME = '区切りのない部分';
const AP_LABELS: readonly SegmentLabel[] = ['assessment', 'plan', 'assessment_plan'];

interface Line {
  readonly key: string;
  readonly name: string;
  readonly text: string;
  readonly norm: string;
}

/** 記載を、見出しごとの行にする。#問題の見出しの後の A・P は、その問題の見出しに入れる */
function linesOf(note: DiffNote): Line[] {
  const segs = [...note.segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const named: { start: number; end: number; key: string; name: string }[] = [];
  let problem: { key: string; name: string } | null = null;
  for (const g of segs) {
    if (g.label === 'problem_heading') {
      const head = note.text.slice(g.start, g.end).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? SEGMENT_LABEL_NAMES.problem_heading;
      problem = { key: `p:${diffKey(head)}`, name: head };
      named.push({ start: g.start, end: g.end, ...problem });
      continue;
    }
    if (AP_LABELS.includes(g.label) && problem !== null) {
      named.push({ start: g.start, end: g.end, ...problem });
      continue;
    }
    problem = null;
    named.push({ start: g.start, end: g.end, key: `l:${g.label}`, name: SEGMENT_LABEL_NAMES[g.label] });
  }
  const out: Line[] = [];
  let offset = 0;
  for (const raw of note.text.split('\n')) {
    const lead = raw.length - raw.trimStart().length;
    const at = offset + lead;
    offset += raw.length + 1;
    const norm = diffKey(raw);
    if (norm === '') continue;
    // その行の始まりを含む区切り。なければ、その前に始まった最後の区切り。なければ「区切りのない部分」
    const covering = named.filter((n) => at >= n.start && at < n.end).at(-1) ?? named.filter((n) => n.start <= at).at(-1);
    out.push({ key: covering?.key ?? NONE_KEY, name: covering?.name ?? NONE_NAME, text: raw.trim(), norm });
  }
  return out;
}

/** 前の記載との違い（行で比べる。決定論） */
export function noteDiff(previous: DiffNote, current: DiffNote): NoteDiff {
  const prev = linesOf(previous);
  const curr = linesOf(current);
  const used = new Array<boolean>(prev.length).fill(false);
  const same = new Array<boolean>(curr.length).fill(false);
  const take = (line: Line, sameSection: boolean): boolean => {
    const i = prev.findIndex((p, j) => !used[j] && p.norm === line.norm && (!sameSection || p.key === line.key));
    if (i < 0) return false;
    used[i] = true;
    return true;
  };
  // 1回目：同じ見出しの同じ行。2回目：ほかの見出しの同じ行
  curr.forEach((line, i) => {
    same[i] = take(line, true);
  });
  curr.forEach((line, i) => {
    if (!same[i]) same[i] = take(line, false);
  });
  const sections: { key: string; name: string; unchanged: number; added: string[] }[] = [];
  curr.forEach((line, i) => {
    let section = sections.find((x) => x.key === line.key);
    if (section === undefined) {
      section = { key: line.key, name: line.name, unchanged: 0, added: [] };
      sections.push(section);
    }
    if (same[i]) section.unchanged += 1;
    else section.added.push(line.text);
  });
  const unchanged = same.filter(Boolean).length;
  const removed = prev.filter((_, j) => !used[j]).map((p) => ({ section: p.name, line: p.text }));
  return {
    sections,
    removed,
    lines: curr.length,
    unchanged,
    added: curr.length - unchanged,
    previousLines: prev.length,
    nearlySame: curr.length > 0 && unchanged / curr.length > NEARLY_SAME_RATIO,
  };
}
