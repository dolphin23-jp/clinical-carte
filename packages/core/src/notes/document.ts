// 段I：カルテ記載（CA-054。2026-11-21 の本人の決定）。救急外来記録・外来初診・外来再診・入院時記録・プログレスノート・
// 中間サマリー・退院サマリーを、「出す」を押したら、出来上がった1つの記載として出す。一文ずつの採用は求めない。
// 出した記載は、本人が自分で直すか、AI と相談して直し、保存するのは本人が「保存する」を押したものだけ（選別 C-1 を通す）。
//
// この組は純関数：
// - 記載の種類と見出し（DOC_TYPES・DOC_SECTIONS）
// - 資料（documentMaterial）：保存した文（識別情報を置き換えた後）と、整理した事実から、決定論で作る。範囲は種類と日で決まる
// - AI の答えの形（DocumentAnswer・ReviseAnswer）と、その整え（checkDocument）：見出しは決めた順に並べ直し、知らない見出しは数える。
//   識別情報の形は伏せる（replaceShapes）。根拠の記号は、実在するものだけを参照（場所・題・頁・URL。本文なし）にする
// - 数の印（markNumbers）：記載の中の数のうち、資料（記録・出典）に見つからないものの場所。消さずに印を付ける（本人の決定）。
//   用量・閾値を作らないのは指示で求め、印は決定論で付ける
import { z } from 'zod';

import { replaceShapes, type ShapeCounts } from '../guard/shapes.ts';
import { EVENT_KIND_NAMES, type EventKind, MEDICATION_ACTION_NAMES, type MedicationAction, PROBLEM_STATUS_NAMES, type SegmentLabel } from '../organize/answer.ts';
import { medicationTimeline } from '../organize/views.ts';
import type { NoteSegment, ThreadView } from '../problems/threads.ts';
import { ageNow, hospitalDay } from '../record/headline.ts';
import { AUTHOR_ROLE_LABELS, type AuthorRole, Day, type EncounterKind, SEX_LABELS, type Sex, SOURCE_KIND_LABELS, type SourceKind } from '../record/schema.ts';
import { compareDateTime, daysBetween } from '../time/datetime.ts';
import { ApRef, type RefSource } from './ap.ts';

// ---------------------------------------------------------------------------
// 種類と見出し

export const DOC_TYPES = ['er_record', 'outpatient_first', 'outpatient_revisit', 'admission', 'progress', 'interim_summary', 'discharge_summary'] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_TYPE_NAMES: Readonly<Record<DocType, string>> = {
  er_record: '救急外来記録',
  outpatient_first: '外来初診',
  outpatient_revisit: '外来再診',
  admission: '入院時記録',
  progress: 'プログレスノート',
  interim_summary: '中間サマリー',
  discharge_summary: '退院サマリー',
};

/** 受診の種類ごとに、出せる記載（並びは、よく使う順） */
export const DOC_TYPES_FOR: Readonly<Record<EncounterKind, readonly DocType[]>> = {
  er: ['er_record'],
  outpatient: ['outpatient_first', 'outpatient_revisit'],
  inpatient: ['progress', 'admission', 'interim_summary', 'discharge_summary'],
};

export interface DocSectionDef {
  readonly key: string;
  readonly heading: string;
  /** その見出しに書くこと（AI への指示に入れる。臨床の値は持たない） */
  readonly guide: string;
}

const s = (key: string, heading: string, guide: string): DocSectionDef => ({ key, heading, guide });

