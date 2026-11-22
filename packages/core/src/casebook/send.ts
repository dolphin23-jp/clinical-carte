// Casebook へ送る（段K10。CA-058 の B1・CA-073。docs/03 の「Casebook へ送る」）：carte の記録の1つの受診（入院・救急）から、clinical-casebook の
// 受け渡しパケット（CBH1。docs/casebook-contract/handoff-packet.md。版 1）の項目を作る。純関数（DOM・保存・通信・時計・乱数・暗号に触れない）。
//
// - パケットの符号化（encodePacket・decodePacket）と匿名化リンタ（lintAnonymization）は、Casebook のファイルの写し（このディレクトリの handoff/・lint/ など。
//   scripts/sync-casebook-contract.mjs が写し、casebook-copies.json の SHA-256 で見張る）。carte では書き直さない。ここに置くのは、carte の記録から項目を作る部分だけ。
// - 送るのは、記録に書かれたものだけ（補わない・要約しない・AI に作らせない）：記録の文（置き換えた後の字のまま）・問題の名前・先生が確からしさを選んだ診断・
//   AI のプロブレムリストの名前（AI の印）・投薬の開始・変更・中止（記録の字）・デバイスの入れた日と抜いた日・残したカルテ記載。検査値・バイタルを lab・vital の項目にしない
//   （Casebook の検査項目のカタログに合わせる表がないため。値は記録の文として送る）。経過の出来事の AI の要約は送らない（Casebook の契約の 1：AI が要約する経路を作らない）。
// - 暦日は送らない（Casebook の A-023）：日は病日（入院日＝第1病日、それより前は「入院N日前」＝ 1 − N）。文の中に暦日がある項目は送れない（直さずに止める）。
//   入院日・退院日は、パケットに欄がないので、Casebook の画面で先生が入れる（新しい症例の hospitalDay から、Casebook が入院日の初期値を出す）。
// - 匿名化リンタは、分ける前の文の全体と、分けた後の1つずつの文の両方に掛け、error が1つでもあれば、その欄のどの断片も送れない（理由の種類だけを出す。字は繰り返さない）。
// - 項目の ID は、受診ごとの種（seed）・項目の鍵（key）・改訂（rev）の SHA-256 から決める（同じ項目は同じ ID：Casebook に2つできない）。SHA-256 は画面が
//   WebCrypto で計算し（core は暗号に触れない）、ここは「何を計算するか」（itemIdInput）と「結果を ULID の形にする」（itemIdFromDigest）だけ。
import { z } from 'zod';

import { type EventKind, MEDICATION_ACTION_NAMES, type MedicationAction, type SegmentLabel } from '../organize/answer.ts';
import { LIST_ACTIVITY_NAMES, type ListActivity, type ListCertainty } from '../problems/list.ts';
import { type ThreadMention, type ThreadRow, threadViews } from '../problems/threads.ts';
import { ageNow } from '../record/headline.ts';
import { AUTHOR_ROLE_LABELS, type AuthorRole, type EncounterKind, type Sex, SOURCE_KIND_LABELS, type SourceKind } from '../record/schema.ts';
import { compareDateTime, daysBetween } from '../time/datetime.ts';
import { deviceDays } from '../views/days.ts';
import { DOC_SECTIONS, DOC_TYPE_NAMES, type DocType } from '../notes/document.ts';
import { decodePacket, encodePacket, type HandoffItem, type HandoffPacket, HANDOFF_SCHEMA_VERSION, MAX_ITEM_TEXT, MAX_ITEMS } from './handoff/packet.ts';
import { CASE_CODE_PATTERN, normalizeCaseCode } from './ids/case-code.ts';
import { type AnonymizationRule, dobMaxYearFor, lintAnonymization } from './lint/anonymize.ts';

// 写した契約のうち、画面と試験が使うもの（名前の重なる ULID・Ulid などは出さない）
export { DECODE_MESSAGES, decodePacket, encodePacket, type HandoffPacket, MAX_ITEM_TEXT, MAX_ITEMS } from './handoff/packet.ts';
export { CASE_CODE_PATTERN } from './ids/case-code.ts';

// ---------------------------------------------------------------------------
// 上限と形

/** 直して送り直せる回数（改訂は 0〜9。印の値は1桁） */
export const CASEBOOK_MAX_REV = 9;
/** 送信済みの印の上限（受診ごと） */
export const CASEBOOK_SENT_LIMIT = 1000;
/** 種：英小文字 10 字（数字を含めない） */
export const CASEBOOK_SEED_PATTERN = /^[a-z]{10}$/u;
/** 項目の鍵：英数字で始まり、英数字と「._-」。記録の id（ULID）と、決まった字だけでできる。患者の情報は入らない */
export const CASEBOOK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
/** 送った中身の印：英小文字 a〜p の 8 字（数字を含めない） */
export const CASEBOOK_HASH_PATTERN = /^[a-p]{8}$/u;

const SentMark = z.strictObject({ h: z.string().regex(CASEBOOK_HASH_PATTERN), r: z.number().int().min(0).max(CASEBOOK_MAX_REV) });
export type SentMark = z.infer<typeof SentMark>;

/** 受診ごとに覚えること（サーバーの casebook_links の1行）：種・症例コード・送信済みの印・取り込んだパケットの数。日付・時刻・文は持たない */
export const CasebookLink = z.strictObject({
  seed: z.string().regex(CASEBOOK_SEED_PATTERN),
  code: z.string().regex(CASE_CODE_PATTERN).nullable(),
  sent: z.record(z.string().regex(CASEBOOK_KEY_PATTERN), SentMark).refine((s) => Object.keys(s).length <= CASEBOOK_SENT_LIMIT),
  packets: z.number().int().min(0).max(100_000),
});
export type CasebookLink = z.infer<typeof CasebookLink>;

