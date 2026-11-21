// 検査値・バイタルを、文字から読む（AI を使わない。docs/00 の 5、docs/04 の 3.4）。
// 「Na 128 K 3.1 Cr 1.8 BP 78/40 CRP <0.1 尿蛋白 2+」を、名前・値・単位の行にする。純関数：読むだけで、何も書かない。
//
// 出発点は、clinical-playbook の labs/text.ts（名前の最長一致、空白がなくても読める、黙って捨てない）。carte は記録なので、次が違う：
//  - **書かれたとおりに持つ**：不等号つきの値（<0.1）と、定性の結果（(-)・2+・陽性）も読む。単位は、書かれたものだけ（補わない・換算しない）。
//  - **判定しない**：ありうる範囲・基準範囲を見ない。桁を、値の大きさから当てない。
//  - カタログにない名前は、「名前: 値」「名前=値」と書いたときだけ、書かれた名前のまま読む（文の中の語を、項目と取り違えないため）。
//  - 位置（start・end）は、渡した文の位置（そろえても長さを変えないので、そのまま使える）。
// **黙って捨てない**：読めなかった部分は、理由つきで unread に返す。文のすべての文字は、行の範囲・読めなかった部分の範囲・区切りのどれかに入る（試験が確かめる）。
import { foldSameLength, lowerAscii } from '../text/fold.ts';
import { LAB_NAMES } from './catalog.gen.ts';
import { EXTRA_ALIASES, EXTRA_LAB_NAMES, EXTRA_UNITS } from './extra-names.ts';

export type Comparator = '<' | '>' | '<=' | '>=';

export interface LabRow {
  /** カタログの正規の名前。カタログにない名前（「名前: 値」で入れたもの）は null */
  readonly name: string | null;
  /** 書かれた名前（文のまま） */
  readonly nameRaw: string;
  readonly kind: 'lab' | 'vital' | null;
  /** 数（数で書かれたときだけ） */
  readonly value: number | null;
  readonly comparator: Comparator | null;
  /** 書かれた値（文のまま。数は、桁区切りのカンマもそのまま。定性は「2+」「(-)」など） */
  readonly valueText: string;
  /** 書かれた単位（書かれていなければ null。補わない） */
  readonly unit: string | null;
  readonly start: number;
  readonly end: number;
}

export const UNREAD_REASONS = ['unknown', 'no_value', 'bad_pair', 'trailing', 'bad_comparator'] as const;
export type UnreadReason = (typeof UNREAD_REASONS)[number];

export const UNREAD_LABELS: Readonly<Record<UnreadReason, string>> = {
  unknown: '項目の名前として読めませんでした（カタログにない名前は「名前: 値」と書くと読めます）',
  no_value: '値が読めませんでした',
  bad_pair: '血圧は「78/40」のように、収縮期/拡張期の順に「/」で区切ります',
  trailing: '値の後ろに、読めない文字があります',
  bad_comparator: '不等号の後ろに、数がありません',
};

export interface LabUnread {
  readonly reason: UnreadReason;
  readonly start: number;
  readonly end: number;
}

export interface LabRead {
  readonly rows: readonly LabRow[];
  readonly unread: readonly LabUnread[];
}

/** 1つの欄に2つの値を書く項目（血圧の「78/40」）。分け先は、カタログの正規の名前 */
const PAIRS: readonly { names: readonly string[]; parts: readonly [string, string] }[] = [{ names: ['血圧', 'BP'], parts: ['収縮期血圧', '拡張期血圧'] }];

const nameKey = (text: string): string => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const unitKey = (text: string): string => text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
// 文の側は、長さを変えないそろえ（foldSameLength）で比べる。NFKC は長さを変える字がある（「℃」→「°C」）ので、
// 表の側は、NFKC の形と、文と同じそろえの形の、両方で持つ（「BT 39.2℃」の ℃ を、単位として読むため）
const nameKeysOf = (text: string): string[] => [...new Set([nameKey(text), lowerAscii(foldSameLength(text)).trim().replace(/\s+/g, ' ')])];
const unitKeysOf = (text: string): string[] => [...new Set([unitKey(text), lowerAscii(foldSameLength(text)).replace(/\s+/g, '')])];

interface Candidate {
  readonly key: string;
  readonly name: string;
  readonly kind: 'lab' | 'vital';
  readonly pair: readonly [string, string] | null;
}

