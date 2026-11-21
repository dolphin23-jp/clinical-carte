// 段5：記載ノート（CA-030〜034）。日ごとに、問題ごとの S・O（決定論：保存した文の区切りの場所と、その日の値）と、
// 本人が残した A/P を並べる。AI の案の資料（記録の引用 Q）も、ここで作る。純関数。保存しない。
import { type SegmentLabel, SEGMENT_LABEL_NAMES } from '../organize/answer.ts';
import { medicationTimeline, nameKey } from '../organize/views.ts';
import { type NoteSegment, problemBlocks, problemNotes, relatedFacts, sharedPlanSegments, type ThreadView } from '../problems/threads.ts';
import { hospitalDay } from '../record/headline.ts';
import { compareDateTime } from '../time/datetime.ts';
import type { MaterialProblem, RefSource } from './ap.ts';

export interface NoteSource {
  readonly id: string;
  readonly encounterId: string;
  readonly at: string | null;
  readonly text: string;
}

export interface NoteObservation {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly at: string | null;
  readonly name: string | null;
  readonly nameRaw: string;
  readonly kind: 'lab' | 'vital' | null;
  readonly valueText: string;
  readonly unit: string | null;
  readonly start: number;
  readonly end: number;
}

export interface NoteMedication {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly doseText: string | null;
  readonly action: 'start' | 'change' | 'stop' | 'continue' | null;
  readonly at: string | null;
  readonly start: number;
  readonly end: number;
}

export interface NoteInput {
  readonly encounter: { readonly id: string; readonly kind: 'er' | 'outpatient' | 'inpatient'; readonly start: string };
  /** 日（YYYY-MM-DD） */
  readonly day: string;
  readonly sources: readonly NoteSource[];
  readonly segments: readonly NoteSegment[];
  /** 並べる問題（問題の筋の見方。並び・名前は本人の決めに従ったもの） */
  readonly threads: readonly ThreadView[];
  readonly observations: readonly NoteObservation[];
  readonly medications: readonly NoteMedication[];
}

/** 値の表示の1つ分（血圧は、同じ文・同じ場所の収縮期と拡張期を「BP 98/52」の1つにする） */
export interface ObservationText {
  readonly text: string;
  /** 表示の名前（血圧は「血圧」） */
  readonly name: string;
  readonly items: readonly NoteObservation[];
}

const SYSTOLIC = '収縮期血圧';
const DIASTOLIC = '拡張期血圧';

/** 値を、表示の文にする。血圧の2行は、同じ文・同じ場所なら1つにまとめる（字は、書かれた名前と値のまま） */
export function observationTexts(list: readonly NoteObservation[]): ObservationText[] {
  const out: ObservationText[] = [];
  const used = new Set<NoteObservation>();
  const unitOf = (o: NoteObservation): string => (o.unit === null ? '' : ` ${o.unit}`);
  for (const o of list) {
    if (used.has(o)) continue;
    if (o.name === SYSTOLIC || o.name === DIASTOLIC) {
      const other = list.find((x) => x !== o && !used.has(x) && x.sourceId === o.sourceId && x.start === o.start && x.name === (o.name === SYSTOLIC ? DIASTOLIC : SYSTOLIC));
      if (other !== undefined) {
        const [sys, dia] = o.name === SYSTOLIC ? [o, other] : [other, o];
        used.add(o).add(other);
        out.push({ text: `${sys.nameRaw} ${sys.valueText}/${dia.valueText}${unitOf(sys)}`, name: '血圧', items: [sys, dia] });
        continue;
      }
    }
    used.add(o);
    out.push({ text: `${o.nameRaw} ${o.valueText}${unitOf(o)}`, name: o.name ?? o.nameRaw, items: [o] });
  }
  return out;
}

/** 受診の、記載のある日（新しい順） */
export function noteDays(encounterId: string, sources: readonly NoteSource[]): string[] {
  return [...new Set(sources.filter((s) => s.encounterId === encounterId && s.at !== null).map((s) => (s.at ?? '').slice(0, 10)))].sort().reverse();
}

export interface NotePart {
  readonly sourceId: string;
  readonly label: SegmentLabel;
  readonly start: number;
  readonly end: number;
}