export const TakenEntry = z.strictObject({ key: z.string().regex(CASEBOOK_KEY_PATTERN), h: z.string().regex(CASEBOOK_HASH_PATTERN), r: z.number().int().min(0).max(CASEBOOK_MAX_REV) });
export type TakenEntry = z.infer<typeof TakenEntry>;

/** 印を直す：症例コード（null で消す）・Casebook が取り込んだ項目・最初からやり直す（新しい種。症例コードと印を消す） */
export const CasebookPatch = z.union([
  z.strictObject({ code: z.string().max(20).nullable() }),
  z.strictObject({ taken: z.array(TakenEntry).min(1).max(MAX_ITEMS) }),
  z.strictObject({ reset: z.literal(true) }),
]);
export type CasebookPatch = z.infer<typeof CasebookPatch>;

/** 種を、乱数の 10 バイトから作る（乱数は呼ぶ側が渡す）。英小文字だけ（数字の並びができない） */
export function newCasebookSeed(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 10; i += 1) out += String.fromCharCode(97 + ((bytes[i] ?? 0) % 26));
  return out;
}

/** 打った症例コードを読む（空白を除き、大文字に。形が違えば null） */
export function readCaseCode(text: string): string | null {
  const code = normalizeCaseCode(text.normalize('NFKC').replace(/\s+/gu, ''));
  return CASE_CODE_PATTERN.test(code) ? code : null;
}

/** Casebook が取り込んだ項目の印を足す（同じ鍵は上書き）。上限を超えるなら null */
export function addTaken(link: CasebookLink, taken: readonly TakenEntry[]): CasebookLink | null {
  const sent: Record<string, SentMark> = { ...link.sent };
  for (const t of taken) sent[t.key] = { h: t.h, r: t.r };
  if (Object.keys(sent).length > CASEBOOK_SENT_LIMIT) return null;
  return { ...link, sent, packets: link.packets + 1 };
}

// ---------------------------------------------------------------------------
// 日

/** 病日：入院（受診の始まり）の日を第1病日とし、それより前は 0 以下（入院N日前 = 1 − N。Casebook の契約の 3） */
export function casebookDay(admissionStart: string, at: string): number {
  return daysBetween(admissionStart.slice(0, 10), at.slice(0, 10)) + 1;
}

/** 病日の言い方（画面の表示だけ。パケットには数で入る） */
export function casebookDayLabel(day: number): string {
  return day >= 1 ? `第${String(day)}病日` : `入院${String(1 - day)}日前`;
}

const minutesOf = (dateTime: string): number | null => {
  const m = /T(\d{2}):(\d{2})$/u.exec(dateTime);
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
};

/**
 * 経過分（Casebook の afterMin。0〜1439）：第1病日は来院（受診の始まり）の時刻から、第2病日以降はその日の始まりから。時刻のない日時・入院前の日には付けない。
 * 暦日でも時刻でもない相対の値（Casebook の契約の 3）
 */
export function casebookAfterMin(admissionStart: string, at: string, day: number): number | null {
  const atMin = minutesOf(at);
  if (atMin === null || day < 1) return null;
  if (day >= 2) return atMin;
  const startMin = minutesOf(admissionStart);
  if (startMin === null) return null;
  const diff = atMin - startMin;
  return diff >= 0 && diff <= 1439 ? diff : null;
}

// ---------------------------------------------------------------------------
// 止める網（Casebook の匿名化リンタの写しを、そのまま使う）

const RULE_NAMES: Readonly<Record<AnonymizationRule, string>> = {
  'A-PHONE': '電話番号の形',
  'A-EMAIL': 'メールアドレスの形',
  'A-POSTAL': '郵便番号の形',
  'A-DIGITS12': '12桁以上の数字',
  'A-DOB': '生年月日の形',
  'A-PATIENT-ID': '患者IDの形',
  'A-HONORIFIC': '敬称つきの名前らしき字',
  'A-INITIALS': 'イニシャルらしき字',
  'A-ADDRESS': '住所らしき字',
  'A-FACILITY': '施設名らしき字',
  'A-CALENDAR-DATE': '暦日（年月日・月日）',
};

/** Casebook の画面が、生年月日とみなす年を決める受持時年齢の下限（Casebook の apps/web/src/cases/lint-gate.ts の MIN_AGE_FOR_DOB）【写し。Casebook で変われば直す】 */
export const CASEBOOK_DOB_MIN_AGE = 15;

/** 匿名化リンタの見分け：止めるもの（error）と、知らせるだけのもの（warn）の、規則の名前（字は返さない） */
export interface LintKinds {
  readonly errors: readonly string[];
  readonly warns: readonly string[];
}

/**
 * 文に、Casebook の匿名化リンタを掛ける。暦日は error にする（Casebook の A-023。carte の文は暦日を書くことがあるが、Casebook へは病日だけ）。
 * 生年月日とみなす年の上限は、今日の年まで広げて確かめる（Casebook が使う上限〔今年 − 15〕より広い：止めすぎは先生が直すだけで済み、止め漏れはクリップボードに載る。
 * Casebook で取り込む年が後になっても、15 年のうちは、この網より狭くならない）
 */
export function casebookLint(text: string, today: string): LintKinds {
  const year = Number(today.slice(0, 4));
  // 名前は、Casebook の画面と同じ上限（今年 − 15。Casebook の lint-gate.ts）で見分けた規則。上限を今年にして増える error は、生年月日の形として足す
  const findings = lintAnonymization(text, { dobMaxYear: dobMaxYearFor(year, CASEBOOK_DOB_MIN_AGE), calendarDates: 'error' });
  const wider = lintAnonymization(text, { dobMaxYear: year, calendarDates: 'error' });
  const errors = new Set<string>();
  const warns = new Set<string>();
  for (const f of findings) (f.level === 'error' ? errors : warns).add(RULE_NAMES[f.rule]);
  if (wider.some((f) => f.level === 'error') && errors.size === 0) errors.add(RULE_NAMES['A-DOB']);
  if (hasSlashMonthDay(text)) errors.add(SLASH_DATE);
  return { errors: [...errors], warns: [...warns] };
}