export const DOC_SECTIONS: Readonly<Record<DocType, readonly DocSectionDef[]>> = {
  er_record: [
    s('cc', '主訴', '主訴を短く'),
    s('hpi', '現病歴', '発症から来院までの経過を時系列で'),
    s('background', '既往歴・内服・アレルギー', '書かれている既往・内服・アレルギー・生活歴'),
    s('exam', '来院時所見', 'バイタルと身体所見'),
    s('tests', '検査所見', '血液検査・画像・心電図などの結果'),
    s('assessment', 'アセスメント', '#問題ごとの評価。鑑別を含む'),
    s('plan', 'プラン', '救急外来で行ったこと・行うこと'),
    s('disposition', '転帰・方針', '帰宅・入院・転院と、その後の方針'),
  ],
  outpatient_first: [
    s('cc', '主訴', '主訴を短く'),
    s('hpi', '現病歴', '発症から受診までの経過を時系列で'),
    s('background', '既往歴・内服・アレルギー・生活歴', '書かれている背景'),
    s('exam', '身体所見', 'バイタルと身体所見'),
    s('tests', '検査所見', '検査の結果'),
    s('assessment', 'アセスメント', '#問題ごとの評価。鑑別を含む'),
    s('plan', 'プラン', '検査・治療・説明・次回の受診'),
  ],
  outpatient_revisit: [
    s('s', 'S', '前回からの経過・症状'),
    s('o', 'O', 'バイタル・所見・検査の結果（推移）'),
    s('a', 'A', '#問題ごとの評価'),
    s('p', 'P', '#問題ごとの方針・次回の受診'),
  ],
  admission: [
    s('cc', '主訴', '主訴を短く'),
    s('hpi', '現病歴', '発症から入院までの経過を時系列で（救急外来での経過を含む）'),
    s('pmh', '既往歴', '書かれている既往歴'),
    s('meds', '内服薬', '入院前の内服'),
    s('allergy', 'アレルギー', '書かれているアレルギー'),
    s('social', '生活歴・社会歴', '喫煙・飲酒・ADL・住まい・家族構成など、書かれているもの'),
    s('family', '家族歴', '書かれている家族歴'),
    s('exam', '入院時身体所見', 'バイタルと身体所見'),
    s('tests', '入院時検査所見', '血液検査・画像・心電図などの結果'),
    s('problems', 'プロブレムリスト', '#番号つきの問題の一覧'),
    s('ap', 'アセスメントとプラン', '#問題ごとに、評価（A）と方針（P：診断・治療・説明）'),
  ],
  progress: [
    s('s', 'S', 'その日の症状・訴え'),
    s('o', 'O', 'その日のバイタル・所見・検査の結果（前日からの推移）'),
    s('ap', 'A/P', '#問題ごとに、評価（A）と方針（P）'),
  ],
  interim_summary: [
    s('diagnosis', '診断・プロブレムリスト', '#番号つきの問題と、その確からしさ'),
    s('before', '入院までの経過', '入院の理由と、入院までの経過を短く'),
    s('course', '入院後経過', '#問題ごとに、入院からいままでの経過（行った検査・治療と、その反応）'),
    s('now', '現在の状態', 'いまの症状・所見・検査、続いている治療'),
    s('plan', '今後の方針', '#問題ごとの、これからの方針'),
  ],
  discharge_summary: [
    s('diagnosis', '診断', '主病名と副病名（#番号つき）'),
    s('cc', '主訴', '入院時の主訴'),
    s('before', '入院までの経過', '入院の理由と、入院までの経過を短く'),
    s('findings', '入院時の主な所見', '入院時のバイタル・身体所見・検査の主なもの'),
    s('course', '入院後経過', '#問題ごとに、入院から退院までの経過（行った検査・治療と、その反応）'),
    s('meds', '退院時処方', '退院時の処方（書かれているものだけ）'),
    s('outcome', '転帰', '退院の日と、退院時の状態・退院先'),
    s('followup', '退院後の方針', '外来・再診・続ける治療・残った問題'),
  ],
};

// ---------------------------------------------------------------------------
// 上限

/** 1つの見出しの文の長さの上限 */
export const DOC_SECTION_MAX = 6000;
/** 記載の全体の長さの上限（選別に1回で通せる長さ） */
export const DOC_TOTAL_MAX = 18_000;
/** 資料の全体の長さの上限（超えるときは、古い記載から、評価と方針の部分だけにし、それでも超えれば古いものから落とす） */
export const DOC_MATERIAL_MAX = 60_000;
/** 1つの検査の項目について、資料に入れる値の数（新しいものから） */
export const DOC_VALUES_PER_NAME = 12;
/** 相談の問い・やりとりの長さの上限 */
export const DOC_TALK_MAX = 2000;

// ---------------------------------------------------------------------------
// 資料

export interface DocSource {
  readonly id: string;
  readonly encounterId: string;
  readonly kind: SourceKind;
  readonly authorRole: AuthorRole;
  readonly at: string | null;
  readonly text: string;
}