interface Vocabulary {
  /** 名前の候補を、先頭の字ごとに分けたもの（それぞれ、長い順）。全部を毎回試さないため */
  readonly byFirst: ReadonlyMap<string, readonly Candidate[]>;
  /** 単位の書き方を、先頭の字ごとに分けたもの（それぞれ、長い順） */
  readonly unitsByFirst: ReadonlyMap<string, readonly string[]>;
}

function groupByFirst<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const first = keyOf(item).charAt(0);
    const list = map.get(first) ?? [];
    list.push(item);
    map.set(first, list);
  }
  return map;
}

/**
 * 尿の検査の引用（AI が specimen = urine と指したもの。CD-023 の答え）で使う、短い名前。
 * 表にある「尿…」の名前から「尿」を除いた形（pH・比重・蛋白・潜血・糖・Na・K・Cr…）に加えて、尿の検査でよく書かれる別名。
 * 尿の引用の中では、これらを血液の項目より先に読む（「pH 5.5」を、血液の pH にしない）
 */
const URINE_SHORT: readonly (readonly [string, string])[] = [
  ['白血球', '尿白血球反応'],
  ['ケトン', '尿ケトン体'],
  ['ビリルビン', '尿ビリルビン'],
  ['RBC', '尿沈渣RBC'],
  ['WBC', '尿沈渣WBC'],
  ['赤血球', '尿沈渣RBC'],
];

function buildVocabulary(specimen: 'urine' | null = null): Vocabulary {
  const candidates: Candidate[] = [];
  const units = new Set<string>();
  for (const entry of [...LAB_NAMES, ...EXTRA_LAB_NAMES]) {
    for (const n of [entry.name, ...entry.aliases]) for (const key of nameKeysOf(n)) candidates.push({ key, name: entry.name, kind: entry.kind, pair: null });
    for (const u of entry.units) for (const key of unitKeysOf(u)) units.add(key);
  }
  for (const extra of EXTRA_ALIASES) {
    const entry = LAB_NAMES.find((e) => e.name === extra.name);
    if (entry === undefined) continue;
    for (const n of extra.aliases) for (const key of nameKeysOf(n)) candidates.push({ key, name: entry.name, kind: entry.kind, pair: null });
  }
  for (const u of EXTRA_UNITS) for (const key of unitKeysOf(u)) units.add(key);
  for (const p of PAIRS) for (const n of p.names) for (const key of nameKeysOf(n)) candidates.push({ key, name: p.parts[0], kind: 'vital', pair: p.parts });
  if (specimen === 'urine') {
    const urine: Candidate[] = [];
    for (const entry of [...LAB_NAMES, ...EXTRA_LAB_NAMES]) {
      for (const n of [entry.name, ...entry.aliases]) {
        // 尿量（バイタル）は、尿の検査の項目ではないので除く
        if (!n.startsWith('尿') || n.length < 2 || entry.kind === 'vital') continue;
        for (const key of nameKeysOf(n.slice(1))) urine.push({ key, name: entry.name, kind: entry.kind, pair: null });
      }
    }
    for (const [short, name] of URINE_SHORT) {
      const entry = [...LAB_NAMES, ...EXTRA_LAB_NAMES].find((e) => e.name === name);
      if (entry !== undefined) for (const key of nameKeysOf(short)) urine.push({ key, name: entry.name, kind: entry.kind, pair: null });
    }
    // 同じ書き方の血液の項目は、尿の引用の中では使わない（尿の項目を先に）
    const urineKeys = new Set(urine.map((c) => c.key));
    const kept = candidates.filter((c) => !urineKeys.has(c.key));
    candidates.length = 0;
    candidates.push(...kept, ...urine);
  }
  candidates.sort((a, b) => b.key.length - a.key.length);
  const sortedUnits = [...units].sort((a, b) => b.length - a.length);
  return { byFirst: groupByFirst(candidates, (c) => c.key), unitsByFirst: groupByFirst(sortedUnits, (u) => u) };
}

const VOCABULARIES: Readonly<Record<'blood' | 'urine', Vocabulary>> = { blood: buildVocabulary(), urine: buildVocabulary('urine') };

// 区切り：空白・改行・カンマ・読点・セミコロン・句点・丸括弧（全角の括弧は、そろえると半角になる）。
// 括弧を区切りにするのは、「BP 84/40（MAP 55）」「ALP 597（IFCC法）」の値を、括弧のために捨てないため。
// 括弧の中の項目（「WBC 12,300（Neut 85%）」の Neut）も、ほかの項目と同じに読む
// 見出しの括弧「【】」も区切り（「【血ガス】pH 7.31」の pH を読む）
const SEPARATORS = new Set([' ', '\n', ',', '、', ';', '。', '(', ')', '【', '】']);
// 名前と値のあいだに置いてよい文字
const GLUE = new Set([' ', ':', '=', '\n']);

