// 段K5：AI の臨床支援（CA-059 の3つ目。CA-064。2026-11-22 の本人の決定）。AI のプロブレムリストの活動中の問題ごとに、
// まだ診断がついていない問題は「疑う疾患（根拠と、足りない情報）」と「確かめる検査の候補」、診断がついている問題は
// 「ガイドライン・標準治療との照合（沿っている・差がある・分からない）」を、書籍（RAG）・ネットの出典の引用つきで、AI が書く。
// 表にない基準・スコアは、出典の引用があるときだけ補う（AI は点数・閾値を計算しない）。最終判断は先生。
//
// この組は純関数：
// - 資料（supportMaterial）：記録から決定論で作る。年齢・性別、受診、プロブレムリスト（P1…。番号は numberedList と同じ）、記録に書かれた問題の筋（T…）、
//   経過の出来事（C…）、項目ごとの値（V…。段K3 の H・L の印つき）、薬（M…。段K1 の日数）、デバイス（D…。段K1）、
//   記録の値で自動に決まった項目のあるスコア・診断基準（S…。段K4 の結果。AI に計算し直させない）。AI が根拠に使える記号は、これだけ。
//   長いときは、古い経過の出来事から、それでも長ければ古い値から落とし、落とした数を返す
// - AI の答えの形（SupportAnswer。構造化出力の上限の中：null になりうる欄・必須でない欄は 0）
// - 確かめ（checkSupport）：資料・出典にない記号を指す項目は出さない。識別情報の形は伏せる。資料にない用量・閾値・目標値らしい数は、
//   出典の引用がなければ出さない。資料にない点数は出さない。どれも黙って捨てず、理由ごとの数を返す。資料・出典に見つからない数には印（※。markNumbers）。
//   記録だけからの推し量り（出典の引用がない文・AI が推論と言った文）には「（推論）」を付ける
// - 組み直すかの印（supportBasis）：記録の印（listBasis）と、プロブレムリストを組んだ日時
import { z } from 'zod';

import { replaceShapes } from '../guard/shapes.ts';
import { rangeText, referenceMark } from '../labs/reference.ts';
import { ApRef, type RefSource } from '../notes/ap.ts';
import { type Backing, backingFrom, backingWith, markNumbers, type NumberMark, numbersOf } from '../notes/document.ts';
import { COURSE_CATEGORY_NAMES, MEDICATION_ACTION_NAMES, PROBLEM_STATUS_NAMES } from '../organize/answer.ts';
import { type MedicationFact, medicationTimeline } from '../organize/views.ts';
import type { PresetObservationRow } from '../presets/carte-facts.ts';
import { presetSources } from '../presets/library.ts';
import { latestDay, suggestedPresets } from '../presets/panel.ts';
import { itemAnswerText, resultView } from '../presets/results.ts';
import { LIST_ACTIVITY_NAMES, LIST_CERTAINTY_NAMES, type ListCourse, type ListItem, type ListThread, listBasis, numberedList } from '../problems/list.ts';
import { ageNow } from '../record/headline.ts';
import { ENCOUNTER_KIND_LABELS, type EncounterKind, SEX_LABELS, type Sex } from '../record/schema.ts';
import { compareDateTime } from '../time/datetime.ts';
import { type DayEvent, deviceDays, medicationDays } from '../views/days.ts';

// ---------------------------------------------------------------------------
// 上限

/** 1回の資料の長さの上限（字。JSON の長さ） */
export const SUPPORT_MATERIAL_MAX = 50_000;
/** 資料に入れる経過の出来事の数（新しいものから） */
export const SUPPORT_COURSE_MAX = 120;
/** 資料に入れる値の項目の数（新しく書かれた項目から） */
export const SUPPORT_VALUE_NAMES_MAX = 60;
/** 1つの項目に入れる値の数（新しいものから） */
export const SUPPORT_VALUES_PER_NAME = 3;
/** 外の検索（書籍・ネット）に渡す問題の名前の数（活動中の問題の、リストの並びの順） */
export const SUPPORT_RESEARCH_MAX = 5;
/** 支援を書く問題の数（活動中の問題の、リストの並びの順） */
export const SUPPORT_PROBLEMS_MAX = 12;
export const SUPPORT_DIFFERENTIALS_MAX = 6;
export const SUPPORT_TESTS_MAX = 8;
export const SUPPORT_GUIDELINE_MAX = 6;
export const SUPPORT_CRITERIA_MAX = 4;
export const SUPPORT_NAME_MAX = 80;
export const SUPPORT_TEXT_MAX = 400;
export const SUPPORT_NOTES_MAX = 600;

