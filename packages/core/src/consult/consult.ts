// 段M：相談の窓口（CA-081。2026-11-24）。先生が、この患者について何でも相談する（全体の方針・いまのアセスメント・確かめる検査・治療の方針・小さな疑問）と、
// carte が持っている記録（保存した文と、整理した事実・プロブレムリスト・スコア）と、書籍（RAG）・ネットの出典から、AI が答える。
// 臨床支援の決まり（CA-059）は、そのまま：最終判断は先生。AI に点数・閾値を計算させない。資料と出典にない用量・閾値・目標値は出さない。
// 出典の引用に基づかない文には「（推論）」。資料・出典に見つからない数には印（※）。識別情報の形は伏せる。
//
// この組は純関数：
// - 資料（consultMaterial）：臨床支援の資料（supportMaterial：プロブレムリスト P・筋 T・経過の出来事 C・値 V・薬 M・デバイス D・スコア S）と、
//   記録に聞くの資料（askMaterial）の記載の全文（R）・できごと（E）を、1つに合わせる。記号は重ならない
// - 外の検索に渡す語（cleanTerms）：AI が問いから取り出した一般的な語を、決定論で確かめる（数字・識別情報の形・文・年齢や病日の字のある語は渡さない）。
//   問いの文そのものは、外の検索に渡さない（CA-035 の改訂：問題の名前に加えて、この語だけ）
// - AI の答えの形（ConsultAnswer・ConsultTermsAnswer。構造化出力の上限の中：null になりうる欄・必須でない欄は 0）
// - 確かめ（checkConsult）と、残す文（consultNoteText・askNoteText）。残すのは、先生が「残す」を押した答えだけ（問いの文は残さない。CA-032 の改訂）
// 段M2（CA-082〜CA-085。2026-11-24）で足したもの：
// - 答えを、確かめた文から順に出す（CA-085）：書いている途中の JSON から、書き終えた文だけを取り出し（partialStatements）、
//   1つずつ同じ確かめ（checkConsultStatement）を通す。確かめる前の字は、画面に出さない
// - 前の受診の記録も資料にする（CA-084）・残した答えを直す（CA-083。選別を通す。「先生が直した」の印）・
//   答えの文を、記載の下書きと指示簿へ入れる（CA-082。先生が1つずつ押したものだけ。指示簿へは「AI の案」の印）
import { z } from 'zod';

import { type AskInput, askMaterial, type AskReply } from '../ask/ask.ts';
import { findShapes, replaceShapes } from '../guard/shapes.ts';
import { ApRef, type RefSource } from '../notes/ap.ts';
import { type Backing, backingWith, markNumbers } from '../notes/document.ts';
import { ORDER_BASIS_LABEL_MAX, ORDER_BASIS_MAX, ORDER_TEXT_MAX, type OrderCategory, type OrderNew } from '../orders/orders.ts';
import { numberedList } from '../problems/list.ts';
import { newDoseNumbers, pointsIn, type SupportInput, supportMaterial } from '../support/support.ts';

// ---------------------------------------------------------------------------
// 上限

/** 問いの長さの上限 */
export const CONSULT_QUESTION_MAX = 800;
/** 続きの相談で、一緒に送る前のやりとりの数（新しいものから）と、1つの長さ */
export const CONSULT_TURNS_MAX = 6;
export const CONSULT_TURN_TEXT_MAX = 3000;
/** 記載の全文の分の、資料の長さの上限（字。JSON の長さ。ほかに、臨床支援の資料の分がある） */
export const CONSULT_RECORDS_MAX = 40_000;
/** 前の受診の記録も資料にするとき（CA-084）の、記載の分の上限 */
export const CONSULT_RECORDS_PAST_MAX = 70_000;
/** 答えの文の数と、1つの文の長さ */
export const CONSULT_STATEMENTS_MAX = 18;
export const CONSULT_TEXT_MAX = 600;
/** 答えられなかったことの文の長さ */
export const CONSULT_UNKNOWN_MAX = 400;
/** 1つの文の根拠・出典の数 */
export const CONSULT_REFS_MAX = 8;
/** 外の検索に渡す、問いの一般的な語の数と、1つの長さ */
export const CONSULT_TERMS_MAX = 5;
export const CONSULT_TERM_MAX = 30;
/** 外の検索に渡す、問題の名前の数（プロブレムリストがないときの、記録に書かれたいまの問題の名前） */
export const CONSULT_NAMES_MAX = 5;
/** 残す答えの長さと、参照の数 */
export const CONSULT_NOTE_MAX = 6000;
export const CONSULT_NOTE_REFS_MAX = 20;