export interface DocObservation {
  readonly encounterId: string;
  readonly at: string | null;
  readonly name: string | null;
  readonly nameRaw: string;
  readonly kind: 'lab' | 'vital' | null;
  readonly comparator?: string | null;
  readonly valueText: string;
  readonly unit: string | null;
}

export interface DocMedication {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly name: string;
  readonly doseText: string | null;
  readonly action: MedicationAction | null;
  readonly at: string | null;
  readonly start: number;
}

export interface DocEvent {
  readonly encounterId: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
}

export interface DocApNote {
  readonly encounterId: string;
  readonly threadId: string;
  readonly day: string;
  readonly part: 'assessment' | 'plan';
  readonly text: string;
}

export interface DocEncounter {
  readonly id: string;
  readonly kind: EncounterKind;
  readonly start: string;
  readonly end: string | null;
}

export interface DocumentInput {
  readonly type: DocType;
  /** その日の時点の記載（YYYY-MM-DD）。プログレスノートは、その日の記載 */
  readonly day: string;
  readonly patient: { readonly age: number; readonly ageOn: string; readonly sex: Sex };
  readonly encounter: DocEncounter;
  /** その患者の受診（入院の記載では、直前の救急の受診も資料にする） */
  readonly encounters: readonly DocEncounter[];
  readonly sources: readonly DocSource[];
  readonly segments: readonly NoteSegment[];
  readonly threads: readonly ThreadView[];
  readonly observations: readonly DocObservation[];
  readonly medications: readonly DocMedication[];
  readonly events: readonly DocEvent[];
  readonly apNotes: readonly DocApNote[];
}

export interface DocRecord {
  /** 記号（R1…）。根拠の記号に使える */
  readonly id: string;
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly at: string | null;
  readonly day: number | null;
  readonly text: string;
  /** 長さの上限のため、評価と方針の部分だけにした */
  readonly shortened: boolean;
}

/** 数の印の照らし合わせの表（数だけ。本文は持たない） */
export interface Backing {
  /** 本文（記録・値・薬・できごと・出典）にある数 */
  readonly body: readonly string[];
  /** 日時・病日の数（日付・時刻・病日の形の数だけは、これでもよい） */
  readonly when: readonly string[];
}

export interface DocMaterial {
  readonly type: DocType;
  readonly day: string;
  readonly records: readonly DocRecord[];
  /** AI に送る資料（JSON。出典〔書籍・ネット〕は documentMessage で足す） */
  readonly payload: Record<string, unknown>;
  readonly backing: Backing;
  /** 長さの上限で、評価と方針の部分だけにした記載の数 */
  readonly shortened: number;
  /** 長さの上限で落とした記載の数 */
  readonly dropped: number;
  /** 資料に入れた問題の名前（書籍・ネットの検索語にする。問題の名前だけ） */
  readonly problemNames: readonly string[];
}

const DAY_MS = 86_400_000;
const shiftDay = (day: string, delta: number): string => {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) + delta * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
};
const dayOfAt = (at: string | null): string | null => (at === null ? null : at.slice(0, 10));
const showAt = (at: string | null): string => (at === null ? '日時不明' : at.replace('T', ' '));

/** 評価・方針の区切り（短くするときに残す部分） */
const AP_LABELS: readonly SegmentLabel[] = ['problem_heading', 'assessment', 'plan', 'assessment_plan'];

/** 数をそろえる（先頭の 0・末尾の 0 の違いは同じ数。全角は半角に） */
const normalizeNumber = (token: string): string => {
  const n = Number(token.normalize('NFKC'));
  return Number.isFinite(n) ? String(n) : token;
};
const NUMBER_RE = /[0-9０-９]+(?:[.．][0-9０-９]+)?/gu;
const numbersIn = (text: string): string[] => [...text.matchAll(NUMBER_RE)].map((m) => normalizeNumber(m[0]));