const SLASH_DATE = '暦日（月/日）';
// 見えない書式の文字（ゼロ幅の空白・ソフトハイフン・異体字の選択など。Casebook の網と同じ範囲）。結合する文字を含むので、文字の集まりの形ではなく、範囲で持つ
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
];
function dropInvisible(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!INVISIBLE_RANGES.some(([a, b]) => cp >= a && cp <= b)) out += ch;
  }
  return out;
}
// 「月/日」の形（11/18、11/18 10:00）。Casebook の匿名化リンタは、比や分数と見分けられないので、この形を暦日にしない。carte の記載は暦日をそのまま書く（CA-004）ので、
// carte の側で止める（Casebook のリンタより広い網：止めすぎは先生が記録の文を直すだけで済む）。単位の続く「数/数」（3/3 mm・1/2 錠）・月や日として
// ありえない数（120/80）は、月日にしない（carte の日時の読み方 time/when.ts の候補の形と同じ考え方）
const SLASH_MONTH_DAY = /(?<![\d/.])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/.]|\s?[A-Za-zμ%]|\s?(?:錠|包|本|回|量|袋|枚|管|個|単位|倍|筒))/gu;
function hasSlashMonthDay(text: string): boolean {
  const folded = dropInvisible(text).normalize('NFKC');
  for (const m of folded.matchAll(SLASH_MONTH_DAY)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 入力（記録から。画面が、読んだ記録をそのまま渡す）

export interface CasebookEncounter {
  readonly id: string;
  readonly kind: EncounterKind;
  readonly start: string;
  readonly end: string | null;
}
export interface CasebookSource {
  readonly id: string;
  readonly encounterId: string;
  readonly kind: SourceKind;
  readonly authorRole: AuthorRole;
  readonly at: string | null;
  readonly text: string;
}
export interface CasebookSegment {
  readonly sourceId: string;
  readonly label: SegmentLabel;
  readonly start: number;
  readonly end: number;
}
export type CasebookProblem = ThreadMention;
export interface CasebookListItem {
  readonly key: string;
  readonly name: string;
  readonly certainty: ListCertainty;
  readonly activity: ListActivity;
  readonly since: string | null;
  readonly self: readonly ('name' | 'certainty' | 'activity')[];
  readonly hidden: boolean;
}
export interface CasebookMedication {
  readonly id: string;
  readonly sourceId: string;
  readonly encounterId: string;
  readonly name: string;
  readonly doseText: string | null;
  readonly action: MedicationAction | null;
  readonly at: string | null;
  readonly excluded: boolean;
  readonly edited: boolean;
}
export interface CasebookEvent {
  readonly id: string;
  readonly encounterId: string;
  readonly kind: EventKind;
  readonly title: string;
  readonly at: string | null;
  readonly excluded: boolean;
  readonly edited: boolean;
}
export interface CasebookDocument {
  readonly id: string;
  readonly encounterId: string;
  readonly type: DocType;
  readonly day: string;
  readonly sections: readonly { readonly key: string; readonly text: string }[];
  readonly origin: 'ai' | 'ai_edited' | 'self';
}

export interface CasebookInput {
  readonly patient: { readonly age: number; readonly ageOn: string; readonly sex: Sex };
  /** 患者のすべての受診 */
  readonly encounters: readonly CasebookEncounter[];
  /** 送る受診（入院か救急） */
  readonly encounterId: string;
  /** サーバーの今日（日本の日。生年月日の見分けの年と、この送信の時点の病日にだけ使う） */
  readonly today: string;
  readonly sources: readonly CasebookSource[];
  readonly segments: readonly CasebookSegment[];
  readonly threads: readonly ThreadRow[];
  readonly problems: readonly CasebookProblem[];
  /** AI のプロブレムリストの項目（なければ空） */
  readonly list: readonly CasebookListItem[];
  readonly medications: readonly CasebookMedication[];
  readonly events: readonly CasebookEvent[];
  readonly documents: readonly CasebookDocument[];
  /** この受診の印（まだなければ null） */
  readonly link: CasebookLink | null;
}

// ---------------------------------------------------------------------------
// 範囲

/**
 * 送る範囲の受診：選んだ受診と、それが入院なら、その直前の救急の受診（入院の始まりの前の日から、その日まで。結果待ちの recentEncounters と同じ幅）。
 * 救急の受診の記載は、入院の病日で並ぶ（入院の前の日なら「入院1日前」）
 */
export function casebookScope(encounters: readonly CasebookEncounter[], encounterId: string): CasebookEncounter[] {
  const main = encounters.find((e) => e.id === encounterId);
  if (main === undefined) return [];
  if (main.kind !== 'inpatient') return [main];
  const start = main.start.slice(0, 10);
  const prior = encounters.filter((e) => e.id !== main.id && e.kind === 'er' && e.start.slice(0, 10) <= start && daysBetween(e.start.slice(0, 10), start) <= 1);
  return [...prior.sort((a, b) => compareDateTime(a.start, b.start)), main];
}

/** Casebook の症例の場面：入院・救急だけ。外来は送れない（Casebook では外来の受診日が要り、carte の外来は受診ごとに分かれているため。CA-073） */
export function casebookSetting(kind: EncounterKind): 'inpatient' | 'emergency' | null {
  return kind === 'inpatient' ? 'inpatient' : kind === 'er' ? 'emergency' : null;
}

// ---------------------------------------------------------------------------
// 項目の候補

export const CASEBOOK_GROUPS = ['problems', 'documents', 'notes', 'treatments'] as const;
export type CasebookGroup = (typeof CASEBOOK_GROUPS)[number];
export const CASEBOOK_GROUP_NAMES: Readonly<Record<CasebookGroup, string>> = {
  problems: '問題・診断',
  documents: '残したカルテ記載',
  notes: '記録の文（経過）',
  treatments: '投薬・デバイス',
};

/** 送らないもの（画面に出して、一覧が記録のすべてだと思わせない） */
export const CASEBOOK_NOT_SENT: readonly string[] = [
  '検査値・バイタルの数値の項目（Casebook の検査項目名に合わせる表がないため。値は「記録の文」として送れます）',
  '経過の出来事（AI の短い要約）・AI のプロブレムリストの根拠の文・臨床支援・結果待ち・予定と実施（AI の整理。Casebook へは記録に書かれたものだけを送ります）',
  '申し送り・記録への質問・A/P の案',
  '入院日・退院日・記載の日時（暦日）。日は病日で送ります。入院日・退院日は Casebook の症例の画面で入れてください',
  '投薬の「継続」と、動きの書かれていない投薬の記載（記録の文として送れます）',
  '既往・内服などの背景を、Casebook の背景（1項目＝1つの事実）に分けること（記録の文として送れます）',
  '問題への紐づけ（problemId）・治療の構造化の欄（名前・種類・用量）',
];

export type CasebookItemKind = 'problem' | 'diagnosis' | 'course' | 'note';

export interface CasebookCandidate {
  /** 項目の鍵（同じ記録の同じものは、いつも同じ鍵） */
  readonly key: string;
  readonly group: CasebookGroup;
  /** 画面に出す短い名前 */
  readonly tag: string;
  readonly kind: CasebookItemKind;
  readonly status?: 'suspected' | 'confirmed';
  /** 病日（なければ、Casebook はパケットの hospitalDay を使う） */
  readonly day: number | null;
  readonly afterMin: number | null;
  readonly source: 'user' | 'ai';
  /** パケットに入る文（500 字まで） */
  readonly text: string;
  /** 送れない理由（種類だけ。空なら送れる） */
  readonly blockers: readonly string[];
  /** 知らせるだけの理由（送れるが、初めは選ばない） */
  readonly warns: readonly string[];
  /** 初めは選ばない（確からしさを記録から読んだ診断・解決と書かれた問題など） */
  readonly unticked: boolean;
  /** 送った中身の印 */
  readonly h: string;
}

const RULED_OUT = '否定的・除外と書かれた問題です（Casebook に「除外」を表す種類がないため、送れません）';
const NO_DAY = '日時のない記載です（病日が決まらないため、送れません。記載の日時を入れると送れます）';
const EMPTY = '中身がありません';
const BAD_KEY = '項目の鍵の形が合いません';

/** 送った中身の印（FNV-1a を 8 字の英字に。数字を含めない）。暗号ではなく、送信後に直したかを見分けるだけ */
function hashOf(c: { kind: string; status?: string; source: string; day: number | null; afterMin: number | null; text: string }): string {
  let h = 0x811c9dc5;
  for (const ch of `${c.kind}|${c.status ?? ''}|${c.source}|${String(c.day)}|${String(c.afterMin)}|${c.text}`) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0; // phi-guard: allow FNV-1a の定数
  }
  let out = '';
  for (let i = 0; i < 8; i += 1) out += String.fromCharCode(97 + ((h >>> (28 - 4 * i)) & 15));
  return out;
}

/** s の先頭から n 単位まで（サロゲートの対を割らない） */
function cutAt(s: string, n: number): string {
  let k = Math.min(n, s.length);
  if (k < s.length && k > 0) {
    const c = s.charCodeAt(k - 1);
    if (c >= 0xd800 && c <= 0xdbff) k -= 1;
  }
  return s.slice(0, k);
}

/**
 * 1つの欄の文を、Casebook の上限（500 字）に収まる断片にする：「名前: 本文」か、入らなければ「名前（1/2）: …」。
 * 行の終わり・「。」の後で分け、1文が長すぎるときだけ途中で分ける。切り捨てない（断片を合わせると、元の文のすべて）
 */
export function casebookPieces(label: string, body: string, max = MAX_ITEM_TEXT): string[] {
  const text = body.trim();
  if (text === '') return [];
  const whole = `${label}: ${text}`;
  if (whole.length <= max) return [whole];
  const budget = max - label.length - 12;
  const parts: string[] = [];
  let cur = '';
  const push = (x: string) => {
    if (x.trim() !== '') parts.push(x.trim());
  };
  for (const sentence of text.match(/[^\n。]*(?:\n|。|$)/gu) ?? [text]) {
    if (sentence === '') continue;
    let x = sentence;
    while (x.length > budget) {
      push(cur);
      cur = '';
      const cut = cutAt(x, budget);
      push(cut);
      x = x.slice(cut.length);
    }
    if (cur.length + x.length > budget) {
      push(cur);
      cur = x;
    } else cur += x;
  }
  push(cur);
  return parts.map((x, i) => `${label}（${String(i + 1)}/${String(parts.length)}）: ${x}`);
}

interface Field {
  readonly key: string;
  readonly group: CasebookGroup;
  readonly tag: string;
  readonly kind: CasebookItemKind;
  readonly status?: 'suspected' | 'confirmed';
  readonly day: number | null;
  readonly afterMin: number | null;
  readonly source: 'user' | 'ai';
  readonly label: string;
  readonly body: string;
  /** 分けずに1つで送る（問題・診断の名前） */
  readonly single?: boolean;
  readonly blockers?: readonly string[];
  readonly unticked?: boolean;
}

/** 1つの欄を、候補（断片ごと）にする。リンタは、分ける前の文の全体と、分けた後の1つずつに掛け、止まるものがあれば、どの断片も止める */
function fieldCandidates(f: Field, today: string): CasebookCandidate[] {
  const texts = f.single === true ? (f.body.trim() === '' ? [] : [f.body.trim()]) : casebookPieces(f.label, f.body);
  const errors = new Set<string>(f.blockers ?? []);
  const warns = new Set<string>();
  const add = (k: LintKinds) => {
    for (const e of k.errors) errors.add(e.startsWith('暦日') ? `${e}があります（記録の文の日付を「入院N日目」「N日前」などに直すと送れます）` : `患者を特定しうる情報の形（${e}）`);
    for (const w of k.warns) warns.add(w);
  };
  add(casebookLint(f.body, today));
  for (const t of texts) add(casebookLint(t, today));
  if (f.single === true && f.body.trim().length > MAX_ITEM_TEXT) errors.add(`長すぎます（${String(MAX_ITEM_TEXT)} 字まで）`);
  if (texts.length === 0) {
    return [{ key: `${f.key}.c1`, group: f.group, tag: f.tag, kind: f.kind, ...(f.status === undefined ? {} : { status: f.status }), day: f.day, afterMin: f.afterMin, source: f.source, text: '', blockers: [EMPTY], warns: [], unticked: true, h: 'aaaaaaaa' }];
  }
  if (!CASEBOOK_KEY_PATTERN.test(`${f.key}.c${String(texts.length)}`)) errors.add(BAD_KEY);
  return texts.map((text, i) => {
    const base = { kind: f.kind, ...(f.status === undefined ? {} : { status: f.status }), source: f.source, day: f.day, afterMin: f.afterMin, text };
    return {
      key: `${f.key}.c${String(i + 1)}`,
      group: f.group,
      tag: texts.length > 1 ? `${f.tag}（${String(i + 1)}/${String(texts.length)}）` : f.tag,
      ...base,
      blockers: [...errors],
      warns: [...warns],
      unticked: f.unticked === true,
      h: hashOf(base),
    };
  });
}

/**
 * 記録の文の欄：記載の #問題の見出しの区切りで分ける（見出しの前の部分と、見出しから次の見出しの前まで）。字は保存した文のまま。
 * 文のすべての字が、どれか1つの欄に入る（黙って落とさない）
 */
export function sourceFields(text: string, segments: readonly { readonly label: SegmentLabel; readonly start: number; readonly end: number }[]): { start: number; end: number }[] {
  const cuts = [...new Set(segments.filter((s) => s.label === 'problem_heading' && s.start > 0 && s.start < text.length).map((s) => s.start))].sort((a, b) => a - b);
  const bounds = [0, ...cuts, text.length];
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const start = bounds[i] ?? 0;
    const end = bounds[i + 1] ?? text.length;
    if (text.slice(start, end).trim() !== '') out.push({ start, end });
  }
  return out;
}