// ---------------------------------------------------------------------------
// 答えの区分（見出し。並びは、この順）

export const CONSULT_SECTIONS = ['summary', 'assessment', 'workup', 'treatment', 'caution', 'other'] as const;
export type ConsultSection = (typeof CONSULT_SECTIONS)[number];
export const CONSULT_SECTION_NAMES: Readonly<Record<ConsultSection, string>> = {
  summary: '要点',
  assessment: 'アセスメント',
  workup: '確かめる検査・情報',
  treatment: '治療・方針',
  caution: '注意すること',
  other: 'そのほか',
};

// ---------------------------------------------------------------------------
// 資料

export interface ConsultInput {
  /** 臨床支援と同じ資料の入力（いまの受診。外した事実を除く） */
  readonly support: SupportInput;
  /** 記録に聞くと同じ資料の入力（いまの受診と直前の救急の受診。外した事実を除く） */
  readonly ask: AskInput;
}

export interface ConsultMaterial {
  readonly payload: Record<string, unknown>;
  /** 根拠に使える記号（P・T・C・V・M・D・S・R・E）と、画面に出す短い名前 */
  readonly refs: ReadonlyMap<string, string>;
  readonly backing: Backing;
  /** 資料にある点数の字（表の計算の結果だけ） */
  readonly points: readonly string[];
  /** 外の検索に渡す、問題の名前（活動中の問題。リストがなければ、記録に書かれたいまの問題） */
  readonly problemNames: readonly string[];
  /** 記載の記号（R…）と、その文の id（画面で、根拠の記載を開くため） */
  readonly recordSources: ReadonlyMap<string, string>;
  /** 資料にした記載の数（0 なら、AI を呼ばない） */
  readonly records: number;
  /** 記載の範囲にした受診の数（前の受診も資料にしたときは、患者のすべての受診） */
  readonly encounters: number;
  readonly dropped: { readonly records: number; readonly shortened: number; readonly values: number; readonly course: number };
}

const uniq = (list: readonly string[]): string[] => [...new Set(list)];

/** past は、前の受診の記録も資料にするか（CA-084。記載とできごとの範囲を、患者のすべての受診に広げる。値・薬・スコアは、いまの受診のまま） */
export function consultMaterial(input: ConsultInput, options: { readonly past?: boolean } = {}): ConsultMaterial {
  const past = options.past === true;
  const support = supportMaterial(input.support);
  // 記載の全文（R）とできごと（E）だけを使う（値・薬・経過の出来事は、臨床支援の資料の側にある：記号を重ねない）
  const ask = askMaterial({ ...input.ask, medications: [], observations: [], course: [] }, { max: past ? CONSULT_RECORDS_PAST_MAX : CONSULT_RECORDS_MAX, allEncounters: past });
  const refs = new Map<string, string>(support.refs);
  for (const { item, no } of numberedList(input.support.list)) refs.set(`P${String(no)}`, `プロブレム #${String(no)} ${item.name}`);
  const recordSources = new Map<string, string>();
  for (const [id, target] of ask.refs) {
    if (target.kind !== 'record' && target.kind !== 'event') continue;
    refs.set(id, target.kind === 'record' ? `記載 ${target.label}` : target.label);
    if (target.kind === 'record') recordSources.set(id, target.sourceId);
  }
  const fallbackNames = input.support.threads.filter((t) => t.group === 'current').map((t) => t.name);
  return {
    payload: { ...support.payload, ...(past ? { encounters: ask.payload['encounters'] } : {}), records: ask.payload['records'], events: ask.payload['events'] },
    refs,
    backing: { body: uniq([...support.backing.body, ...ask.backing.body]), when: uniq([...support.backing.when, ...ask.backing.when]) },
    points: support.points,
    problemNames: (support.problemNames.length > 0 ? support.problemNames : fallbackNames).slice(0, CONSULT_NAMES_MAX),
    recordSources,
    records: recordSources.size,
    encounters: Array.isArray(ask.payload['encounters']) ? ask.payload['encounters'].length : 0,
    dropped: { records: ask.dropped.records, shortened: ask.dropped.shortened, values: support.dropped.values, course: support.dropped.course },
  };
}