/** その種類の、資料の範囲（始まりの日・終わりの日。どちらも含む） */
function scopeOf(input: DocumentInput): { from: string; to: string; encounters: readonly DocEncounter[] } {
  const start = input.encounter.start.slice(0, 10);
  const to = input.day;
  if (input.type === 'progress') return { from: shiftDay(input.day, -1), to, encounters: [input.encounter] };
  if (input.type === 'admission' || input.type === 'interim_summary' || input.type === 'discharge_summary') {
    // 直前の救急の受診（入院の始まりの前の日から、その日まで）も、入院までの経過の資料にする
    const prior = input.encounters.filter((e) => e.id !== input.encounter.id && e.kind === 'er' && e.start.slice(0, 10) <= start && daysBetween(e.start.slice(0, 10), start) <= 1);
    return { from: prior.length > 0 ? (prior.map((e) => e.start.slice(0, 10)).sort()[0] ?? start) : start, to, encounters: [...prior, input.encounter] };
  }
  return { from: start, to, encounters: [input.encounter] };
}

export function documentMaterial(input: DocumentInput): DocMaterial {
  const scope = scopeOf(input);
  const encounterIds = new Set(scope.encounters.map((e) => e.id));
  const inScope = (encounterId: string, at: string | null): boolean => {
    if (!encounterIds.has(encounterId)) return false;
    const d = dayOfAt(at);
    // 日時のない記載は、その受診のものとして入れる（範囲で外さない）
    return d === null || (d >= scope.from && d <= scope.to);
  };
  const inpatient = input.encounter.kind === 'inpatient';
  const dayNumber = (at: string | null): number | null => (inpatient && at !== null ? hospitalDay(input.encounter.start, at) : null);

  // 記載：古い順。全文から始め、長ければ、古い経過の記載を評価と方針の部分だけにし、それでも長ければ古いものから落とす
  const own = input.sources.filter((src) => inScope(src.encounterId, src.at)).sort((a, b) => compareDateTime(a.at, b.at) || a.id.localeCompare(b.id));
  const segs = (id: string): NoteSegment[] => input.segments.filter((g) => g.sourceId === id).sort((a, b) => a.start - b.start);
  const shortText = (src: DocSource): string => {
    const parts = segs(src.id).filter((g) => AP_LABELS.includes(g.label));
    const text = parts.map((g) => src.text.slice(g.start, g.end).trim()).filter((t) => t !== '').join('\n');
    return text === '' ? src.text.slice(0, 400) : text;
  };
  // 縮めてよい記載：経過・看護・メモ・未分類（入院時・救急・初診・サマリー・検査・バイタルは全文のまま）
  const shrinkable = (src: DocSource): boolean => ['progress_note', 'nursing', 'memo', 'unsorted', 'outpatient_revisit'].includes(src.kind);
  // プログレスノートでは、その日の記載は縮めない
  const keepFull = (src: DocSource): boolean => input.type === 'progress' && dayOfAt(src.at) === input.day;
  let entries = own.map((src) => ({ src, text: src.text, shortened: false }));
  const total = (): number => entries.reduce((n, e) => n + e.text.length + 60, 0);
  for (const e of entries) {
    if (total() <= DOC_MATERIAL_MAX) break;
    if (shrinkable(e.src) && !keepFull(e.src)) {
      e.text = shortText(e.src);
      e.shortened = true;
    }
  }
  let dropped = 0;
  while (total() > DOC_MATERIAL_MAX) {
    const i = entries.findIndex((e) => !keepFull(e.src));
    if (i < 0) break;
    entries = [...entries.slice(0, i), ...entries.slice(i + 1)];
    dropped += 1;
  }
  const records: DocRecord[] = entries.map((e, i) => ({ id: `R${String(i + 1)}`, sourceId: e.src.id, kind: e.src.kind, at: e.src.at, day: dayNumber(e.src.at), text: e.text, shortened: e.shortened }));

  // 検査値・バイタル：書かれたとおり（名前ごとに、新しいものから決まった数）。バイタルは、プログレスノートではその日だけ
  const valueLines = (kind: 'lab' | 'vital'): { name: string; values: string[] }[] => {
    const list = input.observations.filter((o) => o.kind === kind && inScope(o.encounterId, o.at) && (kind === 'lab' || input.type !== 'progress' || dayOfAt(o.at) === input.day));
    const by = new Map<string, DocObservation[]>();
    for (const o of [...list].sort((a, b) => compareDateTime(a.at, b.at))) {
      const key = o.name ?? o.nameRaw;
      by.set(key, [...(by.get(key) ?? []), o]);
    }
    return [...by.entries()].map(([name, items]) => ({
      name,
      values: items.slice(-DOC_VALUES_PER_NAME).map((o) => `${showAt(o.at)} ${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`),
    }));
  };
  const labs = valueLines('lab');
  const vitals = valueLines('vital');

  // 投薬：薬ごとの動き（書かれたとおり）
  const meds = medicationTimeline(input.medications.filter((m) => inScope(m.encounterId, m.at))).map((line) => ({
    name: line.name,
    entries: line.entries.map((m) => {
      const fact = input.medications.find((x) => x.id === m.id);
      return `${showAt(m.at)} ${fact?.action === null || fact?.action === undefined ? '動きの記載なし' : MEDICATION_ACTION_NAMES[fact.action]}${fact?.doseText === null || fact?.doseText === undefined ? '' : ` ${fact.doseText}`}`;
    }),
  }));
  const events = input.events
    .filter((e) => inScope(e.encounterId, e.at))
    .sort((a, b) => compareDateTime(a.at, b.at))
    .map((e) => `${showAt(e.at)} ${EVENT_KIND_NAMES[e.kind]}：${e.title}`);

  // 問題：いまの問題（サマリーでは、解決・否定的と書かれたものも）。名前と確からしさだけ
  const threadsHere = input.threads.filter((t) => t.mentions.some((m) => own.some((src) => src.id === m.sourceId)));
  const summary = input.type === 'interim_summary' || input.type === 'discharge_summary';
  const problems = threadsHere
    .filter((t) => summary || t.group === 'current')
    .map((t) => ({ name: t.name, status: PROBLEM_STATUS_NAMES[t.status], group: t.group === 'current' ? 'いまの問題' : t.group === 'closed' ? '解決・非活動と書かれた' : '否定的と書かれた' }));
  const threadName = new Map(input.threads.map((t) => [t.id, t.name]));
  const savedAp = input.apNotes
    .filter((n) => encounterIds.has(n.encounterId) && n.day >= scope.from && n.day <= scope.to)
    .map((n) => `${n.day} ${threadName.get(n.threadId) ?? '問題'} ${n.part === 'assessment' ? 'A' : 'P'}：${n.text}`);

  const age = ageNow(input.patient.age, input.patient.ageOn, input.day);
  const payload: Record<string, unknown> = {
    document: { type: input.type, name: DOC_TYPE_NAMES[input.type], sections: DOC_SECTIONS[input.type].map((x) => ({ key: x.key, heading: x.heading, guide: x.guide })) },
    patient: { age: `${String(age)}歳`, sex: SEX_LABELS[input.patient.sex] },
    encounter: {
      kind: { er: '救急', outpatient: '外来', inpatient: '入院' }[input.encounter.kind],
      start: showAt(input.encounter.start),
      end: input.encounter.end === null ? null : showAt(input.encounter.end),
      asOf: input.day,
      hospitalDay: inpatient ? hospitalDay(input.encounter.start, input.day) : null,
    },
    problems,
    records: records.map((r) => ({ id: r.id, kind: SOURCE_KIND_LABELS[r.kind], author: AUTHOR_ROLE_LABELS[own.find((x) => x.id === r.sourceId)?.authorRole ?? 'unknown'], date: showAt(r.at), day: r.day === null ? null : `${String(r.day)}病日`, shortened: r.shortened, text: r.text })),
    labs,
    vitals,
    medications: meds,
    events,
    savedAp,
  };

  // 照らし合わせの数
  const bodyTexts = [
    ...records.map((r) => r.text),
    ...labs.flatMap((l) => [l.name, ...l.values.map((v) => v.replace(/^\S+ \S+ /u, ''))]),
    ...vitals.flatMap((l) => [l.name, ...l.values.map((v) => v.replace(/^\S+ \S+ /u, ''))]),
    ...meds.flatMap((m) => [m.name, ...m.entries]),
    ...events,
    ...savedAp,
    ...problems.map((p) => p.name),
    String(age),
  ];
  const whenTexts = [
    ...records.map((r) => `${r.at ?? ''} ${r.day === null ? '' : String(r.day)}`),
    ...labs.flatMap((l) => l.values),
    ...vitals.flatMap((l) => l.values),
    input.encounter.start,
    input.encounter.end ?? '',
    input.day,
    inpatient ? String(hospitalDay(input.encounter.start, input.day) ?? '') : '',
    // 病日の数は、範囲の日すべて（「3病日」と書く日が、記載の日と違ってもよい）
    ...(inpatient ? Array.from({ length: Math.max(0, daysBetween(input.encounter.start.slice(0, 10), input.day) + 1) }, (_, i) => String(i + 1)) : []),
  ];
  const backing: Backing = { body: uniq(bodyTexts.flatMap(numbersIn)), when: uniq(whenTexts.flatMap(numbersIn)) };
  return { type: input.type, day: input.day, records, payload, backing, shortened: entries.filter((e) => e.shortened).length, dropped, problemNames: problems.filter((p) => p.group === 'いまの問題').map((p) => p.name) };
}