const isSeparator = (c: string | undefined): boolean => c === undefined || SEPARATORS.has(c);
const isAsciiLetter = (c: string | undefined): boolean => c !== undefined && /^[a-z]$/u.test(c);
const isAsciiAlnum = (c: string | undefined): boolean => c !== undefined && /^[a-z0-9]$/u.test(c);

const NUMBER = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/uy;
const PAIR = /(\d+(?:\.\d+)?) ?\/ ?(\d+(?:\.\d+)?)/uy;
const COMPARATOR = /<=|>=|[<>≤≥≦≧]/uy;
// 定性の結果。「-」は、すぐ後ろに数が続かないときだけ（負の数と区別する）
const QUALITATIVE = /\((?:-|\+|±|\+-|\+\/-|[1-4]\+)\)|[1-4]\+|±|\+\/-|\+{1,4}|-(?![\d.])|陰性|陽性|negative|positive/uy;

const COMPARATORS: Readonly<Record<string, Comparator>> = { '<': '<', '>': '>', '<=': '<=', '>=': '>=', '≤': '<=', '≦': '<=', '≥': '>=', '≧': '>=' };

/** 値の前に置かれる、決まった書き方（項目の正規の名前ごと）。そろえた文（半角・小文字）で探す */
const VALUE_PREFIX: ReadonlyMap<string, RegExp> = new Map([
  ['GCS', /e ?[1-4] ?v ?(?:[1-5]|t) ?m ?[1-6] ?[=:(]? ?/uy],
  ['JCS', /(?:iii|ii|i|Ⅲ|Ⅱ|Ⅰ) ?- ?/uy],
]);

/** 量の単位を「/」でつないだ語（μg/kg/min・mL/hr・U/min）。表にない単位でも、項目の名前にしない */
const UNIT_LIKE = /^(?:[mμnk]?g|[mμd]?l|[mμ]?mol|m?eq|i?u|mu)(?:\/[a-zμ]+)+$/u;

/** 書かれた値の長さの上限（これより長い数は、検査値として読まない） */
const VALUE_TEXT_MAX = 20;
/** カタログにない名前（「名前: 値」）の長さの上限 */
const RAW_NAME_MAX = 30;

function matchName(lower: string, pos: number, vocab: Vocabulary): { candidate: Candidate; length: number } | null {
  for (const candidate of vocab.byFirst.get(lower.charAt(pos)) ?? []) {
    const end = pos + candidate.key.length;
    if (!lower.startsWith(candidate.key, pos)) continue;
    // 英字で終わる名前は、すぐ後ろに英字が続くなら別の語（「Kg」の K）。英字で始まる名前は、すぐ前が英字なら語の途中
    if (isAsciiLetter(lower[end - 1]) && isAsciiLetter(lower[end])) continue;
    if (isAsciiLetter(lower[pos]) && isAsciiLetter(lower[pos - 1])) continue;
    return { candidate, length: candidate.key.length };
  }
  return null;
}

function matchUnit(lower: string, pos: number): number {
  for (const u of VOCABULARIES.blood.unitsByFirst.get(lower.charAt(pos)) ?? []) {
    if (!lower.startsWith(u, pos)) continue;
    if (isAsciiAlnum(lower[pos + u.length])) continue;
    return u.length;
  }
  return 0;
}

function wordEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && !isSeparator(text[i])) i += 1;
  return i;
}

interface Value {
  readonly value: number | null;
  readonly comparator: Comparator | null;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly unitStart: number | null;
  readonly end: number;
}

type ValueRead = { readonly ok: true; readonly read: Value } | { readonly ok: false; readonly reason: UnreadReason; readonly end: number };