// ---------------------------------------------------------------------------
// 資料

export interface SupportInput {
  readonly patient: { readonly age: number; readonly ageOn: string; readonly sex: Sex };
  /** サーバーの今日（年齢の概算に使う） */
  readonly today: string;
  /** いちばん新しい受診（いまの受診） */
  readonly encounter: { readonly kind: EncounterKind; readonly start: string; readonly end: string | null };
  /** 記録の上で最後の日時（この受診。なければ null。薬・デバイスの日数を数える終わり） */
  readonly asOf: string | null;
  /** AI のプロブレムリスト（外したものを含めてよい。番号は numberedList） */
  readonly list: readonly ListItem[];
  /** 記録に書かれた問題の筋（listInputOf と同じ形） */
  readonly threads: readonly ListThread[];
  readonly course: readonly ListCourse[];
  /** この受診の測定値（外した値を除く） */
  readonly observations: readonly PresetObservationRow[];
  /** この受診の投薬（外したものを除く） */
  readonly medications: readonly MedicationFact[];
  /** この受診のできごと（外したものを除く） */
  readonly events: readonly DayEvent[];
}

/** 支援を書く問題（プロブレムリストの活動中の項目） */
export interface SupportTarget {
  readonly key: string;
  readonly no: number;
  readonly name: string;
  readonly certainty: ListItem['certainty'];
  /** guideline：診断がついている（照合が中心）・differential：まだ診断がついていない（疑う疾患と検査が中心） */
  readonly focus: SupportFocus;
}

export const SUPPORT_FOCUSES = ['differential', 'guideline'] as const;
export type SupportFocus = (typeof SUPPORT_FOCUSES)[number];
export const SUPPORT_FOCUS_NAMES: Readonly<Record<SupportFocus, string>> = { differential: '疑う疾患と確かめる検査', guideline: 'ガイドライン・標準治療との照合' };

export interface SupportMaterial {
  /** AI に送る資料（出典は supportMessage で足す） */
  readonly payload: Record<string, unknown>;
  /** 支援を書く問題（P1…。番号はリストの番号） */
  readonly targets: ReadonlyMap<string, SupportTarget>;
  /** プロブレムリストの、外していない項目の記号（P1…。活動中でないものを含む） */
  readonly listed: ReadonlySet<string>;
  /** 根拠に使える記号（T・C・V・M・D・S）と、画面に出す短い名前 */
  readonly refs: ReadonlyMap<string, string>;
  /** 資料の数（記録・値・薬・デバイス・スコア）。印（※）の照らし合わせ */
  readonly backing: Backing;
  /** 資料にある点数の字（「2点」など。段K4 の表の計算の結果だけ） */
  readonly points: readonly string[];
  /** 長さの上限で落とした数 */
  readonly dropped: { readonly course: number; readonly values: number };
  /** 外の検索に渡す、問題の名前（活動中の問題の名前だけ） */
  readonly problemNames: readonly string[];
}

const at = (x: string | null): string => (x === null ? '日時不明' : x.replace('T', ' '));

interface ValueGroup {
  readonly name: string;
  readonly kind: string;
  readonly values: readonly { readonly at: string | null; readonly text: string; readonly mark: 'H' | 'L' | null; readonly range: string | null; readonly source: string | null }[];
  readonly last: string | null;
}