const uniq = (list: readonly string[]): string[] => [...new Set(list)].sort();

/** 出典（書籍・ネット）の数を、照らし合わせの表に足す */
export function backingWith(backing: Backing, refs: readonly { readonly text: string }[]): Backing {
  return { body: uniq([...backing.body, ...refs.flatMap((r) => numbersIn(r.text))]), when: backing.when };
}

/** AI に送る文（JSON）：資料と、出典（書籍・ネット）。相談のときは、いまの記載とやりとりと問い */
export function documentMessage(
  material: DocMaterial,
  refs: readonly RefSource[],
  talk?: { readonly sections: readonly { readonly key: string; readonly text: string }[]; readonly history: readonly { readonly role: 'doctor' | 'ai'; readonly text: string }[]; readonly instruction: string },
): string {
  return JSON.stringify({
    ...material.payload,
    references: refs.map((r) => ({ id: r.id, kind: r.kind === 'book' ? '書籍' : 'ネット', label: r.label, text: r.text })),
    ...(talk === undefined
      ? {}
      : {
          current: talk.sections.map((x) => ({ key: x.key, heading: DOC_SECTIONS[material.type].find((d) => d.key === x.key)?.heading ?? x.key, text: x.text })),
          conversation: talk.history,
          instruction: talk.instruction,
        }),
  });
}