/** p から、値（不等号・数・定性）と単位を読む。 */
function readValue(lower: string, p: number, vocab: Vocabulary): ValueRead {
  let comparator: Comparator | null = null;
  let at = p;
  let comparatorEnd = p;
  COMPARATOR.lastIndex = at;
  const cm = COMPARATOR.exec(lower);
  if (cm !== null) {
    comparator = COMPARATORS[cm[0]] ?? null;
    at += cm[0].length;
    comparatorEnd = at;
    while (lower[at] === ' ') at += 1;
  }
  if (comparator === null) {
    QUALITATIVE.lastIndex = at;
    const qm = QUALITATIVE.exec(lower);
    if (qm !== null && (isSeparator(lower[at + qm[0].length]) || matchName(lower, at + qm[0].length, vocab) !== null)) {
      return { ok: true, read: { value: null, comparator: null, valueStart: at, valueEnd: at + qm[0].length, unitStart: null, end: at + qm[0].length } };
    }
  }
  NUMBER.lastIndex = at;
  const nm = NUMBER.exec(lower);
  // 読めなかったときの終わり：値がないときは、ここでは決めない（呼ぶ側が、名前の終わりにする）。不等号だけのときは、不等号の終わり
  if (nm === null) return comparator === null ? { ok: false, reason: 'no_value', end: -1 } : { ok: false, reason: 'bad_comparator', end: comparatorEnd };
  const valueEnd = at + nm[0].length;
  if (nm[0].length > VALUE_TEXT_MAX) return { ok: false, reason: 'no_value', end: wordEnd(lower, valueEnd) };
  // 単位（数のすぐ後ろ、または空白をはさんで）
  let r = valueEnd;
  while (lower[r] === ' ') r += 1;
  const unitLength = matchUnit(lower, r);
  if (unitLength > 0) return { ok: true, read: { value: Number(nm[0].replace(/,/gu, '')), comparator, valueStart: at, valueEnd, unitStart: r, end: r + unitLength } };
  // 数のすぐ後ろに、単位でも次の名前でもない文字が付いている（「1e3」「12abc」「2日目」）：一部だけ読んで残りを捨てない
  if (!isSeparator(lower[valueEnd]) && matchName(lower, valueEnd, vocab) === null) return { ok: false, reason: 'trailing', end: wordEnd(lower, valueEnd) };
  return { ok: true, read: { value: Number(nm[0].replace(/,/gu, '')), comparator, valueStart: at, valueEnd, unitStart: null, end: valueEnd } };
}

/**
 * 「名前: 値」「名前=値」の印の位置（なければ -1）。数字にはさまれた「:」「=」は、印にしない：
 * 時刻（「11:35」）・比（「1:2」）・式（「GCS E3V4M6=13」）を、名前と値と読まないため
 */
function nameValueMark(word: string): number {
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c !== ':' && c !== '=') continue;
    if (/\d/u.test(word[i - 1] ?? '') && /\d/u.test(word[i + 1] ?? '')) continue;
    return i;
  }
  return -1;
}

export interface LabReadOptions {
  /** 尿の検査の引用（AI が指したもの）なら urine：「pH」「比重」「蛋白」「白血球」などを、尿の項目の名前で読む */
  readonly specimen?: 'urine' | null;
}