/** 前のやりとり（画面のメモリから。保存しない） */
export interface ConsultTurn {
  readonly question: string;
  readonly answer: string;
}

/** AI に送る文（JSON）：資料・出典の抜き出し・前のやりとり・先生の問い */
export function consultMessage(material: ConsultMaterial, citations: readonly RefSource[], question: string, turns: readonly ConsultTurn[]): string {
  return JSON.stringify({
    ...material.payload,
    references: citations.map((r) => ({ id: r.id, kind: r.kind === 'book' ? '書籍' : 'ネット', label: r.label, text: r.text })),
    conversation: turns.map((t) => ({ question: t.question, answer: t.answer })),
    question,
  });
}

/** 外の検索の語を取り出す係に送る文（JSON）：問いと、問題の名前だけ（記録は送らない） */
export function consultTermsMessage(question: string, problemNames: readonly string[]): string {
  return JSON.stringify({ problems: problemNames, question });
}

// ---------------------------------------------------------------------------
// AI の答えの形（記号がなければ []、書くことがなければ ""。null を使わない）

const Ids = z.array(z.string());
export const ConsultAnswer = z.object({
  statements: z.array(
    z.object({
      section: z.enum(CONSULT_SECTIONS),
      text: z.string(),
      /** 記録の記号（P・T・C・V・M・D・S・R・E） */
      support: Ids,
      /** 出典の記号（B・W） */
      citations: Ids,
    }),
  ),
  /** 資料と出典からは答えられなかったこと（なければ ""） */
  unknown: z.string(),
});
export type ConsultAnswer = z.infer<typeof ConsultAnswer>;

export const ConsultTermsAnswer = z.object({ terms: z.array(z.string()) });
export type ConsultTermsAnswer = z.infer<typeof ConsultTermsAnswer>;

/** 相談の頼み（打った字と、画面のメモリの前のやりとり。どれも保存しない） */
export const ConsultRequest = z.strictObject({
  question: z.string().trim().min(1).max(CONSULT_QUESTION_MAX),
  turns: z.array(z.strictObject({ question: z.string().max(CONSULT_QUESTION_MAX), answer: z.string().max(CONSULT_TURN_TEXT_MAX) })).max(CONSULT_TURNS_MAX),
  /** ネットの出典も探すか（書籍は、設定があるとき、いつも） */
  web: z.boolean(),
  /** 前の受診の記録も資料にするか（CA-084） */
  past: z.boolean(),
  /** 答えを、確かめた文から順に受け取るか（CA-085。画面は、いつも true） */
  stream: z.boolean().optional(),
});
export type ConsultRequest = z.infer<typeof ConsultRequest>;

/** 問い・前のやりとりに、識別情報の形（電話・メールなど）があれば送らない（画面とサーバーが、同じ関数で止める） */
export function consultHasShapes(request: Pick<ConsultRequest, 'question' | 'turns'>): boolean {
  return [request.question, ...request.turns.flatMap((t) => [t.question, t.answer])].some((t) => findShapes(t).length > 0);
}

// ---------------------------------------------------------------------------
// 外の検索に渡す語（CA-035 の改訂）：AI が問いから取り出した語を、決定論で確かめる。通らない語は渡さない

/** 症例に固有の値らしい字（年齢・病日・日数・時刻の言い方）。数字のある語は、これとは別に、すべて渡さない */
const CASE_WORDS = /歳|才|病日|日目|日前|時間前|週間前|か月前|ヶ月前|年前|昨日|今日|本日|明日|今朝|昨夜/u;
/** 語に使ってよい字だけ：文字（かな・漢字・英字）と、長音・中黒・ハイフン・斜線・空白。数字・記号・句読点のある語は渡さない */
const TERM_SHAPE = /^[\p{L}\p{M}ー・\-/ ]+$/u;

/**
 * 外の検索（書籍・ネット）に渡してよい語だけを残す：2〜30 字・文字と少しの区切りだけ（数字・記号・句読点なし。漢数字の並びも渡さない）・
 * 識別情報の形なし・年齢や病日などの字なし・空白は3つまで（英語の病名）。同じ語は1つ。CONSULT_TERMS_MAX 個まで
 */