const DOC_SOURCE = (origin: CasebookDocument['origin']): 'user' | 'ai' => (origin === 'self' ? 'user' : 'ai');
const DOC_ORIGIN_WORDS: Readonly<Record<CasebookDocument['origin'], string>> = { ai: 'AI が書いた', ai_edited: 'AI が書いて先生が直した', self: '先生が書いた' };
const SEND_ACTIONS: readonly MedicationAction[] = ['start', 'change', 'stop'];

/**
 * 記録の1つの受診から、送れる項目の候補を、画面の順に作る。何も判定しない（空欄は空欄のまま）。
 * 送れないものは、理由（種類だけ）を付けて残す（黙って捨てない）
 */
export function casebookCandidates(input: CasebookInput): CasebookCandidate[] {
  const scope = casebookScope(input.encounters, input.encounterId);
  const main = scope.at(-1);
  if (main === undefined) return [];
  const inScope = new Set(scope.map((e) => e.id));
  const sources = input.sources.filter((s) => inScope.has(s.encounterId));
  const sourceIds = new Set(sources.map((s) => s.id));
  const admit = main.start;
  const dayOf = (at: string | null): number | null => (at === null ? null : casebookDay(admit, at));
  const minOf = (at: string | null): number | null => {
    const day = dayOf(at);
    return at === null || day === null ? null : casebookAfterMin(admit, at, day);
  };
  const fields: Field[] = [];

  // 1. 問題（記録に書かれた問題の筋。この受診の記載に書かれたものだけ）と、診断
  const mentions = input.problems.filter((p) => sourceIds.has(p.sourceId));
  const views = threadViews(input.threads, mentions).threads;
  for (const v of views) {
    const ruled = v.group === 'ruled_out';
    const day = dayOf(v.first);
    const blockers = ruled ? [RULED_OUT] : [];
    fields.push({ key: `t.${v.id}`, group: 'problems', tag: ruled ? '問題（否定的と書かれた）' : v.group === 'closed' ? '問題（解決・非活動と書かれた）' : '問題（記録に書かれた）', kind: 'problem', day, afterMin: null, source: 'user', label: '', body: v.name, single: true, blockers, unticked: v.group === 'closed' });
    if (!ruled && (v.status === 'diagnosis' || v.status === 'suspected')) {
      const status = v.status === 'diagnosis' ? 'confirmed' : 'suspected';
      fields.push({
        key: `t.${v.id}.dx`,
        group: 'problems',
        tag: `診断（${status === 'confirmed' ? '確定' : '疑い'}・${v.statusBySelf ? '先生が選んだ確からしさ' : '記録に書かれた確からしさ'}）`,
        kind: 'diagnosis',
        status,
        day: dayOf(v.statusAt ?? v.first),
        afterMin: null,
        source: 'user',
        label: '',
        body: v.name,
        single: true,
        // 確からしさを carte で先生が選んでいない診断は、初めは選ばない（Casebook の確定診断は J-OSLER の登録の候補になる）
        unticked: !v.statusBySelf,
      });
    }
  }

  // 2. AI のプロブレムリストの名前（AI の印。先生が名前・確からしさを直したものは、その欄だけ先生）
  for (const item of input.list) {
    if (item.hidden) continue;
    const ruled = item.activity === 'ruled_out';
    const day = dayOf(item.since);
    const nameBy = item.self.includes('name') ? 'user' : 'ai';
    const keyOk = CASEBOOK_KEY_PATTERN.test(`l.${item.key}.dx.c1`);
    const base = keyOk ? `l.${item.key}` : 'l.bad';
    const blockers = [...(ruled ? [RULED_OUT] : []), ...(keyOk ? [] : [BAD_KEY])];
    fields.push({ key: base, group: 'problems', tag: `AI のプロブレムリスト（${LIST_ACTIVITY_NAMES[item.activity]}）`, kind: 'problem', day, afterMin: null, source: nameBy, label: '', body: item.name, single: true, blockers, unticked: item.activity !== 'active' });
    if (!ruled && (item.certainty === 'diagnosis' || item.certainty === 'suspected')) {
      const bySelf = item.self.includes('certainty');
      const status = item.certainty === 'diagnosis' ? 'confirmed' : 'suspected';
      fields.push({
        key: `${base}.dx`,
        group: 'problems',
        tag: `診断（${status === 'confirmed' ? '確定' : '疑い'}・${bySelf ? '先生が選んだ確からしさ' : 'AI の確からしさ'}）`,
        kind: 'diagnosis',
        status,
        day,
        afterMin: null,
        source: bySelf && nameBy === 'user' ? 'user' : 'ai',
        label: '',
        body: item.name,
        single: true,
        blockers: keyOk ? [] : [BAD_KEY],
        unticked: !bySelf,
      });
    }
  }

  // 3. 残したカルテ記載（見出しごと。AI が書いたものは AI の印）
  const docs = input.documents.filter((d) => inScope.has(d.encounterId) && d.type !== 'handoff').sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
  for (const d of docs) {
    const headings = new Map(DOC_SECTIONS[d.type].map((x) => [x.key, x.heading]));
    for (const s of d.sections) {
      if (s.text.trim() === '') continue;
      fields.push({
        key: `doc.${d.id}.${s.key}`,
        group: 'documents',
        tag: `${DOC_TYPE_NAMES[d.type]}・${headings.get(s.key) ?? s.key}（${DOC_ORIGIN_WORDS[d.origin]}）`,
        kind: 'note',
        day: casebookDay(admit, d.day),
        afterMin: null,
        source: DOC_SOURCE(d.origin),
        label: `${DOC_TYPE_NAMES[d.type]}・${headings.get(s.key) ?? s.key}`,
        body: s.text,
      });
    }
  }

  // 4. 記録の文（保存した文の字のまま。#問題の見出しで分ける）
  const segs = new Map<string, CasebookSegment[]>();
  for (const s of input.segments) {
    const list = segs.get(s.sourceId) ?? [];
    list.push(s);
    segs.set(s.sourceId, list);
  }
  const ordered = [...sources].sort((a, b) => compareDateTime(a.at, b.at) || a.id.localeCompare(b.id));
  for (const s of ordered) {
    const label = `${SOURCE_KIND_LABELS[s.kind]}（${AUTHOR_ROLE_LABELS[s.authorRole]}）`;
    const parts = sourceFields(s.text, segs.get(s.id) ?? []);
    parts.forEach((p, i) => {
      fields.push({
        key: `s.${s.id}.${String(p.start)}`,
        group: 'notes',
        tag: parts.length > 1 ? `${label} ${String(i + 1)}/${String(parts.length)}` : label,
        kind: s.kind === 'memo' ? 'note' : 'course',
        day: dayOf(s.at),
        afterMin: minOf(s.at),
        source: 'user',
        label,
        body: s.text.slice(p.start, p.end),
        blockers: s.at === null ? [NO_DAY] : [],
      });
    });
  }

  // 5. 投薬の開始・変更・中止（記録の字。動きと名前は AI の整理なので、先生が直していなければ AI の印）と、デバイスの入れた日・抜いた日
  const meds = input.medications
    .filter((m) => inScope.has(m.encounterId) && !m.excluded && m.action !== null && SEND_ACTIONS.includes(m.action))
    .sort((a, b) => compareDateTime(a.at, b.at) || a.id.localeCompare(b.id));
  for (const m of meds) {
    const action = MEDICATION_ACTION_NAMES[m.action ?? 'start'];
    fields.push({
      key: `m.${m.id}`,
      group: 'treatments',
      tag: `投薬（${action}）`,
      kind: 'note',
      day: dayOf(m.at),
      afterMin: minOf(m.at),
      source: m.edited ? 'user' : 'ai',
      label: `投薬（${action}）`,
      body: [m.name, m.doseText ?? ''].filter((x) => x.trim() !== '').join(' '),
      blockers: m.at === null ? [NO_DAY] : [],
    });
  }
  const events = input.events.filter((e) => inScope.has(e.encounterId) && !e.excluded);
  const edited = new Set(events.filter((e) => e.edited).map((e) => e.id));
  for (const d of deviceDays(events, main.end)) {
    const placed = casebookDay(admit, d.placedAt);
    const removed = d.removedAt === null ? null : casebookDay(admit, d.removedAt);
    const span = `${casebookDayLabel(placed)}〜${removed === null ? '（抜いた記載なし）' : casebookDayLabel(removed)}`;
    const first = d.eventIds[0] ?? 'none';
    fields.push({
      key: `d.${first}`,
      group: 'treatments',
      tag: 'デバイス（入れた日〜抜いた日）',
      kind: 'note',
      day: placed,
      afterMin: null,
      source: d.eventIds.every((id) => edited.has(id)) ? 'user' : 'ai',
      label: 'デバイス',
      body: `${d.name}（${span}${d.replaced ? '・入れ替えの記載あり' : ''}）`,
    });
  }

  return fields.flatMap((f) => fieldCandidates(f, input.today));
}