export function readLabText(text: string, options: LabReadOptions = {}): LabRead {
  const vocab = options.specimen === 'urine' ? VOCABULARIES.urine : VOCABULARIES.blood;
  const lower = lowerAscii(foldSameLength(text));
  const rows: LabRow[] = [];
  const unread: LabUnread[] = [];
  // 名前のない語（数だけの語も）は、つながっているぶんを1つにまとめる
  const addUnknown = (start: number, end: number): void => {
    const last = unread.at(-1);
    if (last !== undefined && last.reason === 'unknown' && /^[ \n,、;。]*$/u.test(lower.slice(last.end, start))) unread[unread.length - 1] = { reason: 'unknown', start: last.start, end };
    else unread.push({ reason: 'unknown', start, end });
  };
  const skipGlue = (from: number): number => {
    let p = from;
    while (p < lower.length && GLUE.has(lower[p] ?? '')) p += 1;
    return p;
  };

  let pos = 0;
  while (pos < lower.length) {
    // 区切りと、語の頭の「:」「=」（「健診（6月）：Cr 0.86」のように、括弧のあとに続くつなぎの字）は飛ばす
    if (isSeparator(lower[pos]) || ((lower[pos] === ':' || lower[pos] === '=') && isSeparator(lower[pos - 1]))) {
      pos += 1;
      continue;
    }
    const m = matchName(lower, pos, vocab);
    if (m === null) {
      // カタログにない名前：「名前: 値」「名前=値」と書いたときだけ読む
      const end = wordEnd(lower, pos);
      const word = lower.slice(pos, end);
      const mark = nameValueMark(word);
      let nameEnd = mark > 0 ? pos + mark : -1;
      let valueFrom = nameEnd >= 0 ? nameEnd + 1 : -1;
      if (nameEnd < 0 && mark < 0) {
        // 「名前 : 値」（空白をはさんだ「:」「=」）
        let q = end;
        while (lower[q] === ' ') q += 1;
        if (lower[q] === ':' || lower[q] === '=') {
          nameEnd = end;
          valueFrom = q + 1;
        }
      }
      const rawName = nameEnd >= 0 ? text.slice(pos, nameEnd) : '';
      // 単位だけの語（「0.05 μg/kg/min ＝ 3.2 mL/hr」の μg/kg/min）は、項目の名前にしない
      const unitOnly = nameEnd >= 0 && (matchUnit(lower.slice(0, nameEnd), pos) === nameEnd - pos || UNIT_LIKE.test(lower.slice(pos, nameEnd).trim()));
      if (nameEnd < 0 || unitOnly || rawName.length > RAW_NAME_MAX || !/[^\d\s\-+./()<>]/u.test(rawName)) {
        addUnknown(pos, end);
        pos = end;
        continue;
      }
      let p = valueFrom;
      while (lower[p] === ' ') p += 1;
      const v = readValue(lower, p, vocab);
      if (!v.ok) {
        // 名前と「:」「=」までは、読めなかった部分に入れる（値の側の語は、次の周で扱う）
        const stop = Math.max(v.end, valueFrom);
        unread.push({ reason: v.reason, start: pos, end: stop });
        pos = stop;
        continue;
      }
      rows.push({
        name: null,
        nameRaw: rawName,
        kind: null,
        value: v.read.value,
        comparator: v.read.comparator,
        valueText: text.slice(v.read.valueStart, v.read.valueEnd),
        unit: v.read.unitStart === null ? null : text.slice(v.read.unitStart, v.read.end),
        start: pos,
        end: v.read.end,
      });
      pos = v.read.end;
      continue;
    }

    const nameEnd = pos + m.length;
    const nameRaw = text.slice(pos, nameEnd);
    const p = skipGlue(nameEnd);
    if (m.candidate.pair !== null) {
      PAIR.lastIndex = p;
      const pm = PAIR.exec(lower);
      if (pm === null) {
        unread.push({ reason: 'bad_pair', start: pos, end: nameEnd });
        pos = nameEnd;
        continue;
      }
      let q = p + pm[0].length;
      let r = q;
      while (lower[r] === ' ') r += 1;
      const unitLength = matchUnit(lower, r);
      let unit: string | null = null;
      if (unitLength > 0) {
        unit = text.slice(r, r + unitLength);
        q = r + unitLength;
      } else if (!isSeparator(lower[q]) && matchName(lower, q, vocab) === null) {
        const stop = wordEnd(lower, q);
        unread.push({ reason: 'trailing', start: pos, end: stop });
        pos = stop;
        continue;
      }
      const [first, second] = [pm[1] ?? '', pm[2] ?? ''];
      rows.push({ name: m.candidate.pair[0], nameRaw, kind: 'vital', value: Number(first), comparator: null, valueText: first, unit, start: pos, end: q });
      rows.push({ name: m.candidate.pair[1], nameRaw, kind: 'vital', value: Number(second), comparator: null, valueText: second, unit, start: pos, end: q });
      pos = q;
      continue;
    }
    // 値の前に、決まった書き方がある項目（「GCS E3V4M6＝13」の E3V4M6＝、「JCS Ⅱ-10」の Ⅱ-）は、それを飛ばして、書かれた数を読む。
    // 合計が書かれていなければ、読まない（E・V・M から足し算しない）
    let from = p;
    const prefix = VALUE_PREFIX.get(m.candidate.name);
    if (prefix !== undefined) {
      prefix.lastIndex = p;
      const pm = prefix.exec(lower);
      if (pm !== null) from = p + pm[0].length;
    }
    const v = readValue(lower, from, vocab);
    if (!v.ok) {
      const stop = Math.max(v.end, nameEnd);
      unread.push({ reason: v.reason, start: pos, end: stop });
      pos = stop;
      continue;
    }
    rows.push({
      name: m.candidate.name,
      nameRaw,
      kind: m.candidate.kind,
      value: v.read.value,
      comparator: v.read.comparator,
      valueText: text.slice(v.read.valueStart, v.read.valueEnd),
      unit: v.read.unitStart === null ? null : text.slice(v.read.unitStart, v.read.end),
      start: pos,
      end: v.read.end,
    });
    pos = v.read.end;
  }
  return { rows, unread };
}