export interface NoteProblem {
  readonly thread: ThreadView;
  /** その日の、その問題の記載の S・O の区切り（場所だけ） */
  readonly s: readonly NotePart[];
  readonly o: readonly NotePart[];
  /** その日までの、その問題の記載に書かれた値（名前ごとの最新） */
  readonly values: readonly NoteObservation[];
  /** その日までの、いちばん新しい A・P の区切り（参考。場所だけ） */
  readonly lastAp: readonly NotePart[];
}

export interface NoteDay {
  readonly day: string;
  /** 病日（入院のときだけ） */
  readonly hospitalDay: number | null;
  readonly problems: readonly NoteProblem[];
  /** その日のバイタル（名前ごとの最新） */
  readonly vitals: readonly NoteObservation[];
  /** その日の、どの問題の範囲にも入らない S・O の区切り */
  readonly unassigned: readonly NotePart[];
  /** その日の記載の、記載全体の P（問題に分けて書かれていない A・P。sharedPlanSegments） */
  readonly shared: readonly NotePart[];
}

const onDay = (at: string | null, day: string): boolean => at !== null && at.slice(0, 10) === day;
const upTo = (at: string | null, day: string): boolean => at !== null && at.slice(0, 10) <= day;

/** 名前ごとの、いちばん新しい値 */
function latestByName(list: readonly NoteObservation[]): NoteObservation[] {
  const map = new Map<string, NoteObservation>();
  for (const o of [...list].sort((a, b) => compareDateTime(a.at, b.at))) map.set(o.name ?? o.nameRaw, o);
  return [...map.values()];
}

export function noteDay(input: NoteInput): NoteDay {
  const own = input.sources.filter((s) => s.encounterId === input.encounter.id);
  const ids = new Set(own.map((s) => s.id));
  const todayIds = new Set(own.filter((s) => onDay(s.at, input.day)).map((s) => s.id));
  const segs = input.segments.filter((g) => ids.has(g.sourceId));
  const sourceAt = new Map(own.map((s) => [s.id, s.at]));
  const obs = input.observations.filter((o) => o.encounterId === input.encounter.id);
  const covered = new Set<string>();

  const problems: NoteProblem[] = [];
  for (const thread of input.threads) {
    const mentionsToday = thread.mentions.filter((m) => todayIds.has(m.sourceId));
    const blocks = problemBlocks(mentionsToday, segs);
    const inBlocks = segs.filter((g) => blocks.some((b) => b.sourceId === g.sourceId && g.start >= b.start && g.end <= b.end));
    for (const g of inBlocks) covered.add(`${g.sourceId}:${String(g.start)}`);
    const s = inBlocks.filter((g) => g.label === 'subjective');
    const o = inBlocks.filter((g) => g.label === 'objective');
    const mentionsUpTo = thread.mentions.filter((m) => ids.has(m.sourceId) && upTo(sourceAt.get(m.sourceId) ?? null, input.day));
    const related = relatedFacts(mentionsUpTo, segs, { observations: obs, medications: [], events: [] });
    const names = new Set(related.valueNames);
    const values = latestByName(obs.filter((x) => names.has(x.name ?? x.nameRaw) && upTo(x.at, input.day)));
    const notes = problemNotes(mentionsUpTo, segs);
    const lastSource = notes.at(-1)?.sourceId;
    const lastAp = notes.filter((n) => n.sourceId === lastSource).map((n) => ({ sourceId: n.sourceId, label: n.label, start: n.start, end: n.end }));
    if (mentionsUpTo.length === 0) continue;
    problems.push({ thread, s, o, values, lastAp });
  }
  const unassigned = segs.filter((g) => todayIds.has(g.sourceId) && (g.label === 'subjective' || g.label === 'objective') && !covered.has(`${g.sourceId}:${String(g.start)}`));
  return {
    day: input.day,
    hospitalDay: input.encounter.kind === 'inpatient' ? hospitalDay(input.encounter.start, input.day) : null,
    problems,
    vitals: latestByName(obs.filter((x) => x.kind === 'vital' && onDay(x.at, input.day))),
    unassigned,
    shared: sharedPlanSegments(segs.filter((g) => todayIds.has(g.sourceId))).map((g) => ({ sourceId: g.sourceId, label: g.label, start: g.start, end: g.end })),
  };
}

/** 記録の引用の長さの上限（長い区切りは先頭から） */
export const RECORD_QUOTE_MAX = 400;
/** 1つの問題について、資料にする A・P の記載の数（新しいものから） */
export const RECORD_AP_SOURCES = 3;

