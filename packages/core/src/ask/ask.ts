// 段K6：記録への質問（出どころつき。CA-058 の A4。CA-066。2026-11-22）。先生が、この患者の記録について問い（「K をいつ、どれだけ補正した？」
// 「抗菌薬を変えた理由は？」「家族への説明は何回？」）を打つと、記録だけから AI が答え、答えの文ごとに、記録のどこに書かれているかを付ける。
// 答えは保存しない（画面のメモリだけ。相談〔CA-054〕と同じ）。問いの字も、保存もログもしない。
//
// この組は純関数：
// - 資料（askMaterial）：いまの受診と、直前の救急の受診（recentEncounters。結果待ちと同じ範囲）の、保存した文（R…。全文）と、
//   整理した事実（薬 M…・できごと E…・値 V…・経過の出来事 C…）。長いときは、古い値 → 古い経過の出来事 → 古い経過・看護・メモの記載を
//   評価と方針の部分だけに → 古い記載、の順に落とし、数を返す
// - AI の答えの形（AskAnswer。構造化出力の上限の中：null になりうる欄・必須でない欄は 0）
// - 確かめ（checkAnswer）：文ごとの根拠の記号が資料にある・引用が記録の字にある。根拠の確かめられない文は出さない（理由ごとの数）。
//   識別情報の形は伏せる。資料に見つからない数には印（※。markNumbers）。事実を足さない
import { z } from 'zod';

import { replaceShapes } from '../guard/shapes.ts';
import { type Backing, backingFrom, markNumbers } from '../notes/document.ts';
import { COURSE_CATEGORY_NAMES, type CourseCategory, EVENT_KIND_NAMES, type EventKind, MEDICATION_ACTION_NAMES, type MedicationAction, type SegmentLabel } from '../organize/answer.ts';
import { type PendingPointer, recentEncounters, type ScopeEncounter } from '../pending/pending.ts';
import type { NoteSegment } from '../problems/threads.ts';
import { ageNow, hospitalDay } from '../record/headline.ts';
import { AUTHOR_ROLE_LABELS, type AuthorRole, ENCOUNTER_KIND_LABELS, SEX_LABELS, type Sex, SOURCE_KIND_LABELS, type SourceKind } from '../record/schema.ts';
import { compareDateTime } from '../time/datetime.ts';

// ---------------------------------------------------------------------------
// 上限

/** 問いの長さの上限 */
export const ASK_QUESTION_MAX = 500;
/** 資料の長さの上限（字。JSON の長さ） */
export const ASK_MATERIAL_MAX = 80_000;
/** 答えの文の数 */
export const ASK_STATEMENTS_MAX = 12;
/** 1つの答えの文の長さ */
export const ASK_TEXT_MAX = 600;
/** 見つからなかったことの文の長さ */
export const ASK_NOT_FOUND_MAX = 300;
/** 1つの文の根拠の数 */
export const ASK_REFS_MAX = 8;
/** 引用の長さ */
export const ASK_QUOTE_MAX = 200;

// ---------------------------------------------------------------------------
// 資料

export interface AskSource {
  readonly id: string;
  readonly encounterId: string;
  readonly kind: SourceKind;
  readonly authorRole: AuthorRole;
  readonly at: string | null;
  readonly text: string;
}

export interface AskMedication extends PendingPointer {
  readonly encounterId: string;
  readonly name: string;
  readonly doseText: string | null;
  readonly action: MedicationAction | null;
  readonly at: string | null;
}

export interface AskEvent extends PendingPointer {
  readonly encounterId: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
}

export interface AskObservation extends PendingPointer {
  readonly encounterId: string;
  readonly name: string | null;
  readonly nameRaw: string;
  readonly comparator?: string | null;
  readonly valueText: string;
  readonly unit: string | null;
  readonly at: string | null;
}

export interface AskCourse extends PendingPointer {
  readonly encounterId: string;
  readonly category: CourseCategory;
  readonly summary: string;
  readonly at: string | null;
  readonly atApprox: string | null;
}

/** 呼ぶ側が、外した事実・字に見つからない AI の数を除いてから渡す */
export interface AskInput {
  readonly patient: { readonly age: number; readonly ageOn: string; readonly sex: Sex };
  readonly today: string;
  readonly encounters: readonly ScopeEncounter[];
  readonly sources: readonly AskSource[];
  readonly segments: readonly NoteSegment[];
  readonly medications: readonly AskMedication[];
  readonly events: readonly AskEvent[];
  readonly observations: readonly AskObservation[];
  readonly course: readonly AskCourse[];
}

export const ASK_REF_KINDS = ['record', 'medication', 'event', 'value', 'course'] as const;
export type AskRefKind = (typeof ASK_REF_KINDS)[number];