export function cleanTerms(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const term = r.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (term.length < 2 || term.length > CONSULT_TERM_MAX) continue;
    if (/[0-9]/u.test(term) || /[〇一二三四五六七八九十百千]{2,}/u.test(term)) continue;
    if (!TERM_SHAPE.test(term) || CASE_WORDS.test(term)) continue;
    if ((term.match(/ /gu) ?? []).length > 3) continue;
    if (findShapes(term).length > 0) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= CONSULT_TERMS_MAX) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 確かめた後の形（画面に返す形。保存しない）

export interface ConsultStatement {
  readonly section: ConsultSection;
  /** 出典の引用に基づかない文には、末尾に「（推論）」 */
  readonly text: string;
  /** 資料・出典に見つからない数の場所（※） */
  readonly marks: readonly { readonly start: number; readonly end: number }[];
  /** 出典（書籍・ネット）の引用に基づかない */
  readonly inferred: boolean;
  /** 根拠にした記録（記号と、画面に出す短い名前。記載なら、その文の id：画面で開ける） */
  readonly support: readonly { readonly id: string; readonly label: string; readonly sourceId: string | null }[];
  /** 出典（題・頁・URL。本文は持たない） */
  readonly citations: readonly ApRef[];
}

export const CONSULT_REJECT_REASONS = ['unknown_ref', 'dose', 'score', 'empty', 'too_many'] as const;
export type ConsultRejectReason = (typeof CONSULT_REJECT_REASONS)[number];
export const CONSULT_REJECT_NAMES: Readonly<Record<ConsultRejectReason, string>> = {
  unknown_ref: '資料・出典にない記号を指していた根拠',
  dose: '資料と出典にない用量・閾値・目標値のあった文',
  score: '表の計算にない点数のあった文',
  empty: '中身がなかった文',
  too_many: '多すぎた文',
};

export interface CheckedConsult {
  readonly statements: readonly ConsultStatement[];
  readonly unknown: string;
  readonly rejected: Partial<Record<ConsultRejectReason, number>>;
  /** 伏せた識別情報の形の数 */
  readonly shapes: number;
}

/** 画面に返す答え（確かめた後の答えと、探した出典・外の検索に渡した語・落とした資料の数） */
export interface ConsultReply extends CheckedConsult {
  readonly research: {
    readonly books: number;
    readonly web: number;
    readonly webFailed: boolean;
    /** 外の検索に渡した語（問題の名前と、問いの一般的な語。何を外へ出したかを、いつも見せる） */
    readonly names: readonly string[];
    readonly terms: readonly string[];
  };
  readonly dropped: ConsultMaterial['dropped'];
  /** 資料にした記載の数と、その範囲の受診の数 */
  readonly scope: { readonly records: number; readonly encounters: number; readonly past: boolean };
}

const INFERENCE = '（推論）';

/** AI の答えの文の1つ（確かめる前） */
export type RawConsultStatement = ConsultAnswer['statements'][number];
const RawStatement = ConsultAnswer.shape.statements.element;

export interface ConsultStatementCheck {
  /** 出してよい文（確かめた後）。出さないときは null */
  readonly statement: ConsultStatement | null;
  /** 数える理由（根拠から外した記号は、文を出しても数える） */
  readonly reasons: readonly ConsultRejectReason[];
  /** 伏せた識別情報の形の数 */
  readonly shapes: number;
}