// ---------------------------------------------------------------------------
// AI の答えと、その整え

const AnswerSection = z.object({ key: z.string(), text: z.string(), refs: z.array(z.string()) });
export const DocumentAnswer = z.object({ sections: z.array(AnswerSection) });
export type DocumentAnswer = z.infer<typeof DocumentAnswer>;
export const ReviseAnswer = z.object({ reply: z.string(), sections: z.array(AnswerSection) });
export type ReviseAnswer = z.infer<typeof ReviseAnswer>;

export interface DocSection {
  readonly key: string;
  readonly heading: string;
  readonly text: string;
  /** 根拠の参照（場所・題・頁・URL。本文なし） */
  readonly refs: readonly ApRef[];
}

export interface DocNotes {
  /** 決めた見出しにない見出し（中身ごと出していない） */
  readonly unknownSections: number;
  /** 長さの上限で切った見出しの数 */
  readonly cut: number;
  /** 伏せた識別情報の形 */
  readonly shapes: ShapeCounts;
  /** 実在しない根拠の記号（参照にしていない） */
  readonly unknownRefs: number;
}

export interface CheckedDocument {
  readonly sections: readonly DocSection[];
  readonly notes: DocNotes;
}

/** 根拠の記号から、参照（ApRef）へ：記録（R…）・書籍（B…）・ネット（W…） */
function refsOf(ids: readonly string[], material: DocMaterial, refs: readonly RefSource[], unknown: () => void): ApRef[] {
  const out: ApRef[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const record = material.records.find((r) => r.id === id);
    if (record !== undefined) {
      out.push({ k: 'record', sourceId: record.sourceId, start: 0, end: record.text.length });
      continue;
    }
    const ref = refs.find((r) => r.id === id);
    if (ref === undefined) {
      unknown();
      continue;
    }
    out.push(ref.ref);
  }
  return out.slice(0, 20);
}