// ---------------------------------------------------------------------------
// 送ったもの・直したもの

export type CasebookItemState = 'new' | 'sent' | 'changed';

/** new（まだ印がない）・sent（印があり、同じ中身）・changed（印はあるが、送った後に直した） */
export function casebookState(link: CasebookLink | null, c: CasebookCandidate): CasebookItemState {
  const m = link?.sent[c.key];
  if (m === undefined) return 'new';
  return m.h === c.h ? 'sent' : 'changed';
}

/** 送るときの改訂：印のとおり。直した項目を新しい項目として送るときだけ、次の改訂 */
export function casebookRev(link: CasebookLink | null, c: CasebookCandidate, resend: boolean): number {
  const m = link?.sent[c.key];
  if (m === undefined) return 0;
  return resend && m.h !== c.h ? m.r + 1 : m.r;
}

/** 改訂と印の上限：上限に達した・近づいた項目は、黙って送らずに、送れない理由を出す */
export function casebookLimits(link: CasebookLink | null, c: CasebookCandidate): string[] {
  const m = link?.sent[c.key];
  const marked = Object.keys(link?.sent ?? {}).length;
  const out: string[] = [];
  if (m !== undefined && m.h !== c.h && m.r >= CASEBOOK_MAX_REV) out.push(`直して送り直した回数が上限（${String(CASEBOOK_MAX_REV)}回）です。Casebook で直してください`);
  if (m === undefined && marked >= CASEBOOK_SENT_LIMIT - MAX_ITEMS) out.push('送信済みの印の上限に近づいています（最初から送り直してください）');
  return out;
}