/** 根拠の場所（画面で、元の字を開く）。label は画面に出す短い名前 */
export interface AskRefTarget extends PendingPointer {
  readonly kind: AskRefKind;
  readonly label: string;
  readonly at: string | null;
}

export interface AskMaterial {
  readonly payload: Record<string, unknown>;
  /** 記号（R・M・E・V・C）→ 場所 */
  readonly refs: ReadonlyMap<string, AskRefTarget>;
  /** 文の id → 保存した文の全字（引用の確かめ） */
  readonly texts: ReadonlyMap<string, string>;
  readonly backing: Backing;
  /** 長さの上限で落とした・縮めた数 */
  readonly dropped: { readonly records: number; readonly shortened: number; readonly values: number; readonly course: number };
}

const show = (at: string | null): string => (at === null ? '日時不明' : at.replace('T', ' '));
const AP_LABELS: readonly SegmentLabel[] = ['problem_heading', 'assessment', 'plan', 'assessment_plan'];
const SHRINKABLE: readonly SourceKind[] = ['progress_note', 'nursing', 'memo', 'unsorted', 'outpatient_revisit'];
const valueOf = (o: AskObservation): string => `${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`;

/**
 * max は、資料の長さの上限（相談〔段M〕では、ほかの資料と合わせるので小さくする。既定は ASK_MATERIAL_MAX）。
 * allEncounters は、相談の窓口で「前の受診の記録も資料にする」を選んだときだけ（CA-084）：範囲を、患者のすべての受診に広げ、記載に、どの受診かを添える
 */