/** 文の整え：改行をそろえ、行末の空白を落とし、前後の空行を落とす */
const tidy = (text: string): string =>
  text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/^\n+|\n+$/gu, '')
    .replace(/\n{3,}/gu, '\n\n');

/**
 * AI の答えを、記載にする：見出しは決めた順に並べ、答えにない見出しは空（書かれていないことを補わない）。
 * 同じ見出しが2回あれば、つなげる。識別情報の形は伏せる。根拠の記号は、実在するものだけを参照にする
 */
export function checkDocument(answer: { readonly sections: readonly { readonly key: string; readonly text: string; readonly refs: readonly string[] }[] }, material: DocMaterial, refs: readonly RefSource[]): CheckedDocument {
  const defs = DOC_SECTIONS[material.type];
  let unknownSections = 0;
  let unknownRefs = 0;
  let cut = 0;
  const shapes: Partial<Record<keyof ShapeCounts, number>> = {};
  const byKey = new Map<string, { text: string[]; refs: string[] }>();
  for (const x of answer.sections) {
    if (!defs.some((d) => d.key === x.key)) {
      unknownSections += 1;
      continue;
    }
    const cur = byKey.get(x.key) ?? { text: [], refs: [] };
    cur.text.push(x.text);
    cur.refs.push(...x.refs);
    byKey.set(x.key, cur);
  }
  const sections = defs.map((d) => {
    const got = byKey.get(d.key);
    let text = tidy((got?.text ?? []).join('\n'));
    const replaced = replaceShapes(text);
    text = replaced.text;
    for (const [k, n] of Object.entries(replaced.counts)) shapes[k as keyof ShapeCounts] = (shapes[k as keyof ShapeCounts] ?? 0) + n;
    if (text.length > DOC_SECTION_MAX) {
      text = text.slice(0, DOC_SECTION_MAX);
      cut += 1;
    }
    return {
      key: d.key,
      heading: d.heading,
      text,
      refs: refsOf(got?.refs ?? [], material, refs, () => {
        unknownRefs += 1;
      }),
    };
  });
  return { sections, notes: { unknownSections, cut, shapes, unknownRefs } };
}

/** 記載を、1つの文にする（見出しは【】。中身のない見出しも残す：書かれていないことを補わない） */
export function documentText(type: DocType, sections: readonly { readonly key: string; readonly text: string }[]): string {
  return DOC_SECTIONS[type].map((d) => `【${d.heading}】\n${sections.find((x) => x.key === d.key)?.text ?? ''}`.trimEnd()).join('\n\n');
}

// ---------------------------------------------------------------------------
// 数の印

/** 日付・時刻・病日の形（この形の数は、日時・病日の数とも照らす） */
const WHEN_SHAPE = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|\d{1,2}月|\d{1,2}日(?:目|間)?|\d{1,2}時(?:\d{1,2}分)?|\d{1,2}:\d{2}|第?\d+病日|\d+週|\d+か?ヶ?カ?月(?:前|間|後)|\d+年(?:前|間|後)/gu;

export interface NumberMark {
  readonly start: number;
  readonly end: number;
}

/**
 * 記載の中の数のうち、資料（記録・値・薬・できごと・出典）に見つからないものの場所（消さない：印を付ける）。
 * - 日付・時刻・病日の形の数は、日時・病日の数でもよい
 * - 「#1」の番号、行頭の番号（「1)」「1.」）は、記載の形なので見ない
 * - 英字のすぐ後の1桁（SpO2・HbA1c・PaCO2 など、名前の一部）は見ない
 */