function cleanText(text: string, max: number): { text: string; shapes: number } {
  const r = replaceShapes(text.replace(/[ \t\u3000]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim());
  return { text: r.text.slice(0, max), shapes: Object.values(r.counts).reduce((n, c) => n + c, 0) };
}

/**
 * 答えの文を1つ確かめる（checkConsult と、少しずつ出すとき〔CA-085〕が、同じ関数を使う）。citations は、資料にした出典（書籍 B…・ネット W…）。
 * - 資料・出典にない記号は、根拠から外して数える（文は残す）
 * - 資料にない用量・閾値・目標値らしい数のある文は、出典の引用がなければ出さない（CA-059）。表の計算にない点数のある文は出さない
 * - 出典の引用のない文には「（推論）」。資料・出典に見つからない数には印（※）。識別情報の形は伏せる
 */
export function checkConsultStatement(raw: RawConsultStatement, material: ConsultMaterial, citations: readonly RefSource[]): ConsultStatementCheck {
  const reasons: ConsultRejectReason[] = [];
  const cleaned = cleanText(raw.text, CONSULT_TEXT_MAX);
  const body = cleaned.text;
  if (body === '') return { statement: null, reasons: ['empty'], shapes: cleaned.shapes };
  const support: { id: string; label: string; sourceId: string | null }[] = [];
  for (const id of new Set(raw.support)) {
    const label = material.refs.get(id);
    if (label === undefined) reasons.push('unknown_ref');
    else if (support.length < CONSULT_REFS_MAX) support.push({ id, label, sourceId: material.recordSources.get(id) ?? null });
  }
  const citationOf = new Map(citations.map((c) => [c.id, c]));
  const cited: ApRef[] = [];
  const seen = new Set<string>();
  for (const id of new Set(raw.citations)) {
    const c = citationOf.get(id);
    if (c === undefined) {
      reasons.push('unknown_ref');
      continue;
    }
    const key = JSON.stringify(c.ref);
    if (seen.has(key) || cited.length >= CONSULT_REFS_MAX) continue;
    seen.add(key);
    cited.push(c.ref);
  }
  if (cited.length === 0 && newDoseNumbers(body, material.backing).length > 0) return { statement: null, reasons: [...reasons, 'dose'], shapes: cleaned.shapes };
  const points = new Set(material.points);
  if (pointsIn(body).some((p) => !points.has(p))) return { statement: null, reasons: [...reasons, 'score'], shapes: cleaned.shapes };
  const inferred = cited.length === 0;
  const text = inferred && !body.includes(INFERENCE) ? `${body}${INFERENCE}` : body;
  const backing = backingWith(material.backing, citations);
  return {
    statement: { section: raw.section, text, marks: markNumbers(text, backing).map((m) => ({ start: m.start, end: m.end })), inferred, support, citations: cited },
    reasons,
    shapes: cleaned.shapes,
  };
}

/** AI の答えを確かめる（文ごとの確かめ checkConsultStatement と、数の上限・見出しの順） */
export function checkConsult(answer: ConsultAnswer, material: ConsultMaterial, citations: readonly RefSource[]): CheckedConsult {
  const rejected: Partial<Record<ConsultRejectReason, number>> = {};
  const count = (r: ConsultRejectReason): void => {
    rejected[r] = (rejected[r] ?? 0) + 1;
  };
  let shapes = 0;
  const out: ConsultStatement[] = [];
  for (const raw of answer.statements) {
    const checked = checkConsultStatement(raw, material, citations);
    shapes += checked.shapes;
    for (const r of checked.reasons) count(r);
    if (checked.statement === null) continue;
    if (out.length >= CONSULT_STATEMENTS_MAX) {
      count('too_many');
      continue;
    }
    out.push(checked.statement);
  }
  // 見出しの順（同じ見出しの中は、AI の書いた順）
  const order = (x: ConsultStatement): number => CONSULT_SECTIONS.indexOf(x.section);
  const statements = out.map((x, i) => ({ x, i })).sort((a, b) => order(a.x) - order(b.x) || a.i - b.i).map(({ x }) => x);
  const unknown = cleanText(answer.unknown, CONSULT_UNKNOWN_MAX);
  return { statements, unknown: unknown.text, rejected, shapes: shapes + unknown.shapes };
}

// ---------------------------------------------------------------------------
// 少しずつ出す（CA-085）：書いている途中の JSON から、書き終えた文だけを取り出す。確かめる前の字は、画面に出さない

/**
 * AI が書いている途中の答え（JSON の字。先頭から）から、`statements` の中の、書き終えた文（閉じた { … }）だけを、書かれた順に返す。
 * 途中の文・形の合わない文は返さない（形の合わないものが1つあれば、そこで止める：順を飛ばさない）。字を解釈しない（JSON として読むだけ）
 */
export function partialStatements(json: string): RawConsultStatement[] {
  const key = json.indexOf('"statements"');
  if (key < 0) return [];
  const open = json.indexOf('[', key);
  if (open < 0) return [];
  const out: RawConsultStatement[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = open + 1; i < json.length; i += 1) {
    const ch = json[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      if (depth === 0 && ch === '{') start = i;
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      // statements の配列の終わり
      if (depth === 0) break;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        let value: unknown;
        try {
          value = JSON.parse(json.slice(start, i + 1));
        } catch {
          break;
        }
        const parsed = RawStatement.safeParse(value);
        if (!parsed.success) break;
        out.push(parsed.data);
        start = -1;
      }
    }
  }
  return out;
}