export function askMaterial(input: AskInput, options: { readonly max?: number; readonly allEncounters?: boolean } = {}): AskMaterial {
  const max = options.max ?? ASK_MATERIAL_MAX;
  const all = options.allEncounters === true;
  const scope = all ? [...input.encounters].sort((a, b) => compareDateTime(a.start, b.start) || a.id.localeCompare(b.id)) : recentEncounters(input.encounters);
  const visitOf = new Map(scope.map((e) => [e.id, `${ENCOUNTER_KIND_LABELS[e.kind]} ${e.start.replace('T', ' ')}〜`]));
  const ids = new Set(scope.map((e) => e.id));
  const current = scope.at(-1);
  const inpatient = current?.kind === 'inpatient';
  const dayOf = (at: string | null): string | null => (inpatient && at !== null ? (hospitalDay(current.start, at)?.toString() ?? null) : null);
  const byTime = <T extends { readonly at: string | null; readonly start: number }>(a: T, b: T): number => compareDateTime(a.at, b.at) || a.start - b.start;

  const sources = input.sources.filter((s) => ids.has(s.encounterId)).sort((a, b) => compareDateTime(a.at, b.at) || a.id.localeCompare(b.id));
  const meds = input.medications.filter((m) => ids.has(m.encounterId)).sort(byTime);
  const events = input.events.filter((e) => ids.has(e.encounterId)).sort(byTime);
  let values = input.observations.filter((o) => ids.has(o.encounterId)).sort(byTime);
  let course = input.course.filter((c) => ids.has(c.encounterId)).sort(byTime);
  const shortText = (src: AskSource): string => {
    const parts = input.segments.filter((g) => g.sourceId === src.id && AP_LABELS.includes(g.label)).sort((a, b) => a.start - b.start);
    const text = parts.map((g) => src.text.slice(g.start, g.end).trim()).filter((t) => t !== '').join('\n');
    return text === '' ? src.text.slice(0, 400) : text;
  };
  let records = sources.map((src) => ({ src, text: src.text, shortened: false }));
  const dropped = { records: 0, shortened: 0, values: 0, course: 0 };

  const build = () => {
    const recordRefs = new Map(records.map((r, i) => [`R${String(i + 1)}`, r]));
    const medRefs = new Map(meds.map((m, i) => [`M${String(i + 1)}`, m]));
    const eventRefs = new Map(events.map((e, i) => [`E${String(i + 1)}`, e]));
    const valueRefs = new Map(values.map((v, i) => [`V${String(i + 1)}`, v]));
    const courseRefs = new Map(course.map((c, i) => [`C${String(i + 1)}`, c]));
    const age = ageNow(input.patient.age, input.patient.ageOn, input.today);
    const payload = {
      patient: { age: `${String(age)}歳`, sex: SEX_LABELS[input.patient.sex] },
      encounters: scope.map((e) => ({ kind: ENCOUNTER_KIND_LABELS[e.kind], start: show(e.start), end: e.end === null ? null : show(e.end) })),
      records: [...recordRefs].map(([ref, r]) => ({
        ref,
        kind: SOURCE_KIND_LABELS[r.src.kind],
        author: AUTHOR_ROLE_LABELS[r.src.authorRole],
        date: show(r.src.at),
        day: dayOf(r.src.at) === null ? null : `${dayOf(r.src.at) ?? ''}病日`,
        shortened: r.shortened,
        ...(all ? { encounter: visitOf.get(r.src.encounterId) ?? '' } : {}),
        text: r.text,
      })),
      medications: [...medRefs].map(([ref, m]) => ({ ref, at: show(m.at), name: m.name, action: m.action === null ? '動きの記載なし' : MEDICATION_ACTION_NAMES[m.action], dose: m.doseText ?? '' })),
      events: [...eventRefs].map(([ref, e]) => ({ ref, at: show(e.at), kind: EVENT_KIND_NAMES[e.kind], title: e.title })),
      values: [...valueRefs].map(([ref, v]) => ({ ref, at: show(v.at), name: v.name ?? v.nameRaw, value: valueOf(v) })),
      course: [...courseRefs].map(([ref, c]) => ({ ref, at: show(c.at), approx: c.atApprox, category: COURSE_CATEGORY_NAMES[c.category], summary: c.summary })),
    };
    return { payload, recordRefs, medRefs, eventRefs, valueRefs, courseRefs, age };
  };

  let built = build();
  const tooLong = (): boolean => JSON.stringify(built.payload).length > max;
  // 古い値 → 古い経過の出来事 → 古い経過・看護・メモの記載を評価と方針の部分だけに → 古い記載（いちばん新しい記載は残す）
  while (tooLong()) {
    if (values.length > 0) {
      values = values.slice(1);
      dropped.values += 1;
    } else if (course.length > 0) {
      course = course.slice(1);
      dropped.course += 1;
    } else {
      const i = records.findIndex((r, k) => !r.shortened && SHRINKABLE.includes(r.src.kind) && k < records.length - 1);
      if (i >= 0) {
        const r = records[i];
        if (r !== undefined) records = [...records.slice(0, i), { ...r, text: shortText(r.src), shortened: true }, ...records.slice(i + 1)];
        dropped.shortened += 1;
      } else if (records.length > 1) {
        records = records.slice(1);
        dropped.records += 1;
      } else break;
    }
    built = build();
  }

  const refs = new Map<string, AskRefTarget>();
  for (const [ref, r] of built.recordRefs) refs.set(ref, { kind: 'record', sourceId: r.src.id, start: 0, end: r.src.text.length, label: `${SOURCE_KIND_LABELS[r.src.kind]} ${show(r.src.at)}`, at: r.src.at });
  for (const [ref, m] of built.medRefs)
    refs.set(ref, { kind: 'medication', sourceId: m.sourceId, start: m.start, end: m.end, label: `薬 ${m.name}${m.action === null ? '' : `（${MEDICATION_ACTION_NAMES[m.action]}）`} ${show(m.at)}`, at: m.at });
  for (const [ref, e] of built.eventRefs) refs.set(ref, { kind: 'event', sourceId: e.sourceId, start: e.start, end: e.end, label: `${EVENT_KIND_NAMES[e.kind]} ${e.title} ${show(e.at)}`, at: e.at });
  for (const [ref, v] of built.valueRefs) refs.set(ref, { kind: 'value', sourceId: v.sourceId, start: v.start, end: v.end, label: `値 ${v.name ?? v.nameRaw} ${valueOf(v)} ${show(v.at)}`, at: v.at });
  for (const [ref, c] of built.courseRefs) refs.set(ref, { kind: 'course', sourceId: c.sourceId, start: c.start, end: c.end, label: `経過 ${c.summary} ${show(c.at)}`, at: c.at });

  // 照らし合わせの数：記載の全文・事実・年齢と、日時・病日
  const body = [
    String(built.age),
    ...sources.map((s) => s.text),
    ...meds.flatMap((m) => [m.name, m.doseText ?? '']),
    ...events.map((e) => e.title),
    ...values.flatMap((v) => [v.name ?? v.nameRaw, valueOf(v)]),
    ...course.map((c) => c.summary),
  ];
  const when = [
    ...scope.flatMap((e) => [e.start, e.end ?? '']),
    ...sources.map((s) => `${s.at ?? ''} ${dayOf(s.at) ?? ''}`),
    ...[...meds, ...events, ...values, ...course].map((f) => `${f.at ?? ''} ${dayOf(f.at) ?? ''}`),
  ];
  return {
    payload: built.payload,
    refs,
    texts: new Map(input.sources.map((s) => [s.id, s.text])),
    backing: backingFrom(body, when),
    dropped,
  };
}