/** 画面を開いたときに選んでおく項目：送れる・まだ送っていない・AI の印がない・初めは選ばない印がない・知らせる理由がないもの。Casebook の上限（100）まで、画面の順に */
export function casebookDefaultKeys(link: CasebookLink | null, candidates: readonly CasebookCandidate[]): string[] {
  return candidates
    .filter((c) => c.blockers.length === 0 && casebookLimits(link, c).length === 0 && c.warns.length === 0 && !c.unticked && c.source !== 'ai' && casebookState(link, c) === 'new')
    .slice(0, MAX_ITEMS)
    .map((c) => c.key);
}

// ---------------------------------------------------------------------------
// 項目の ID

/** SHA-256 にかける文字列（画面が WebCrypto で計算する）。種・鍵・改訂が同じなら、同じ ID */
export function itemIdInput(seed: string, key: string, rev: number): string {
  return `carte|${seed}|${key}|${String(rev)}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // phi-guard: allow Crockford Base32 の文字表

/** SHA-256 の先頭 16 バイト（128 ビット）を、ULID の形（26 字。先頭は 0〜7）にする */
export function itemIdFromDigest(digest: Uint8Array): string {
  if (digest.length < 16) throw new RangeError('SHA-256 の結果（32 バイト）を渡す');
  let n = 0n;
  for (let i = 0; i < 16; i += 1) n = (n << 8n) | BigInt(digest[i] ?? 0);
  let out = '';
  for (let i = 0; i < 26; i += 1) {
    out = CROCKFORD.charAt(Number(n & 31n)) + out;
    n >>= 5n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// パケット

export interface CasebookPatient {
  readonly ageYears: number;
  readonly sex: 'M' | 'F' | 'other';
  readonly setting: 'inpatient' | 'emergency';
}

const SEX_OUT: Readonly<Record<Sex, 'M' | 'F' | 'other'>> = { male: 'M', female: 'F', other: 'other' };

/** 新しい症例の、記録からの年齢・性別・場面（年齢は、受診の始まりの日の概算。生年月日を持たないので、最大で1歳ずれる） */
export function casebookPatientDefaults(input: Pick<CasebookInput, 'patient' | 'encounters' | 'encounterId'>): CasebookPatient | null {
  const e = input.encounters.find((x) => x.id === input.encounterId);
  if (e === undefined) return null;
  const setting = casebookSetting(e.kind);
  if (setting === null) return null;
  return { ageYears: ageNow(input.patient.age, input.patient.ageOn, e.start.slice(0, 10)), sex: SEX_OUT[input.patient.sex], setting };
}

export interface PacketChoice {
  /** 新しい症例か、症例コード（受診の印に残したもの）の症例に足すか */
  readonly mode: 'new' | 'append';
  /** 新しい症例のとき：年齢・性別・場面 */
  readonly patient: CasebookPatient | null;
  /** 新しい症例のとき：実症例（false）か架空症例（true）か。null は、まだ選んでいない（既定はない） */
  readonly synthetic: boolean | null;
  readonly keys: readonly string[];
  /** 送った後に直した項目を、新しい項目（次の改訂）として送る鍵 */
  readonly resend: readonly string[];
  /** パケットの ID（ULID。画面が作る） */
  readonly packetId: string;
}

export interface PacketPlan {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** ID を計算する項目（鍵・改訂・SHA-256 にかける文字列） */
  readonly ids: readonly { readonly key: string; readonly rev: number; readonly input: string }[];
}

const ULID_SHAPE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/** パケットを作る前の確かめと、計算する ID の一覧。誤りがあれば、パケットは作らない */
export function planPacket(input: CasebookInput, candidates: readonly CasebookCandidate[], choice: PacketChoice): PacketPlan {
  const errors: string[] = [];
  const link = input.link;
  const main = input.encounters.find((e) => e.id === input.encounterId);
  if (link === null) errors.push('この受診の印（項目の ID の元）がありません。もう一度開いてください');
  if (main === undefined || casebookSetting(main.kind) === null) errors.push('外来の受診は送れません（Casebook では外来の受診日が要るため）。入院・救急の受診を選んでください');
  if (choice.mode === 'new') {
    const p = choice.patient;
    if (p === null || !(Number.isInteger(p.ageYears) && p.ageYears >= 0 && p.ageYears <= 130)) errors.push('年齢（0〜130 の歳）を入れてください');
    if (choice.synthetic === null) errors.push('実症例か架空症例かを選んでください');
  } else if (link?.code === null || link?.code === undefined) errors.push('Casebook の症例コード（6文字）を入れてください');
  if (!ULID_SHAPE.test(choice.packetId)) errors.push('パケットの ID がありません');
  const keys = new Set(choice.keys);
  const resend = new Set(choice.resend);
  const chosen = candidates.filter((c) => keys.has(c.key));
  if (chosen.length === 0) errors.push('送る項目を選んでください');
  if (chosen.length > MAX_ITEMS) errors.push(`1回に送れるのは ${String(MAX_ITEMS)} 項目までです（${String(chosen.length)} 項目）`);
  if (chosen.some((c) => c.blockers.length > 0 || casebookLimits(link, c).length > 0)) errors.push('送れない項目が選ばれています');
  if (chosen.some((c) => casebookState(link, c) === 'sent')) errors.push('送信済みの項目が選ばれています');
  if (chosen.some((c) => casebookState(link, c) === 'changed' && !resend.has(c.key))) errors.push('送った後に直した項目は、「新しい項目として送る」を選ぶと送れます');
  if (errors.length > 0 || link === null) return { ok: false, errors, ids: [] };
  return {
    ok: true,
    errors: [],
    ids: chosen.map((c) => {
      const rev = casebookRev(link, c, resend.has(c.key));
      return { key: c.key, rev, input: itemIdInput(link.seed, c.key, rev) };
    }),
  };
}

export interface BuiltPacket {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** CBH1: で始まる文字列（クリップボードに載せる） */
  readonly text: string;
  /** Casebook が取り込んだと先生が押したときに付ける印 */
  readonly entries: readonly TakenEntry[];
  readonly count: number;
}

const KIND_ORDER: Readonly<Record<CasebookItemKind, number>> = { problem: 0, diagnosis: 1, course: 2, note: 2 };

/**
 * パケットを作る（ids は、planPacket の ids を SHA-256 にかけて itemIdFromDigest にした、鍵 → ID）。
 * 作った後に、Casebook の decodePacket（写し）で読み戻し、形の違う項目・知らない種類が 0 件で、数が同じことを確かめる（Casebook の契約の 7 の 3）。
 * すべての文字列に、もう一度リンタを掛ける（契約の 5）
 */
export function buildPacket(input: CasebookInput, candidates: readonly CasebookCandidate[], choice: PacketChoice, ids: ReadonlyMap<string, string>): BuiltPacket {
  const fail = (errors: readonly string[]): BuiltPacket => ({ ok: false, errors, text: '', entries: [], count: 0 });
  const plan = planPacket(input, candidates, choice);
  if (!plan.ok) return fail(plan.errors);
  const main = input.encounters.find((e) => e.id === input.encounterId);
  const setting = main === undefined ? null : casebookSetting(main.kind);
  if (main === undefined || setting === null) return fail(['受診が見つかりません']);
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const entries: TakenEntry[] = [];
  const items: HandoffItem[] = [];
  const rows = plan.ids
    .map((x, i) => ({ x, i, c: byKey.get(x.key) }))
    .sort((a, b) => (a.c === undefined || b.c === undefined ? 0 : KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind]) || a.i - b.i);
  for (const { x, c } of rows) {
    const itemId = ids.get(x.key);
    if (c === undefined || itemId === undefined || !ULID_SHAPE.test(itemId)) return fail(['項目の ID が計算できませんでした']);
    if (casebookLint(c.text, input.today).errors.length > 0) return fail(['送れない文が混ざっています']);
    const body: HandoffItem['body'] =
      c.kind === 'problem' ? { kind: 'problem', text: c.text } : c.kind === 'diagnosis' ? { kind: 'diagnosis', text: c.text, status: c.status ?? 'suspected' } : { kind: c.kind, text: c.text };
    const item: HandoffItem = { itemId, source: c.source, body, ...(c.day === null ? {} : { day: c.day }), ...(c.afterMin === null || c.day === null || c.day < 1 ? {} : { afterMin: c.afterMin }) };
    items.push(item);
    entries.push({ key: c.key, h: c.h, r: x.rev });
  }
  if (new Set(items.map((i) => i.itemId)).size !== items.length) return fail(['項目の ID が重なりました']);
  const link = input.link;
  const newCase = choice.mode === 'new';
  const patient = choice.patient;
  if (newCase && patient === null) return fail(['年齢・性別・場面がありません']);
  const packet: HandoffPacket = {
    magic: 'CBH1',
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    packetId: choice.packetId,
    target: newCase || link?.code === null || link?.code === undefined ? { mode: 'new' } : { mode: 'append', caseCode: link.code },
    ...(newCase && patient !== null ? { patient: { ageYears: patient.ageYears, sex: patient.sex, setting: patient.setting } } : {}),
    ...(newCase && choice.synthetic === true ? { synthetic: true as const } : {}),
    ...(newCase ? { hospitalDay: Math.max(1, casebookDay(main.start, input.today)) } : {}),
    items,
  };
  const text = encodePacket(packet);
  const check = decodePacket(text);
  if (!check.ok || check.value.invalid.length > 0 || check.value.unknownKind.length > 0 || check.value.packet.items.length !== items.length) return fail(['作ったパケットを、Casebook の読み方で読み戻せませんでした']);
  return { ok: true, errors: [], text, entries, count: items.length };
}