function valueGroups(input: SupportInput, age: number): ValueGroup[] {
  const groups = new Map<string, PresetObservationRow[]>();
  for (const o of input.observations) {
    // 本人が外した値・AI が読んだ数で書かれた字に見つからないもの（unseen）は、資料にしない（スコアの計算と同じ）
    if (o.excluded === true || o.unseen === true) continue;
    const key = o.name ?? o.nameRaw;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return [...groups]
    .map(([name, list]) => {
      const sorted = [...list].sort((a, b) => compareDateTime(a.at, b.at)).slice(-SUPPORT_VALUES_PER_NAME);
      const values = sorted.map((o) => {
        // 段K3 の印：比べられるときだけ（比べないときは印なし。正常とはしない）
        const m = referenceMark({ name: o.name, value: o.value, comparator: o.comparator, unit: o.unit }, { age, sex: input.patient.sex });
        const mark = m.state === 'high' ? ('H' as const) : m.state === 'low' ? ('L' as const) : null;
        return {
          at: o.at,
          text: `${o.comparator ?? ''}${o.valueText}${o.unit === null ? '' : ` ${o.unit}`}`,
          mark,
          range: mark === null ? null : rangeText(m),
          source: mark === null ? null : (m.source?.title ?? null),
        };
      });
      return { name, kind: sorted.some((o) => o.kind === 'vital') ? 'バイタル' : '検査', values, last: sorted.at(-1)?.at ?? null };
    })
    .sort((a, b) => compareDateTime(a.last, b.last) || a.name.localeCompare(b.name))
    .slice(-SUPPORT_VALUE_NAMES_MAX);
}

const daysText = (d: { readonly day: number | null; readonly stoppedAt: string | null }): string | null =>
  d.day === null ? null : d.stoppedAt === null ? `開始から ${String(d.day)} 日目` : `${String(d.day)} 日間（中止まで）`;

export function supportMaterial(input: SupportInput): SupportMaterial {
  const age = ageNow(input.patient.age, input.patient.ageOn, input.today);
  const numbered = numberedList(input.list);
  const active = numbered.filter(({ item }) => item.activity === 'active');
  const targets = new Map<string, SupportTarget>(
    active.slice(0, SUPPORT_PROBLEMS_MAX).map(({ item, no }) => [
      `P${String(no)}`,
      { key: item.key, no, name: item.name, certainty: item.certainty, focus: item.certainty === 'diagnosis' ? 'guideline' : 'differential' },
    ]),
  );

  // 薬（段K1 の日数）・デバイス（段K1）・スコア（段K4。記録の値で自動に決まった項目があるものだけ）は、長さで落とさない
  const meds = medicationTimeline(input.medications).map((line) => {
    const last = line.entries.filter((e) => e.at !== null).at(-1) ?? line.entries.at(-1);
    return {
      name: line.name,
      last: `${at(last?.at ?? null)} ${last?.action === null || last?.action === undefined ? '動きの記載なし' : MEDICATION_ACTION_NAMES[last.action]}`,
      dose: last?.doseText ?? null,
      days: daysText(medicationDays(line.entries, input.asOf)),
    };
  });
  const devices = deviceDays(input.events, input.asOf).map((d) => ({
    name: d.name,
    placed: at(d.placedAt),
    removed: d.removedAt === null ? '抜去の記載なし' : at(d.removedAt),
    days: d.day === null ? null : d.removedAt === null ? `${String(d.day)} 日目` : `${String(d.day)} 日間`,
  }));
  const presetInput = {
    patient: input.patient,
    encounter: { kind: input.encounter.kind, start: input.encounter.start },
    observations: input.observations.filter((o) => o.excluded !== true),
    problems: [
      ...input.threads.filter((t) => t.group === 'current').map((t) => ({ name: t.name, source: 'problem' as const })),
      ...active.map(({ item }) => ({ name: item.name, source: 'ai' as const })),
    ],
  };
  const scores = suggestedPresets(presetInput, latestDay(presetInput, input.asOf))
    .filter((r) => r.evaluation.items.some((i) => i.source === 'auto' || i.source === 'record'))
    .map((r) => ({
      name: r.preset.name,
      day: r.day,
      result: resultView(r.preset, r.evaluation).headline,
      unknownItems: r.evaluation.unknownCount,
      items: r.evaluation.items
        .filter((i) => i.source === 'auto' || i.source === 'record')
        .map((i) => ({ label: i.label, answer: itemAnswerText(r.preset.items.find((x) => x.key === i.key), i), evidence: i.evidence })),
      confirmed: !r.preset.unconfirmed,
      sources: presetSources(r.preset).map((s) => s.title),
    }));

  // 長さの上限：古い経過の出来事から、それでも長ければ古い値の項目から落とす
  let course = [...input.course].sort((a, b) => compareDateTime(a.at, b.at)).slice(-SUPPORT_COURSE_MAX);
  let values = valueGroups(input, age);
  let droppedCourse = Math.max(0, input.course.length - SUPPORT_COURSE_MAX);
  let droppedValues = 0;

  const build = () => {
    const threadRefs = new Map(input.threads.map((t, i) => [`T${String(i + 1)}`, t]));
    const refOfThread = new Map([...threadRefs].map(([ref, t]) => [t.id, ref]));
    const courseRefs = new Map(course.map((c, i) => [`C${String(i + 1)}`, c]));
    const refOfCourse = new Map([...courseRefs].map(([ref, c]) => [`${c.sourceId}:${String(c.start)}`, ref]));
    const valueRefs = new Map(values.map((v, i) => [`V${String(i + 1)}`, v]));
    const medRefs = new Map(meds.map((m, i) => [`M${String(i + 1)}`, m]));
    const deviceRefs = new Map(devices.map((d, i) => [`D${String(i + 1)}`, d]));
    const scoreRefs = new Map(scores.map((s, i) => [`S${String(i + 1)}`, s]));
    const payload = {
      patient: { age, sex: SEX_LABELS[input.patient.sex] },
      encounter: { kind: ENCOUNTER_KIND_LABELS[input.encounter.kind], start: at(input.encounter.start), end: input.encounter.end === null ? null : at(input.encounter.end), asOf: input.asOf === null ? null : at(input.asOf) },
      problems: numbered.map(({ item, no }) => {
        const ref = `P${String(no)}`;
        const target = targets.get(ref);
        return {
          ref,
          name: item.name,
          certainty: LIST_CERTAINTY_NAMES[item.certainty],
          activity: LIST_ACTIVITY_NAMES[item.activity],
          since: item.since === null ? null : at(item.since),
          support: target === undefined ? '書かない' : SUPPORT_FOCUS_NAMES[target.focus],
          threads: item.threadIds.map((id) => refOfThread.get(id)).filter((r): r is string => r !== undefined),
          course: item.course.map((p) => refOfCourse.get(`${p.sourceId}:${String(p.start)}`)).filter((r): r is string => r !== undefined),
          basis: item.basis,
        };
      }),
      threads: [...threadRefs].map(([ref, t]) => ({ ref, name: t.name, written: PROBLEM_STATUS_NAMES[t.status], first: t.first === null ? null : at(t.first), last: t.last === null ? null : at(t.last), lastNote: t.lastNote })),
      course: [...courseRefs].map(([ref, c]) => ({ ref, at: at(c.at), approx: c.atApprox, category: COURSE_CATEGORY_NAMES[c.category], summary: c.summary })),
      values: [...valueRefs].map(([ref, v]) => ({
        ref,
        name: v.name,
        kind: v.kind,
        values: v.values.map((x) => ({ at: at(x.at), value: x.text, ...(x.mark === null ? {} : { reference: `${x.mark}（基準範囲 ${x.range ?? ''}・${x.source ?? '出典不明'}。未確認の目安）` }) })),
      })),
      medications: [...medRefs].map(([ref, m]) => ({ ref, ...m })),
      devices: [...deviceRefs].map(([ref, d]) => ({ ref, ...d })),
      scores: [...scoreRefs].map(([ref, s]) => ({ ref, ...s })),
    };
    return { payload, threadRefs, courseRefs, valueRefs, medRefs, deviceRefs, scoreRefs };
  };

  let built = build();
  while (JSON.stringify(built.payload).length > SUPPORT_MATERIAL_MAX) {
    if (course.length > 0) {
      course = course.slice(1);
      droppedCourse += 1;
    } else if (values.length > 0) {
      values = values.slice(1);
      droppedValues += 1;
    } else break;
    built = build();
  }

  const refs = new Map<string, string>();
  for (const [ref, t] of built.threadRefs) refs.set(ref, `記録の問題「${t.name}」`);
  for (const [ref, c] of built.courseRefs) refs.set(ref, `経過 ${at(c.at)}${c.atApprox === null ? '' : `（${c.atApprox}）`} ${c.summary}`);
  for (const [ref, v] of built.valueRefs) {
    const last = v.values.at(-1);
    refs.set(ref, `値 ${v.name} ${last?.text ?? ''}${last?.mark === null || last?.mark === undefined ? '' : `【${last.mark}】`}（${at(last?.at ?? null)}）`);
  }
  for (const [ref, m] of built.medRefs) refs.set(ref, `薬 ${m.name}${m.days === null ? '' : `（${m.days}）`}`);
  for (const [ref, d] of built.deviceRefs) refs.set(ref, `デバイス ${d.name}${d.days === null ? '' : `（${d.days}）`}`);
  for (const [ref, s] of built.scoreRefs) refs.set(ref, `スコア・基準 ${s.name} ${s.result}`);

  // 照らし合わせの数：本文（名前・要約・値・薬・デバイス・スコア・年齢）と、日時
  const body = [
    String(age),
    ...numbered.flatMap(({ item }) => [item.name, item.basis]),
    ...input.threads.flatMap((t) => [t.name, t.lastNote]),
    ...[...built.courseRefs.values()].map((c) => c.summary),
    ...[...built.valueRefs.values()].flatMap((v) => [v.name, ...v.values.flatMap((x) => [x.text, x.range ?? ''])]),
    ...meds.flatMap((m) => [m.name, m.dose ?? '', m.days ?? '']),
    ...devices.flatMap((d) => [d.name, d.days ?? '']),
    ...scores.flatMap((s) => [s.name, s.result, ...s.items.flatMap((i) => [i.label, i.answer, ...i.evidence])]),
  ];
  const when = [
    input.encounter.start,
    input.encounter.end ?? '',
    input.asOf ?? '',
    ...numbered.map(({ item }) => item.since ?? ''),
    ...input.threads.flatMap((t) => [t.first ?? '', t.last ?? '']),
    ...[...built.courseRefs.values()].map((c) => c.at ?? ''),
    ...[...built.valueRefs.values()].flatMap((v) => v.values.map((x) => x.at ?? '')),
    ...meds.map((m) => m.last),
    ...devices.flatMap((d) => [d.placed, d.removed]),
    ...scores.map((s) => s.day),
  ];
  const points = [...new Set(scores.flatMap((s) => [s.result, ...s.items.map((i) => i.answer)]).flatMap(pointsIn))];
  return {
    payload: built.payload,
    targets,
    listed: new Set(numbered.map(({ no }) => `P${String(no)}`)),
    refs,
    backing: backingFrom(body, when),
    points,
    dropped: { course: droppedCourse, values: droppedValues },
    problemNames: active.slice(0, SUPPORT_RESEARCH_MAX).map(({ item }) => item.name),
  };
}

/** AI に送る文（JSON）：資料と、出典（書籍・ネット）の抜き出し */
export function supportMessage(material: SupportMaterial, refs: readonly RefSource[]): string {
  return JSON.stringify({ ...material.payload, references: refs.map((r) => ({ id: r.id, kind: r.kind === 'book' ? '書籍' : 'ネット', label: r.label, text: r.text })) });
}

// ---------------------------------------------------------------------------
// AI の答えの形（構造化出力。null になりうる欄・必須でない欄を作らない：足りない情報がなければ ""、記号がなければ []）

export const GUIDELINE_STATUSES = ['consistent', 'gap', 'unclear'] as const;
export type GuidelineStatus = (typeof GUIDELINE_STATUSES)[number];
export const GUIDELINE_STATUS_NAMES: Readonly<Record<GuidelineStatus, string>> = { consistent: '沿っている', gap: '差がある', unclear: '分からない' };

const Ids = z.array(z.string());
export const SupportAnswer = z.object({
  problems: z.array(
    z.object({
      /** 問題の記号（P1…） */
      problem: z.string(),
      differentials: z.array(z.object({ name: z.string(), reasoning: z.string(), support: Ids, against: Ids, missing: z.string(), citations: Ids, inference: z.boolean() })),
      tests: z.array(z.object({ name: z.string(), why: z.string(), support: Ids, citations: Ids, inference: z.boolean() })),
      guideline: z.array(z.object({ statement: z.string(), status: z.enum(GUIDELINE_STATUSES), support: Ids, citations: Ids, inference: z.boolean() })),
      /** 表にない基準・スコアの補い（出典の引用があるときだけ。点数・閾値を計算しない） */
      criteria: z.array(z.object({ name: z.string(), statement: z.string(), citations: Ids })),
      notes: z.string(),
    }),
  ),
});
export type SupportAnswer = z.infer<typeof SupportAnswer>;

// ---------------------------------------------------------------------------
// 確かめた後の形（保存する形）

/** 印のついた文（字は変えない。marks は、資料・出典に見つからない数の場所） */
export const MarkedText = z.object({ text: z.string(), marks: z.array(z.object({ start: z.number(), end: z.number() })) });
export type MarkedText = z.infer<typeof MarkedText>;
/** 根拠にした資料（記号は組み直すと変わるので、画面に出す短い名前で残す。本文は残さない） */
export const SupportPoint = z.object({ id: z.string(), label: z.string() });
export type SupportPoint = z.infer<typeof SupportPoint>;

const Differential = z.object({ name: z.string(), reasoning: MarkedText, support: z.array(SupportPoint), against: z.array(SupportPoint), missing: MarkedText, citations: z.array(ApRef) });
const Test = z.object({ name: z.string(), why: MarkedText, support: z.array(SupportPoint), citations: z.array(ApRef) });
const Guideline = z.object({ statement: MarkedText, status: z.enum(GUIDELINE_STATUSES), support: z.array(SupportPoint), citations: z.array(ApRef) });
const Criterion = z.object({ name: z.string(), statement: MarkedText, citations: z.array(ApRef) });

export const SupportProblem = z.object({
  key: z.string(),
  no: z.number(),
  name: z.string(),
  focus: z.enum(SUPPORT_FOCUSES),
  differentials: z.array(Differential),
  tests: z.array(Test),
  guideline: z.array(Guideline),
  criteria: z.array(Criterion),
  notes: MarkedText,
});
export type SupportProblem = z.infer<typeof SupportProblem>;

export const SUPPORT_REJECT_REASONS = ['unknown_problem', 'not_active', 'duplicate', 'unknown_ref', 'ungrounded', 'dose', 'score', 'no_citation', 'focus', 'empty', 'too_many'] as const;
export type SupportRejectReason = (typeof SUPPORT_REJECT_REASONS)[number];
export const SUPPORT_REJECT_NAMES: Readonly<Record<SupportRejectReason, string>> = {
  unknown_problem: '資料にない問題を指していた',
  not_active: '活動中でない問題だった',
  duplicate: '同じ問題が重なった',
  unknown_ref: '資料・出典にない記号を指していた',
  ungrounded: '記録のどれにも結びつかなかった',
  dose: '資料にない用量・閾値・目標値らしい数があり、出典の引用がなかった',
  score: '資料にない点数を書いていた（点数は表から計算します）',
  no_citation: '表にない基準の補いに、出典の引用がなかった',
  focus: '診断がついている問題の「疑う疾患」だった（照合だけを出します）',
  empty: '中身がなかった',
  too_many: '多すぎた',
};

export const SupportBody = z.object({
  problems: z.array(SupportProblem),
  rejected: z.partialRecord(z.enum(SUPPORT_REJECT_REASONS), z.number()),
  /** 伏せた識別情報の形の数 */
  shapes: z.number(),
  /** 資料にした出典の数と、ネットの検索ができなかったか */
  research: z.object({ books: z.number(), web: z.number(), webFailed: z.boolean() }),
  /** 長さの上限で落とした資料の数 */
  dropped: z.object({ course: z.number(), values: z.number() }),
});
export type SupportBody = z.infer<typeof SupportBody>;

/** 組み直す頼み（ネットの出典も探すか。書籍は設定があるとき、いつも） */
export const SupportRequest = z.strictObject({ web: z.boolean() });
export type SupportRequest = z.infer<typeof SupportRequest>;

// ---------------------------------------------------------------------------
// 確かめ

const NUM = '[0-9０-９]+(?:[.．][0-9０-９]+)?';
/** 用量らしい数（数と、量・単位。「/dL」「/L」などの濃度の単位が続くものは、検査値の書き方なので除く） */
const DOSE_RE = new RegExp(`(${NUM})\\s*(?:mg|ｍｇ|μg|µg|mcg|ng|g|ｇ|mL|ml|ｍＬ|L|単位|IU|U|mEq|mmol|γ|錠|包|カプセル|アンプル|バイアル)(?![A-Za-zμµ]*\\s*/\\s*(?:dL|dl|L|l|mL|ml|μL|µL|mm3|HPF|hpf|kg|日|回|時|h|hr|分|min))`, 'gu');
/** 用量の速さ・体重あたり（mg/kg・g/日・mL/h など。上の濃度の除外より先に拾う） */
const RATE_RE = new RegExp(`(${NUM})\\s*(?:mg|μg|µg|mcg|g|mL|ml|単位|IU|U|mEq|mmol|γ)\\s*/\\s*(?:kg|日|回|時|h|hr|分|min)`, 'gu');
/** 閾値らしい数（不等号の後の数・「以上」「未満」などの前の数） */
const THRESHOLD_RE = new RegExp(`(?:[<>≦≧≤≥＜＞]=?\\s*(${NUM}))|(?:(${NUM})[^\\s、。，,（）()]{0,10}?\\s*(?:以上|以下|未満|を超え|を下回|を上回|を目標|に保))`, 'gu');
/** 点数らしい字（「点滴」は除く） */
const POINTS_RE = new RegExp(`${NUM}\\s*点(?!滴)`, 'gu');

const norm = (token: string): string => numbersOf(token)[0] ?? token;
/** 文の中の点数らしい字（「2点」。表の計算にない点数を、AI に書かせないための照らし合わせ） */
export function pointsIn(text: string): string[] {
  return [...text.matchAll(POINTS_RE)].map((m) => `${norm(m[0])}点`);
}

/** 用量・閾値・目標値らしい数のうち、資料にないもの（出典の引用があれば、出してよい） */
export function newDoseNumbers(text: string, backing: Backing): string[] {
  const body = new Set(backing.body);
  const found = [
    ...[...text.matchAll(DOSE_RE)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(RATE_RE)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(THRESHOLD_RE)].map((m) => m[1] ?? m[2] ?? ''),
    // 「目標」の字がある文の数は、すべて目標値らしい数として見る
    ...(text.includes('目標') ? numbersOf(text) : []),
  ]
    .filter((t) => t !== '')
    .map(norm);
  return [...new Set(found.filter((n) => !body.has(n)))];
}

export interface CheckedSupport {
  readonly problems: readonly SupportProblem[];
  readonly rejected: Partial<Record<SupportRejectReason, number>>;
  readonly shapes: number;
}

const INFERENCE = '（推論）';

/**
 * AI の答えを確かめる。citations は、資料にした出典（書籍 B…・ネット W…）
 */
export function checkSupport(answer: SupportAnswer, material: SupportMaterial, citations: readonly RefSource[]): CheckedSupport {
  const rejected: Partial<Record<SupportRejectReason, number>> = {};
  const count = (r: SupportRejectReason, n = 1): void => {
    if (n > 0) rejected[r] = (rejected[r] ?? 0) + n;
  };
  let shapes = 0;
  const backing = backingWith(material.backing, citations);
  const points = new Set(material.points);
  const citationOf = new Map(citations.map((c) => [c.id, c]));
  const clean = (text: string, max: number): string => {
    const r = replaceShapes(text.replace(/[ \t\u3000]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim());
    shapes += Object.values(r.counts).reduce((n, c) => n + c, 0);
    return r.text.slice(0, max);
  };
  const marked = (text: string, inference: boolean): MarkedText => {
    const t = text !== '' && inference && !text.includes(INFERENCE) ? `${text}${INFERENCE}` : text;
    return { text: t, marks: markNumbers(t, backing).map((m: NumberMark) => ({ start: m.start, end: m.end })) };
  };
  const known = (ids: readonly string[]): boolean => ids.every((id) => material.refs.has(id));
  const cited = (ids: readonly string[]): boolean => ids.every((id) => citationOf.has(id));
  const pointRefs = (ids: readonly string[]): SupportPoint[] => [...new Set(ids)].map((id) => ({ id, label: material.refs.get(id) ?? id }));
  const refsOf = (ids: readonly string[]): ApRef[] => [...new Set(ids)].flatMap((id) => {
    const c = citationOf.get(id);
    return c === undefined ? [] : [c.ref];
  });
  /** 1つの項目の共通の確かめ：記号・用量と閾値・点数。通らなければ理由 */
  const gate = (texts: readonly string[], ids: readonly string[], cites: readonly string[]): SupportRejectReason | null => {
    if (!known(ids) || !cited(cites)) return 'unknown_ref';
    const all = texts.join('\n');
    if (cites.length === 0 && newDoseNumbers(all, material.backing).length > 0) return 'dose';
    if (pointsIn(all).some((p) => !points.has(p))) return 'score';
    return null;
  };

  const seen = new Set<string>();
  const out: SupportProblem[] = [];
  for (const p of answer.problems) {
    const target = material.targets.get(p.problem);
    if (target === undefined) {
      count(material.listed.has(p.problem) ? 'not_active' : 'unknown_problem');
      continue;
    }
    if (seen.has(p.problem)) {
      count('duplicate');
      continue;
    }
    seen.add(p.problem);

    const differentials: SupportProblem['differentials'] = [];
    for (const d of p.differentials) {
      if (target.focus === 'guideline') {
        count('focus');
        continue;
      }
      const name = clean(d.name, SUPPORT_NAME_MAX);
      const reasoning = clean(d.reasoning, SUPPORT_TEXT_MAX);
      const missing = clean(d.missing, SUPPORT_TEXT_MAX);
      if (name === '') {
        count('empty');
        continue;
      }
      const why = gate([name, reasoning, missing], [...d.support, ...d.against], d.citations);
      if (why !== null) {
        count(why);
        continue;
      }
      if (d.support.length === 0) {
        count('ungrounded');
        continue;
      }
      if (differentials.length >= SUPPORT_DIFFERENTIALS_MAX) {
        count('too_many');
        continue;
      }
      const inference = d.inference || d.citations.length === 0;
      differentials.push({ name, reasoning: marked(reasoning, inference), support: pointRefs(d.support), against: pointRefs(d.against), missing: marked(missing, false), citations: refsOf(d.citations) });
    }

    const tests: SupportProblem['tests'] = [];
    for (const t of p.tests) {
      const name = clean(t.name, SUPPORT_NAME_MAX);
      const why = clean(t.why, SUPPORT_TEXT_MAX);
      if (name === '') {
        count('empty');
        continue;
      }
      const reason = gate([name, why], t.support, t.citations);
      if (reason !== null) {
        count(reason);
        continue;
      }
      if (tests.length >= SUPPORT_TESTS_MAX) {
        count('too_many');
        continue;
      }
      tests.push({ name, why: marked(why, t.inference || t.citations.length === 0), support: pointRefs(t.support), citations: refsOf(t.citations) });
    }

    const guideline: SupportProblem['guideline'] = [];
    for (const g of p.guideline) {
      const statement = clean(g.statement, SUPPORT_TEXT_MAX);
      if (statement === '') {
        count('empty');
        continue;
      }
      const reason = gate([statement], g.support, g.citations);
      if (reason !== null) {
        count(reason);
        continue;
      }
      // 何と照らしたか（記録のどこ）が分からない照合は出さない
      if (g.support.length === 0) {
        count('ungrounded');
        continue;
      }
      if (guideline.length >= SUPPORT_GUIDELINE_MAX) {
        count('too_many');
        continue;
      }
      guideline.push({ statement: marked(statement, g.inference || g.citations.length === 0), status: g.status, support: pointRefs(g.support), citations: refsOf(g.citations) });
    }

    const criteria: SupportProblem['criteria'] = [];
    for (const c of p.criteria) {
      const name = clean(c.name, SUPPORT_NAME_MAX);
      const statement = clean(c.statement, SUPPORT_TEXT_MAX);
      if (name === '' || statement === '') {
        count('empty');
        continue;
      }
      const reason = gate([name, statement], [], c.citations);
      if (reason !== null) {
        count(reason);
        continue;
      }
      // 表にない基準の補いは、出典の引用があるときだけ
      if (c.citations.length === 0) {
        count('no_citation');
        continue;
      }
      if (criteria.length >= SUPPORT_CRITERIA_MAX) {
        count('too_many');
        continue;
      }
      criteria.push({ name, statement: marked(statement, false), citations: refsOf(c.citations) });
    }

    let notesText = clean(p.notes, SUPPORT_NOTES_MAX);
    if (notesText !== '' && (newDoseNumbers(notesText, material.backing).length > 0 || pointsIn(notesText).some((x) => !points.has(x)))) {
      count(newDoseNumbers(notesText, material.backing).length > 0 ? 'dose' : 'score');
      notesText = '';
    }
    if (differentials.length + tests.length + guideline.length + criteria.length === 0 && notesText === '') continue;
    out.push({ key: target.key, no: target.no, name: target.name, focus: target.focus, differentials, tests, guideline, criteria, notes: marked(notesText, false) });
  }
  out.sort((a, b) => a.no - b.no);
  return { problems: out, rejected, shapes };
}

/** 支援の元になった記録の印：記録の印（listBasis）と、プロブレムリストを組んだ日時（リストを組み直したら、支援も組み直す） */
export function supportBasis(sources: Parameters<typeof listBasis>[0], listMadeAt: string | null): string {
  return `${listBasis(sources)}|${listMadeAt ?? '-'}`;
}