/** AI に送る文（JSON）：資料と、先生の問い */
export function askMessage(material: AskMaterial, question: string): string {
  return JSON.stringify({ ...material.payload, question });
}

// ---------------------------------------------------------------------------
// AI の答えの形（引用がなければ ""。null を使わない）

export const AskAnswer = z.object({
  answer: z.array(
    z.object({
      text: z.string(),
      /** 根拠の記号と、記録の字そのままの引用（引用しないときは ""） */
      refs: z.array(z.object({ id: z.string(), quote: z.string() })),
    }),
  ),
  /** 記録に見つからなかったこと（全部見つかれば ""） */
  notFound: z.string(),
});
export type AskAnswer = z.infer<typeof AskAnswer>;

/** 問い（打った字。保存しない） */
export const AskRequest = z.strictObject({ question: z.string().trim().min(1).max(ASK_QUESTION_MAX) });
export type AskRequest = z.infer<typeof AskRequest>;

// ---------------------------------------------------------------------------
// 確かめた後の形（画面に返す形。保存しない）

export interface AskRef extends AskRefTarget {
  readonly id: string;
  /** 引用で場所を絞った（false は、記載の全体・事実の場所） */
  readonly quoted: boolean;
}

export interface AskStatement {
  readonly text: string;
  /** 資料に見つからない数の場所（※） */
  readonly marks: readonly { readonly start: number; readonly end: number }[];
  readonly refs: readonly AskRef[];
}

export const ASK_REJECT_REASONS = ['unknown_ref', 'bad_quote', 'no_ref', 'empty', 'too_many'] as const;
export type AskRejectReason = (typeof ASK_REJECT_REASONS)[number];
export const ASK_REJECT_NAMES: Readonly<Record<AskRejectReason, string>> = {
  unknown_ref: '資料にない記号を指していた根拠',
  bad_quote: '記録の字に見つからない引用の根拠',
  no_ref: '確かめられる根拠がなかった文',
  empty: '中身がなかった文',
  too_many: '多すぎた文',
};

export interface AskReply {
  readonly answer: readonly AskStatement[];
  readonly notFound: string;
  readonly rejected: Partial<Record<AskRejectReason, number>>;
  /** 伏せた識別情報の形の数 */
  readonly shapes: number;
  readonly dropped: AskMaterial['dropped'];
}

/** AI の答えを確かめる：根拠の確かめられない文は出さない。事実を足さない */
export function checkAnswer(answer: AskAnswer, material: AskMaterial): AskReply {
  const rejected: Partial<Record<AskRejectReason, number>> = {};
  const count = (r: AskRejectReason): void => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  let shapes = 0;
  const clean = (text: string, max: number): string => {
    const r = replaceShapes(text.replace(/[ \t\u3000]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim());
    shapes += Object.values(r.counts).reduce((n, c) => n + c, 0);
    return r.text.slice(0, max);
  };
  const out: AskStatement[] = [];
  for (const a of answer.answer) {
    const text = clean(a.text, ASK_TEXT_MAX);
    if (text === '') {
      count('empty');
      continue;
    }
    const refs: AskRef[] = [];
    const seen = new Set<string>();
    for (const r of a.refs) {
      const target = material.refs.get(r.id);
      if (target === undefined) {
        count('unknown_ref');
        continue;
      }
      const q = r.quote.trim().slice(0, ASK_QUOTE_MAX);
      let ref: AskRef = { ...target, id: r.id, quoted: false };
      if (q !== '') {
        // 引用は、その記載の字そのもの（1字も違えば、根拠にしない）
        const full = material.texts.get(target.sourceId) ?? '';
        // 事実の記号なら、まず事実の場所の近く（同じ行の中）から探す
        const near = target.kind === 'record' ? -1 : full.indexOf(q, Math.max(0, full.lastIndexOf('\n', target.start) + 1));
        const at = near >= 0 ? near : full.indexOf(q);
        if (at < 0) {
          count('bad_quote');
          continue;
        }
        ref = { ...target, id: r.id, start: at, end: at + q.length, quoted: true };
      }
      const key = `${ref.sourceId}:${String(ref.start)}:${String(ref.end)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (refs.length < ASK_REFS_MAX) refs.push(ref);
    }
    if (refs.length === 0) {
      count('no_ref');
      continue;
    }
    if (out.length >= ASK_STATEMENTS_MAX) {
      count('too_many');
      continue;
    }
    out.push({ text, marks: markNumbers(text, material.backing).map((m) => ({ start: m.start, end: m.end })), refs });
  }
  return { answer: out, notFound: clean(answer.notFound, ASK_NOT_FOUND_MAX), rejected, shapes, dropped: material.dropped };
}