/** 少しずつ出すときの出来事（サーバーから画面へ。1行に1つの JSON）。保存しない */
export const CONSULT_STAGES = ['terms', 'references', 'answer'] as const;
export type ConsultStage = (typeof CONSULT_STAGES)[number];
export const CONSULT_STAGE_NAMES: Readonly<Record<ConsultStage, string>> = {
  terms: '問いから、調べる語を取り出しています',
  references: '書籍・ネットの出典を探しています',
  answer: '記録と出典を読んで、答えを書いています',
};
export type ConsultEvent =
  | { readonly stage: ConsultStage }
  /** 確かめた後の文（書かれた順。最後の答え〔done〕では、見出しの順に並べ直す） */
  | { readonly statement: ConsultStatement }
  | { readonly done: ConsultReply }
  | { readonly error: string };

// ---------------------------------------------------------------------------
// 残す（CA-032 の改訂）：先生が「残す」を押した答えだけ。問いの文は残さない。文は、サーバーで選別（C-1）を通す

export const CONSULT_NOTE_MODES = ['consult', 'record'] as const;
export type ConsultNoteMode = (typeof CONSULT_NOTE_MODES)[number];
export const CONSULT_NOTE_MODE_NAMES: Readonly<Record<ConsultNoteMode, string>> = { consult: 'AI の相談', record: 'AI が記録から答えた' };

export const ConsultNoteNew = z.strictObject({
  mode: z.enum(CONSULT_NOTE_MODES),
  text: z.string().trim().min(1).max(CONSULT_NOTE_MAX),
  /** 根拠の参照（記録の場所・書籍の題と頁・ネットの題と URL。本文は入れない） */
  refs: z.array(ApRef).max(CONSULT_NOTE_REFS_MAX),
});
export type ConsultNoteNew = z.infer<typeof ConsultNoteNew>;

/** 残した答えを直す（CA-083）：先生が打った字。サーバーで選別を通す。「先生が直した」の印が付く */
export const ConsultNotePatch = z.strictObject({ text: z.string().trim().min(1).max(CONSULT_NOTE_MAX) });
export type ConsultNotePatch = z.infer<typeof ConsultNotePatch>;

/** 残した答え（consult_notes の1行） */
export interface ConsultNote {
  readonly id: string;
  readonly mode: ConsultNoteMode;
  /** 選別を通した後の字 */
  readonly text: string;
  readonly refs: readonly ApRef[];
  readonly enteredAt: string;
  /** 残した後に、先生が直したか（CA-083） */
  readonly edited: boolean;
  readonly updatedAt: string;
}

/** 残した答えの印：どちらの答えか。直していれば「（先生が直した）」 */
export function consultNoteLabel(note: Pick<ConsultNote, 'mode' | 'edited'>): string {
  return `${CONSULT_NOTE_MODE_NAMES[note.mode]}${note.edited ? '（先生が直した）' : ''}`;
}

export const CONSULT_NOTE_ACTIONS = ['add', 'edit', 'delete'] as const;
export type ConsultNoteAction = (typeof CONSULT_NOTE_ACTIONS)[number];

/** 印（※）を、字に入れる（残す文は字だけなので、画面の下線の代わりに、数のすぐ後ろに「※」を置く） */
function withMarks(text: string, marks: readonly { readonly start: number; readonly end: number }[]): string {
  let out = text;
  for (const m of [...marks].sort((a, b) => b.end - a.end)) out = `${out.slice(0, m.end)}※${out.slice(m.end)}`;
  return out;
}