/**
 * AI の案・議論の資料のうち、記録の引用（Q）：問題ごとに、その日までの A・P（新しい記載から3つ）、その日の S・O、
 * その日までの、その問題の記載に書かれた値と薬。その日のバイタルは、どの問題にも使える引用にする。
 */
export function recordSources(input: NoteInput, problems: readonly MaterialProblem[]): RefSource[] {
  const day = noteDay(input);
  const byThread = new Map(day.problems.map((p) => [p.thread.id, p]));
  const own = input.sources.filter((s) => s.encounterId === input.encounter.id);
  const textOf = new Map(own.map((s) => [s.id, s.text]));
  const atOf = new Map(own.map((s) => [s.id, s.at]));
  const dayOf = (at: string | null): number | null => (input.encounter.kind === 'inpatient' && at !== null ? hospitalDay(input.encounter.start, at) : null);
  const out: Omit<RefSource, 'id'>[] = [];
  const seen = new Set<string>();
  const quote = (problem: string | null, part: NotePart): void => {
    const key = `${part.sourceId}:${String(part.start)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const text = (textOf.get(part.sourceId) ?? '').slice(part.start, part.end).trim().slice(0, RECORD_QUOTE_MAX);
    if (text === '') return;
    const at = atOf.get(part.sourceId) ?? null;
    out.push({ kind: 'record', problem, text, at, day: dayOf(at), label: SEGMENT_LABEL_NAMES[part.label], ref: { k: 'record', sourceId: part.sourceId, start: part.start, end: part.end } });
  };
  const ids = new Set(own.map((s) => s.id));
  for (const p of problems) {
    const np = byThread.get(p.threadId);
    if (np === undefined) continue;
    const mentionsUpTo = np.thread.mentions.filter((m) => ids.has(m.sourceId) && upTo(atOf.get(m.sourceId) ?? null, input.day));
    const notes = problemNotes(mentionsUpTo, input.segments);
    const keepSources = [...new Set(notes.map((n) => n.sourceId))].slice(-RECORD_AP_SOURCES);
    for (const n of notes.filter((x) => keepSources.includes(x.sourceId))) quote(p.ref, { sourceId: n.sourceId, label: n.label, start: n.start, end: n.end });
    for (const part of [...np.s, ...np.o]) quote(p.ref, part);
    for (const t of observationTexts(np.values)) {
      const v = t.items[0];
      if (v === undefined) continue;
      out.push({ kind: 'record', problem: p.ref, text: t.text, at: v.at, day: dayOf(v.at), label: `値（${t.name}）`, ref: { k: 'record', sourceId: v.sourceId, start: v.start, end: v.end } });
    }
    const related = relatedFacts(mentionsUpTo, input.segments, { observations: [], medications: input.medications.filter((m) => upTo(m.at, input.day)), events: [] });
    const medKeys = new Set(related.medicationNames.map(nameKey));
    for (const line of medicationTimeline(input.medications.filter((m) => upTo(m.at, input.day)))) {
      if (!medKeys.has(nameKey(line.name))) continue;
      const lastFact = line.entries.at(-1);
      const last = input.medications.find((m) => m.id === lastFact?.id);
      if (last === undefined) continue;
      const action = last.action === null ? '' : `（${{ start: '開始', change: '変更', stop: '中止', continue: '継続' }[last.action]}）`;
      out.push({ kind: 'record', problem: p.ref, text: `${line.name}${last.doseText === null ? '' : ` ${last.doseText}`}${action}`, at: last.at, day: dayOf(last.at), label: '投薬', ref: { k: 'record', sourceId: last.sourceId, start: last.start, end: last.end } });
    }
  }
  // 記載全体の P は、どの問題にも結びつけず、どの問題にも使える引用にする
  for (const part of day.shared) quote(null, part);
  for (const t of observationTexts(day.vitals)) {
    const v = t.items[0];
    if (v === undefined) continue;
    out.push({ kind: 'record', problem: null, text: t.text, at: v.at, day: dayOf(v.at), label: `バイタル（${t.name}）`, ref: { k: 'record', sourceId: v.sourceId, start: v.start, end: v.end } });
  }
  return out.map((s, i) => ({ ...s, id: `Q${String(i + 1)}` }));
}