export function markNumbers(text: string, backing: Backing): NumberMark[] {
  const body = new Set(backing.body);
  const when = new Set([...backing.body, ...backing.when]);
  const folded = text.replace(/[０-９]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/．/gu, '.');
  const whenSpans: { start: number; end: number }[] = [...folded.matchAll(WHEN_SHAPE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const out: NumberMark[] = [];
  for (const m of folded.matchAll(/\d+(?:\.\d+)?/gu)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = folded.slice(Math.max(0, start - 1), start);
    if (before === '#' || before === '＃') continue;
    const lineStart = folded.lastIndexOf('\n', start - 1) + 1;
    const after = folded.slice(end, end + 1);
    if (/^\s*$/u.test(folded.slice(lineStart, start)) && /^[.)）、．]/u.test(after)) continue;
    if (/[A-Za-z]/u.test(before) && m[0].length === 1) continue;
    const n = String(Number(m[0]));
    const inWhen = whenSpans.some((w) => start >= w.start && end <= w.end);
    if (inWhen ? when.has(n) : body.has(n)) continue;
    out.push({ start, end });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 頼みの形と、保存の形

export const DocumentRequest = z.strictObject({ type: z.enum(DOC_TYPES), day: Day, web: z.boolean() });
export type DocumentRequest = z.infer<typeof DocumentRequest>;
export const DocumentBackingRequest = z.strictObject({ type: z.enum(DOC_TYPES), day: Day });

export const DocSectionText = z.strictObject({ key: z.string().min(1).max(40), text: z.string().max(DOC_SECTION_MAX) });

export const ReviseRequest = z.strictObject({
  type: z.enum(DOC_TYPES),
  day: Day,
  web: z.boolean(),
  sections: z.array(DocSectionText).min(1).max(20),
  instruction: z.string().min(1).max(DOC_TALK_MAX),
  history: z.array(z.strictObject({ role: z.enum(['doctor', 'ai']), text: z.string().min(1).max(DOC_TALK_MAX) })).max(20),
});
export type ReviseRequest = z.infer<typeof ReviseRequest>;

export const SavedSection = z.strictObject({ key: z.string().min(1).max(40), text: z.string().max(DOC_SECTION_MAX), refs: z.array(ApRef).max(20) });
export type SavedSection = z.infer<typeof SavedSection>;

/** 記載を残す：AI が書いたままか（ai）・AI が書いたものを直したか（edited）・先生が書いたか（self） */
export const DocumentNew = z.strictObject({
  type: z.enum(DOC_TYPES),
  day: Day,
  sections: z.array(SavedSection).min(1).max(20),
  origin: z.enum(['ai', 'self']),
  edited: z.boolean(),
});
export type DocumentNew = z.infer<typeof DocumentNew>;

/** 残した記載を直す（文は選別を通す。AI が書いたものなら「AI が書いて先生が直した」になる） */
export const DocumentPatch = z.strictObject({ sections: z.array(SavedSection).min(1).max(20) });
export type DocumentPatch = z.infer<typeof DocumentPatch>;

export const DOC_ORIGINS = ['ai', 'ai_edited', 'self'] as const;
export type DocOrigin = (typeof DOC_ORIGINS)[number];
export const DOC_ORIGIN_NAMES: Readonly<Record<DocOrigin, string>> = { ai: 'AI が書いた', ai_edited: 'AI が書いて先生が直した', self: '先生が書いた' };

/** 残すときの見出しの確かめ：決めた見出しだけ・同じ見出しは1回・全体の長さ */
export function sectionsFit(type: DocType, sections: readonly { readonly key: string; readonly text: string }[]): boolean {
  const keys = DOC_SECTIONS[type].map((d) => d.key);
  if (sections.some((x) => !keys.includes(x.key))) return false;
  if (new Set(sections.map((x) => x.key)).size !== sections.length) return false;
  if (sections.every((x) => x.text.trim() === '')) return false;
  return sections.reduce((n, x) => n + x.text.length, 0) <= DOC_TOTAL_MAX;
}

export interface SavedDocument {
  readonly id: string;
  readonly encounterId: string;
  readonly type: DocType;
  readonly day: string;
  readonly sections: readonly SavedSection[];
  readonly origin: DocOrigin;
  readonly enteredAt: string;
  readonly updatedAt: string;
}

/** 受診の種類と日から、記載の既定の日：プログレスノートは選んだ日、ほかは記録の最後の日（なければ受診の始まりの日） */
export function defaultDocDay(type: DocType, encounter: DocEncounter, lastDay: string | null, selected: string | null): string {
  if (selected !== null) return selected;
  if (type === 'admission') return encounter.start.slice(0, 10);
  if (type === 'discharge_summary' && encounter.end !== null) return encounter.end.slice(0, 10);
  return lastDay ?? encounter.start.slice(0, 10);
}