/** 相談の答えを、残す文にする：見出しごとに並べ、※と「（推論）」は字のまま残す。答えられなかったことも添える */
export function consultNoteText(reply: Pick<CheckedConsult, 'statements' | 'unknown'>): string {
  const lines: string[] = [];
  for (const section of CONSULT_SECTIONS) {
    const list = reply.statements.filter((s) => s.section === section);
    if (list.length === 0) continue;
    lines.push(`【${CONSULT_SECTION_NAMES[section]}】`, ...list.map((s) => `・${withMarks(s.text, s.marks)}`));
  }
  if (reply.unknown !== '') lines.push('【答えられなかったこと】', reply.unknown);
  return lines.join('\n').slice(0, CONSULT_NOTE_MAX);
}

/** 相談の答えの参照（出典だけ。同じものは1つ） */
export function consultNoteRefs(reply: Pick<CheckedConsult, 'statements'>): ApRef[] {
  const seen = new Set<string>();
  const out: ApRef[] = [];
  for (const ref of reply.statements.flatMap((s) => s.citations)) {
    const key = JSON.stringify(ref);
    if (seen.has(key) || out.length >= CONSULT_NOTE_REFS_MAX) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** 記録だけからの答え（記録に聞く）を、残す文にする */
export function askNoteText(reply: Pick<AskReply, 'answer' | 'notFound'>): string {
  const lines = reply.answer.map((s) => `・${withMarks(s.text, s.marks)}`);
  if (reply.notFound !== '') lines.push(reply.notFound);
  return lines.join('\n').slice(0, CONSULT_NOTE_MAX);
}

/** 記録だけからの答えの参照（記録の場所。同じ場所は1つ） */
export function askNoteRefs(reply: Pick<AskReply, 'answer'>): ApRef[] {
  const seen = new Set<string>();
  const out: ApRef[] = [];
  for (const r of reply.answer.flatMap((s) => s.refs)) {
    const key = `${r.sourceId}:${String(r.start)}:${String(r.end)}`;
    if (seen.has(key) || out.length >= CONSULT_NOTE_REFS_MAX) continue;
    seen.add(key);
    out.push({ k: 'record', sourceId: r.sourceId, start: r.start, end: r.end });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 答えの文を、記載の下書きと指示簿へ入れる（CA-082。CA-054 の「一文ずつの採用のボタンは作らない」の改訂）。
// どちらも、先生が1つずつ押したものだけ。記載は、下書きに足すだけで、残るのは記載の「保存する」を押したとき（これまでどおり）

/** 記載の下書きに足す候補（画面のメモリだけ）：文と、出典の参照（題・頁・URL） */
export interface ConsultPick {
  readonly key: string;
  readonly text: string;
  readonly refs: readonly ApRef[];
}

/** 印（※）を字に入れた文（下書きは字だけなので、数のすぐ後ろに「※」を置く）と、出典の参照 */
export function consultPick(key: string, statement: ConsultStatement): ConsultPick {
  return { key, text: withMarks(statement.text, statement.marks), refs: statement.citations };
}

/** 指示簿へ入れる前の、文の案：「（推論）」を外し、指示の長さに切る（先生が、欄を選び、字を確かめてから入れる） */
export function consultOrderText(statement: Pick<ConsultStatement, 'text'>): string {
  return statement.text.replaceAll(INFERENCE, '').trim().slice(0, ORDER_TEXT_MAX);
}

/**
 * 指示簿に足す項目（「AI の案」の印）。text は、先生が確かめた・直した字（サーバーで選別を通す）。
 * 根拠は、答えの文の根拠の短い名前。資料・出典に見つからない数（※）は、字に残っているものだけを印として渡す（消さない。CA-076 と同じ見せ方）
 */
export function consultOrderNew(statement: ConsultStatement, category: OrderCategory, text: string): OrderNew {
  const body = text.trim().slice(0, ORDER_TEXT_MAX);
  const numbers = statement.marks.map((m) => statement.text.slice(m.start, m.end)).filter((n) => /^\d+(?:\.\d+)?$/u.test(n) && n.length <= 20);
  return {
    category,
    text: body,
    condition: '',
    drug: '',
    dose: '',
    rate: '',
    interval: '',
    duration: '',
    action: 'none',
    start: null,
    end: null,
    scale: null,
    origin: 'ai',
    from: null,
    basis: statement.support.slice(0, ORDER_BASIS_MAX).map((r) => ({ id: r.id.slice(0, 10), label: r.label.slice(0, ORDER_BASIS_LABEL_MAX) })),
    unseen: [...new Set(numbers)].filter((n) => body.includes(n)).slice(0, 40),
  };
}
