#!/usr/bin/env node
// phi-guard: 実在の患者に由来するデータがリポジトリに入るのを止める検査。
//
// 使い方
//   node scripts/phi-guard.mjs --staged     ステージ済みの内容を検査する（.githooks/pre-commit・pre-merge-commit から呼ぶ）
//   node scripts/phi-guard.mjs --all        作業ツリーの全ファイル（追跡中・未追跡・無視対象。依存とビルドの出力を除く）を検査する
//   node scripts/phi-guard.mjs --push       送るコミット（標準入力に pre-push の行）の、各コミットで変わったファイルとメッセージを検査する
//   node scripts/phi-guard.mjs --message <file>  コミットメッセージを検査する（.githooks/commit-msg から呼ぶ）
//   node scripts/phi-guard.mjs <path>...    指定したファイルを検査する（ない道・ディレクトリだけなら、使い方の誤り）
//   --strict                                警告も失敗として扱う
//
// 約束
//   - 外部依存を持たない（Node.js の標準モジュールだけを使う）。
//   - 見つけた文字列そのものは出力しない。出すのは場所と規則名だけ。
//   - 誤検知の行は、同じ行に「phi-guard: allow <理由>」と書いて許可する。理由のない allow はエラー。
//     allow が効くのは、その行の文字列の検査だけ。パス・サイズ・fixtures・バイナリの検査には効かない。
//   - .gitignore に頼らない（AGENTS.md）。--all は、無視対象のファイルも検査する（依存・ビルドの出力・OS のファイルを除く）。
//   - テキストは UTF-8（BOM を除く）と BOM つきの UTF-16 を読む。読めないバイナリ（NUL を含むもの）は、アイコン（apps/web/public の画像）を除いて置けない。
//   - 規則を変えたら docs/01-privacy-and-rules.md と AGENTS.md を合わせて更新する。

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// パスの検査

const FORBIDDEN_DIRS = new Set(['data', 'exports']);
// .sqlite・.db と、その版違い・付属ファイル（.sqlite3、-wal・-shm・-journal）も止める
const FORBIDDEN_EXT_RE = /\.(cbk|casebook|sqlite3?|db)(-(wal|shm|journal))?$/i;
const SYNTHETIC_RE = /^[ \t]*["']?synthetic["']?[ \t]*:[ \t]*true\b/m;
// 置いてよいバイナリ：アプリのアイコンだけ（画面の撮影・スクリーンショット・表計算のファイルなどは置かない）
const BINARY_ALLOWED_RE = /^apps\/web\/public\/[^/]+\.(png|ico|webp)$/i;

function toPosix(path) {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

// 大文字・小文字を問わない（大文字・小文字を区別しないファイルシステムでは、Fixtures/ も fixtures/ と同じ場所）
function isFixturePath(path) {
  return path.split('/').slice(0, -1).some((d) => d.toLowerCase() === 'fixtures');
}

export function checkPath(path) {
  const findings = [];
  const segments = toPosix(path).split('/');
  const base = segments[segments.length - 1];
  const dirs = segments.slice(0, -1).map((s) => s.toLowerCase());
  const lower = base.toLowerCase();

  if (dirs.some((d) => FORBIDDEN_DIRS.has(d))) {
    findings.push(fileFinding('error', 'forbidden-path', 'data/ と exports/ の下には置けない'));
  }
  if (lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example')) {
    findings.push(fileFinding('error', 'forbidden-path', '.env は置けない（.env.example だけ可）'));
  }
  if (FORBIDDEN_EXT_RE.test(lower)) {
    findings.push(fileFinding('error', 'forbidden-path', '.cbk / .casebook / .sqlite / .db（とその付属ファイル）は置けない'));
  }
  // ファイル名・ディレクトリ名も、文字列の検査に掛ける（名前は GitHub にそのまま出る）
  for (const f of scanText(segments.join(' '))) {
    findings.push(fileFinding(f.level, `path-${f.rule}`, `ファイル名・ディレクトリ名に、${f.message}`));
  }
  return findings;
}

function fileFinding(level, rule, message) {
  return { line: 0, col: 0, level, rule, message };
}

// ---------------------------------------------------------------------------
// 文字列の検査（1行ずつ。NFKC で全角の数字や記号をそろえてから調べる）

const DASH = '\\-‐‑‒–—−ー';
// 電話番号の区切り：ダッシュ・かっこ・空白と「.」（市外局番.市内局番.番号 の書き方。core と同じ。全体のレビュー、2026-10-16）
const PHONE_SEP = `[${DASH}().\\s]`;
// 見えない書式の文字（ソフトハイフン、ゼロ幅の空白・接続子、向きの印、語をつなぐ字、BOM など）。数字のあいだにはさむと、形が見えないまま崩れる。
// 取り除いてから調べる（core の text/normalize.ts の normalizeWithMap の dropInvisible と同じ集まり）
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

// ダッシュの変種（‐ ‑ ‒ – — ― − と長音の「ー」）を、数字のあいだ（空白2つまでをはさんでよい）と、英字・「日」「月」「)」と数字のあいだ、
// 数字と英字のあいだだけ「-」にそろえる（core の lint/anonymize.ts の foldDateDashes と同じ。字数は変えない）
const DASH_VARIANTS = '‐‑‒–—―−ー';
const DASH_FOLD = new RegExp(
  String.raw`(?<=[\dA-Za-z)日月]\.?\s{0,2})[${DASH_VARIANTS}](?=\s{0,2}\d)|(?<=\d\s{0,2})[${DASH_VARIANTS}](?=\s{0,2}[A-Za-z])`,
  'gu',
);
export function foldDateDashes(line) {
  return line.replace(DASH_FOLD, '-');
}
// 丸数字・かっこ数字・数字と「.」の番号（①、⑫、⑴、⒈、㉑、㊱、⓪、🄁）と、数字が続く上付き・下付きの数字（²、₂）は、
// NFKC の前に1字ずつ「・」にする（NFKC で数字になり、すぐ後の暦日・生年月日にくっつくので。core の lint/anonymize.ts の foldEnclosedNumbers と同じ。
// 9回目のレビュー P5）
const ENCLOSED_NUMBER = /[\u2460-\u249B\u24EA\u3251-\u325F\u32B1-\u32BF]|[\u00B2\u00B3\u00B9\u2070\u2074-\u2079\u2080-\u2089](?=[0-9\uFF10-\uFF19〇一二三四五六七八九十])|[\u{1F100}-\u{1F10A}]/gu;
export function foldEnclosedNumbers(line) {
  return line.replace(ENCLOSED_NUMBER, (c) => '・'.repeat(c.length));
}
// 「，．」の書き方の全角の読点・句点と小字形の「﹐」「﹒」は、NFKC の前に「、」「。」にする（文の終わりの「．」のすぐ後の暦日・生年月日を
// 小数の続きにしない。英数字にはさまれた「．」、1字の英字の後の「．」（かしら文字）、数字にはさまれた「，」はそのまま。
// core の text/normalize.ts の foldSentencePunct と同じ。11回目のレビュー R6）。
// 数字にはさまれた「．」「，」でも、すぐ後が暦日の形なら文の区切りとみなす（CRP 12.3．11/10 に、BMI 22．3.4.YYYY 生まれ。12回目のレビュー S5）。
// 値の小数点かもしれないもの（０．５－１錠、3．5/5γ）と、年・元号の年の後（YYYY．M.D、R7．11/8）は除く（13回目のレビュー T5、T6）。
// phi-guard は保存する文を作らないので、core の暦日の見分けの形（foldSentencePunct の mode 'detect'）と同じ
const SENTENCE_PUNCT = /[．﹒，﹐]/gu;
const PUNCT_ALNUM = /[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]/u;
const PUNCT_LATIN = /[A-Za-zＡ-Ｚａ-ｚ]/u;
const PUNCT_DIGIT = /[0-9０-９]/u;
const PD = '[0-9０-９]';
// 生まれの語（生食・生検・生化学・生活・出生体重などの語の頭は除く。core と同じ。14回目のレビュー V5）
// 生れ・産れも。誕生会・誕生日会・誕生祝い・生まれ故郷は除く（core の text/normalize.ts の BORN_CORE と同じ。15回目のレビュー W11、W12）。
// 生まれつき・生まれ育ち・生まれながら・生まれ持った・生まれて初めても除く（16回目のレビュー X6）
const BORN_CORE = String.raw`(?:[生産]ま?れ(?!故郷|変わ|つき|付|育|ながら|持|て(?:初|始|はじ))|誕生日?(?![\p{sc=Han}\p{sc=Katakana}ー])|出生(?!\p{sc=Han})|生(?![\p{sc=Han}\p{sc=Katakana}\p{sc=Hiragana}ー]))`;
const BORN_WORD = String.raw`\s?(?:[にで]\s*)?${BORN_CORE}`;
const DATE_AFTER_PUNCT = new RegExp(
  String.raw`^(?:(${PD}{1,4})\s?([./／\-－])\s?(${PD}{1,2})(\s?[./／\-－]\s?${PD}{1,4})?(?!${PD}|[.．﹒。/／]${PD}|[A-Za-zＡ-Ｚａ-ｚμ%％])` +
    String.raw`|${PD}{1,2}(?:st|nd|rd|th)?\s?[/\-]?\s?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?![a-z])` +
    String.raw`|${PD}{4,8}${BORN_WORD}|(?:19|20|１９|２０)${PD}{6}(?!${PD}))`,
  'iu',
);
// 数のすぐ後の助数詞と単位、に の後の量の変わり方、曜日（core の text/normalize.ts と同じ）
const COUNTER_ONE = '本|回|管|個|切|点|包|周|枚|倍|量|袋|筒|杯|滴|秒';
const COUNTER_WORD = '錠(?!剤)|単位|程度|ずつ|以下|以上|未満|日分|項目|セット|アンプル|バイアル|カプセル';
const UNITS_MULTI = 'mEq|mmol|μg|mcg|mg|mL|ml|dL|cm|mm';
const UNITS_ONE = 'g|L|A|V|%';
const COUNTER = String.raw`(?:(?:${COUNTER_ONE})(?!(?!目)\p{sc=Han})|\s(?:${COUNTER_ONE})(?=$|[\s、。,.):;/\d])|\s?(?:${COUNTER_WORD})(?![ァ-ヶー])|\s?(?:${UNITS_MULTI})(?![A-Za-z])|\s?γ(?![A-Za-z\p{sc=Katakana}ー-])|(?:${UNITS_ONE})(?![A-Za-z\p{sc=Katakana}ー-]|型|群|病棟|棟))`;
const NI_NOT_DATE = '減|増|な[っりる]|低下|上昇|軽減|改善|悪化|縮小|短縮|拡大|調整|変更|分割|希釈|半減|漸|及|相当|達|潰瘍|狭窄|以下|以上|程度|病変|浸潤|限局';
const WEEKDAY = String.raw`\(\s*[月火水木金土日](?:曜日?)?\s*\)`;
// 「-」の組の後の目標の値の書き方（に維持、にコントロール、まで延長）と、「/」「.」の組の後の時の語の語の終わり（日中・週末・時間外・月末は除く）、
// 「を目標に」（core と同じ。14回目のレビュー V7、V8）
const NI_TARGET = '維持|設定|コントロール|保|是正|緩和|補正|延長|管理|安定|留|収|抑|調節|目標';
const DASH_DATE_AFTER = new RegExp(
  String.raw`^\s*(?:${WEEKDAY}|に(?!(?:${NI_NOT_DATE}|${NI_TARGET}))|から|より|まで(?!\s*(?:${NI_NOT_DATE}|${NI_TARGET}|回復))|頃|ごろ|入院|退院|受診|来院|転院|転科|手術|施行|開始|終了|中止|再開|予定|提出|採取|採血|以降|以後)`,
  'u',
);
const TIME_WORD_END = String.raw`(?=$|[間目後前毎以程分半]|[^\p{sc=Han}\p{sc=Katakana}ー])`;
const VALUE_AFTER_PAIR = new RegExp(
  String.raw`^(?:${COUNTER}|\s(?:L|g)(?![A-Za-z\p{sc=Katakana}ー-])|\s?(?:歳|才|度|°C|kg|割)|\s?(?:時間|分(?!娩)|週|か月|ヶ月|カ月|ヵ月|ケ月|日|月)${TIME_WORD_END}|\s*を?\s*目標(?!\s*に))`,
  'u',
);
const DECIMAL_BEFORE = new RegExp(String.raw`${PD}[.．]${PD}+$`, 'u');
const YEAR_BEFORE = new RegExp(String.raw`(?<!${PD})(?:19|20|１９|２０)${PD}{2}$`, 'u');
const ERA_LETTER_BEFORE = new RegExp(String.raw`(?<![A-Za-zＡ-Ｚａ-ｚ0-9０-９])([MTSHRＭＴＳＨＲ])\s?(${PD}{1,2})$`, 'u');
const ERA_WORD_BEFORE = new RegExp(String.raw`(?:(?<!\p{sc=Han})[明大昭平令]|明治|大正|昭和|平成|令和)\s?${PD}{1,2}$`, 'u');
const ERA_LETTER_MAX = { M: 45, T: 15, S: 64, H: 31, R: 10 };
const YEAR_WORD_BEFORE = /(?:年|西暦|生年月日|誕生日|出生日?|生ま?れ|D\.?O\.?B\.?|birth\s*(?:day|date)?)\s*[)）】\]]?\s*[:：=]?\s*$/iu;
const BORN_AFTER_PAIR = new RegExp(String.raw`^${BORN_WORD}`, 'u');
const LINE_HEAD_BEFORE = /(?:^|\n)[\s・*+-]*$/u;
const lineHeadAt = (text, from) =>
  LINE_HEAD_BEFORE.test(text.slice(Math.max(0, from - 12), from)) && (from < 12 || text.lastIndexOf('\n', from - 1) >= from - 12);
function yearOrEraBefore(text, at, dotted, pairAfter) {
  const before = text.slice(Math.max(0, at - 8), at);
  const y = YEAR_BEFORE.exec(before);
  const wordBefore = (from) => YEAR_WORD_BEFORE.test(text.slice(Math.max(0, from - 12), from).normalize('NFKC'));
  const born = BORN_AFTER_PAIR.test(pairAfter);
  if (y !== null) return dotted || born || wordBefore(at - y[0].length) || lineHeadAt(text, at - y[0].length);
  if (ERA_WORD_BEFORE.test(before)) return true;
  const e = ERA_LETTER_BEFORE.exec(before);
  if (e === null) return false;
  const letter = (e[1] ?? '').normalize('NFKC');
  const n = Number((e[2] ?? '').normalize('NFKC'));
  if (n < 1 || n > (ERA_LETTER_MAX[letter] ?? 0)) return false;
  return letter !== 'S' || n > 4 || born || wordBefore(at - e[0].length);
}
// 生まれの語の前の年の「．」「，」の前が月日・日月（M．D．YYYY、M/D．YYYY、Mon D，YYYY）なら、年月日の中の区切り（core と同じ。14回目のレビュー V6）
const BORN_YEAR_AFTER = new RegExp(String.raw`^(?:19|20|１９|２０)${PD}{2}${BORN_WORD}`, 'u');
const EN_MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_DAY_BEFORE = new RegExp(
  String.raw`(?:(?<![0-9])[0-9]{1,2}\s?[./,・-]\s?[0-9]{1,2}|(?<![a-z])${EN_MONTH}\.?\s?[/-]?\s?[0-9]{1,2}(?:st|nd|rd|th)?|(?<![0-9])[0-9]{1,2}(?:st|nd|rd|th)?\s?[/-]?\s?${EN_MONTH}\.?)\s?$`,
  'iu',
);
const EN_MONTH_BEFORE = new RegExp(String.raw`(?<![a-z])${EN_MONTH}\.?\s?$`, 'iu');
function dateAfterPunct(text, at, digits) {
  const m = DATE_AFTER_PUNCT.exec(text.slice(at + 1, at + 25));
  if (m === null) return false;
  const pairEnd = at + 1 + m[0].length;
  const pairAfter = text.slice(pairEnd, pairEnd + 16).normalize('NFKC');
  const sep = (m[2] ?? '').normalize('NFKC');
  if (yearOrEraBefore(text, at, sep === '.', pairAfter)) return false;
  if (m[1] === undefined) return !(BORN_YEAR_AFTER.test(m[0]) && MONTH_DAY_BEFORE.test(text.slice(Math.max(0, at - 14), at).normalize('NFKC')));
  const [aText, bText] = [(m[1] ?? '').normalize('NFKC'), (m[3] ?? '').normalize('NFKC')];
  const [a, b] = [Number(aText), Number(bText)];
  if (!((a >= 1 && a <= 12 && b >= 1 && b <= 31) || ((aText.length === 2 || aText.length === 4) && b >= 1 && b <= 12))) return false;
  if (!digits || DECIMAL_BEFORE.test(text.slice(Math.max(0, at - 12), at))) return true;
  if (sep === '-' && m[4] === undefined) return DASH_DATE_AFTER.test(pairAfter);
  return !VALUE_AFTER_PAIR.test(pairAfter);
}
// 空白をはさんだ「．」「，」の年月日の並びは区切りにせず書いたまま（半角の「YYYY. M. D」と同じに見分ける。core の text/normalize.ts の
// inSpacedDate と同じ。16回目のレビュー X4）【案】
const HSPACE = /[ \t\u3000]/u;
const SPACED_SEP = String.raw`[ \t\u3000]*[.．﹒,，﹐][ \t\u3000]*`;
const RUN_ERA = String.raw`(?:(明治|大正|昭和|平成|令和|(?<!\p{sc=Han})[明大昭平令])|(?<![A-Za-zＡ-Ｚａ-ｚ0-9０-９])([MTSHRＭＴＳＨＲ]))[ \t\u3000]?`;
// 数のすぐ前の元号（空白1つをはさんでよい。並びの始まりの候補）と、並びの区切りの字
const ERA_BEFORE_NUMBER = /(?:明治|大正|昭和|平成|令和|[明大昭平令MTSHRＭＴＳＨＲ])[ \t\u3000]?$/u;
const RUN_SEP_CHAR = /[.．﹒,，﹐]/u;
const SPACED_RUN = new RegExp(
  String.raw`(?<![0-9０-９]|[0-9０-９][.．﹒,，﹐])(?:${RUN_ERA})?(${PD}{1,4})${SPACED_SEP}(${PD}{1,2})(?:${SPACED_SEP}(${PD}{1,4}))?(?![0-9０-９]|[.．﹒,，﹐][0-9０-９])`,
  'uy',
);
// 生まれた日の見出し（年の語「年」「西暦」と、ドブタミンの略でもある DOB は含めない）と、DOB の見出し
const BIRTH_LABEL_BEFORE = /(?:生年月日|誕生日|出生日?|生ま?れ|birth\s*(?:day|date)?)\s*[)）】\]]?\s*[:：=]?\s*$/iu;
const DOB_LABEL_BEFORE = /(?<![A-Za-z])D\.?O\.?B\.?\s*[)）】\]]?\s*[:：=]?\s*$/iu;
const EN_MONTH_DAY_BEFORE = new RegExp(String.raw`(?<![a-z])${EN_MONTH}\.?\s?[0-9]{1,2}(?:st|nd|rd|th)?\s*$`, 'iu');
// 空白のある区切りと空白のない区切りの混ざった3つの数の並び（BNP 2000． 11．10 に再検）は、年・生まれの語、見出しの後か行頭のときだけ（core と同じ）
function mixedSpacing(run) {
  const spaced = [];
  for (let i = 0; i < run.length; i += 1) {
    if (RUN_SEP_CHAR.test(run.charAt(i))) spaced.push(HSPACE.test(run.charAt(i - 1)) || HSPACE.test(run.charAt(i + 1)));
  }
  return spaced.length === 2 && spaced[0] !== spaced[1];
}
function spacedRunIsDate(text, start, m) {
  const [a, b, c] = [m[3], m[4], m[5]].map((x) => (x === undefined ? undefined : x.normalize('NFKC')));
  if (a === undefined || b === undefined) return false;
  const month = (x) => x.length <= 2 && Number(x) >= 1 && Number(x) <= 12;
  const day = (x) => x.length <= 2 && Number(x) >= 1 && Number(x) <= 31;
  const year4 = (x) => /^(?:18|19|20)\d{2}$/u.test(x);
  const era = m[1] !== undefined || m[2] !== undefined;
  const shape = era
    ? a.length <= 2 && Number(a) >= 1 && month(b) && (c === undefined || day(c))
    : c === undefined
      ? year4(a) ? month(b) : month(a) && day(b)
      : ((year4(a) || a.length === 2) && month(b) && day(c)) || ((year4(c) || c.length === 2) && ((month(a) && day(b)) || (day(a) && month(b))));
  if (!shape) return false;
  const end = start + m[0].length;
  const [before, after] = [text.slice(Math.max(0, start - 12), start).normalize('NFKC'), text.slice(end, end + 16).normalize('NFKC')];
  const birth = BORN_AFTER_PAIR.test(after) || BIRTH_LABEL_BEFORE.test(before);
  const dob = DOB_LABEL_BEFORE.test(before);
  const label = birth || YEAR_WORD_BEFORE.test(before);
  if (/[,，﹐]/u.test(m[0]) && !birth && !dob) return false;
  if (era) {
    if (a.length > 2 || Number(a) < 1) return false;
    const letter = (m[2] ?? '').normalize('NFKC');
    if (letter !== '' && (Number(a) > (ERA_LETTER_MAX[letter] ?? 0) || (letter === 'S' && Number(a) <= 4 && !label))) return false;
    if (c !== undefined) return month(b) && day(c);
    return month(b) && letter !== 'T' && !VALUE_AFTER_PAIR.test(after);
  }
  if (c === undefined) return year4(a) ? (birth || dob) && month(b) : birth && month(a) && day(b);
  if (!label && !dob && mixedSpacing(m[0]) && !lineHeadAt(text, start)) return false;
  if ((year4(a) || (a.length === 2 && label)) && month(b) && day(c)) return true;
  return (year4(c) || (c.length === 2 && label)) && ((month(a) && day(b)) || (day(a) && month(b)));
}
// at の「．」「，」が、空白をはさんだ年月日の並びの中の区切りか。runs は1回の畳みの中で見た並びの始まり → 年月日の並びの終わり（ないなら -1。core と同じ）
function inSpacedDate(text, at, runs) {
  let [b, a] = [at - 1, at + 1];
  while (b >= 0 && HSPACE.test(text.charAt(b))) b -= 1;
  while (a < text.length && HSPACE.test(text.charAt(a))) a += 1;
  if (!PUNCT_DIGIT.test(text.charAt(b)) || !PUNCT_DIGIT.test(text.charAt(a))) return false;
  const c = text.charAt(at);
  if ((c === '，' || c === '﹐') && EN_MONTH_DAY_BEFORE.test(text.slice(Math.max(0, b - 16), b + 1).normalize('NFKC'))) {
    return /^(?:19|20)[0-9]{2}(?![0-9])/u.test(text.slice(a, a + 5).normalize('NFKC'));
  }
  const starts = [];
  let i = b;
  for (let k = 0; k < 2; k += 1) {
    while (i > 0 && PUNCT_DIGIT.test(text.charAt(i - 1))) i -= 1;
    starts.push(i);
    const e = ERA_BEFORE_NUMBER.exec(text.slice(Math.max(0, i - 3), i));
    if (e !== null) starts.push(i - e[0].length);
    i -= 1;
    while (i >= 0 && HSPACE.test(text.charAt(i))) i -= 1;
    if (!RUN_SEP_CHAR.test(text.charAt(i))) break;
    i -= 1;
    while (i >= 0 && HSPACE.test(text.charAt(i))) i -= 1;
    if (!PUNCT_DIGIT.test(text.charAt(i))) break;
  }
  for (const s of starts) {
    let end = runs.get(s);
    if (end === undefined) {
      SPACED_RUN.lastIndex = s;
      const m = SPACED_RUN.exec(text);
      end = m !== null && spacedRunIsDate(text, s, m) ? s + m[0].length : -1;
      runs.set(s, end);
    }
    if (end > at) return true;
  }
  return false;
}
const UNIT_BEFORE_PUNCT = /(?<![A-Za-z])(?:mg|g|mL|ml|L|dL|kg|mEq|mmol|mcg|cm|mm|mmHg|bpm|U|IU)$/u;
export function foldSentencePunct(text) {
  if (!/[．﹒，﹐]/u.test(text)) return text;
  const runs = new Map();
  return text.replace(SENTENCE_PUNCT, (c, at) => {
    const [before, after] = [text.charAt(at - 1), text.charAt(at + 1)];
    const digits = PUNCT_DIGIT.test(before) && PUNCT_DIGIT.test(after);
    if (!digits && (HSPACE.test(before) || HSPACE.test(after)) && inSpacedDate(text, at, runs)) return c;
    if (c === '，' || c === '﹐') {
      if (digits) return dateAfterPunct(text, at, true) ? '、' : c;
      return PUNCT_LATIN.test(before) && PUNCT_DIGIT.test(after) && EN_MONTH_BEFORE.test(text.slice(Math.max(0, at - 12), at).normalize('NFKC')) ? c : '、';
    }
    if (digits) return dateAfterPunct(text, at, true) ? '。' : c;
    if (PUNCT_LATIN.test(before) && PUNCT_DIGIT.test(after) && UNIT_BEFORE_PUNCT.test(text.slice(Math.max(0, at - 6), at).normalize('NFKC')) && dateAfterPunct(text, at, false)) return '。';
    const initial = PUNCT_LATIN.test(before) && !PUNCT_LATIN.test(text.charAt(at - 2));
    return (PUNCT_ALNUM.test(before) && PUNCT_ALNUM.test(after)) || initial ? c : '。';
  });
}

// 生年月日らしい日付の上限の年。受持時年齢は15歳以上なので、今年から15を引いた年より前の日付を疑う。
export function defaultDobMaxYear() {
  return new Date().getFullYear() - 15;
}

const ERA_START = {
  明治: 1868, 大正: 1912, 昭和: 1926, 平成: 1989, 令和: 2019, M: 1868, T: 1912, S: 1926, H: 1989, R: 2019,
  明: 1868, 大: 1912, 昭: 1926, 平: 1989, 令: 2019,
};
// 元号の年月日。1字の元号（漢字に続くものは除く）と「.」を付けた英字の元号も（core の lint/anonymize.ts と同じ）。
// 1字の英字の元号は、英字・数字・カタカナ・「ー」に続くもの（ヒューマリンR、3T）を除き、「.」を付けないときは「-」の区切りを読まない。
// 半角カナの濁点（ﾄﾞ）は、core では1字ずつ NFKC にするので結合文字（U+3099、U+309A）になる。ここでも結合文字の後を除く
const ERA_DATE = /(?<![A-Za-z])(?:(明治|大正|昭和|平成|令和)|(?<!\p{sc=Han})([明大昭平令])|(?<![\d\p{sc=Katakana}ー])(?<!\p{M})([MTSHR])\.?)\s*(元|\d{1,2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})(?!\d)/gu;
function eraDateShape(m) {
  return !(m[3] !== undefined && m[0].charAt(1) !== '.' && m[0].includes('-'));
}
// 生年月日の見分けで「生」とみなす語（生検・生食・生化学・生活などの語の頭は除く）。「出生」も（出生時・出生歴・出生体重などは除く。
// core と同じ。11回目のレビュー N1）
const BORN = String.raw`\s*(?:[にで]\s*)?${BORN_CORE}`;

// 英語の月の名前と月日（core の lint/anonymize.ts と同じ）。前の「.」は、数字か英字のすぐ後のものだけ見分けを止める（11回目のレビュー R6）
const ENGLISH_MONTH = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)(?![A-Za-z])`;
const ENGLISH_DATE_MONTH_FIRST = String.raw`(?<![A-Za-z])(${ENGLISH_MONTH})\.?(?:\s*[/-]\s*|\s*)(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:(?:\s*[,/-]\s*|\s+)(\d{4})(?!\d))?`;
const ENGLISH_DATE_DAY_FIRST = String.raw`(?<![\dA-Za-z/])(?<![\dA-Za-z]\.)(\d{1,2})(?:st|nd|rd|th)?(?:\s*[/-]\s*|\s+of\s+|\s*)(${ENGLISH_MONTH})\.?(?:(?:\s*[,/-]\s*|\s+)(\d{4})(?!\d))?`;
const ENGLISH_DATE_YEAR_FIRST = String.raw`(?<![\d/-])(?<![\dA-Za-z]\.)(\d{4})\s*[/-]\s*(${ENGLISH_MONTH})\.?\s*[/-]\s*(\d{1,2})(?:st|nd|rd|th)?(?![\d/])`;
const EN_MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const englishMonthNumber = (name) => EN_MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase()) + 1;
// order は見つけた形（month: 月が先、day: 日が先、year: 年が先）
function englishDateParts(m, order) {
  const [monthName, dayText, yearText] = order === 'day' ? [m[2], m[1], m[3]] : order === 'year' ? [m[2], m[3], m[1]] : [m[1], m[2], m[3]];
  return { month: englishMonthNumber(monthName), day: Number(dayText), year: yearText === undefined ? null : Number(yearText) };
}
const EN_MONTH_FIRST = new RegExp(ENGLISH_DATE_MONTH_FIRST, 'gu');
const EN_DAY_FIRST = new RegExp(ENGLISH_DATE_DAY_FIRST, 'gu');
const EN_YEAR_FIRST = new RegExp(ENGLISH_DATE_YEAR_FIRST, 'gu');
const EN_MONTH_NAME = new RegExp(ENGLISH_MONTH, 'iu');

// 生年月日の見出しの語のある行（core の lint/anonymize.ts と同じ）。DOB（ドブタミンの略でもある）は行ごとの見出しにしない
const BIRTH_LINE = /生年月日|誕生日(?![\p{sc=Han}\p{sc=Katakana}ー])|D\.O\.B/iu;
// 文の終わりの「.」は続けてよい（M.D.YYYY.）。区切りの中黒「・」も「.」と同じ（core と同じ。10回目のレビュー Q8）。
// 前の「.」は、数字のすぐ後のものだけ見分けを止める（文の終わりの「.」「...」の後は見る。core と同じ。11回目のレビュー R6）
const BIRTH_DATE_FORMS = String.raw`(?<!\d)(?<!\d\.)\d{1,4}\s*[-/.・年]\s*\d{1,2}\s*[-/.・月]\s*\d{1,2}(?!\d|\.\d)|(?<!\d)(?<!\d\.)\d{1,2}\s*[-/.・]\s*\d{1,2}\s*[-/.・]\s*\d{4}(?!\d|\.\d)|(?<!\d)\d{1,2}\s*月\s*(?:の\s*)?\d{1,2}\s*日|(?:明治|大正|昭和|平成|令和|[明大昭平令]|[MTSHR]\.?)\s*(?:元|\d{1,2})\s*[年./・-]\s*\d{1,2}\s*[月./・-]\s*\d{1,2}(?!\d)|${ENGLISH_DATE_YEAR_FIRST}|${ENGLISH_DATE_MONTH_FIRST}|${ENGLISH_DATE_DAY_FIRST}`;
const BIRTH_LINE_DATE = new RegExp(BIRTH_DATE_FORMS, 'gu');
// 3つの数で終わりが4桁でなければ、年/月/日 か 月/日/年（3/4/53）
function birthDateValid(text) {
  const en = EN_MONTH_NAME.exec(text);
  const nums = (text.match(/\d+/g) ?? []).map((s) => ({ s, n: Number(s) }));
  if (en !== null) {
    const day = nums.find((x) => x.s.length <= 2);
    return day !== undefined && validMonthDay(englishMonthNumber(en[0]), day.n);
  }
  if (nums.length === 2) return validMonthDay(nums[0].n, nums[1].n);
  const [a, b, c] = nums;
  if (a === undefined || b === undefined || c === undefined) return false;
  return c.s.length === 4 ? validMonthDay(a.n, b.n) : validMonthDay(b.n, c.n) || validMonthDay(a.n, b.n);
}

// 生年月日の見出しのすぐ後と、「生」「生まれ」「誕生」のすぐ前の、暦日らしい並び（core の lint/anonymize.ts の birthDateSpans の写し）。
// 形によらず並び全体を疑う（数字、漢数字、区切り、英語の月、元号。数は3つまで。「/ . -」と「空白・,」の区切りは混ぜない）。
// 暦日らしいもの（月・日として成り立つ数など）だけで、すぐ後に単位・助数詞が続くものは除く。
// DOB は、すぐ後の並びが年・元号・英語の月を含むときだけ見出し（「DOBは」、量、年のない月日、量の変わり方の語が続くもの、小文字の月の略は除く）
const KANJI_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const kanjiDigits = (s) => (/^[〇零一二三四五六七八九]+$/u.test(s) ? Number(s.replace(/[〇零一二三四五六七八九]/gu, (c) => String(KANJI_DIGIT[c] ?? 0))) : NaN);
function kanjiValue(s) {
  if (s === '元') return 1;
  const k = s.indexOf('十');
  if (k < 0) return kanjiDigits(s);
  const tens = k === 0 ? 1 : kanjiDigits(s.slice(0, k));
  const ones = k === s.length - 1 ? 0 : kanjiDigits(s.slice(k + 1));
  return tens * 10 + ones;
}
const SPAN_ERA = /(?:明治|大正|昭和|平成|令和|[明大昭平令]|[MTSHR](?![A-Za-z])\.?)\s{0,2}/iuy;
const SPAN_NUM = /(\d{1,8})(?!\d)(?:st|nd|rd|th)?/iuy;
const SPAN_KANJI = /[〇零一二三四五六七八九十]{1,6}(?![〇零一二三四五六七八九十])|元/uy;
const SPAN_MONTH = new RegExp(String.raw`${ENGLISH_MONTH}\.?`, 'iuy');
const CASED_MONTH = new RegExp(String.raw`^${ENGLISH_MONTH}`, 'u');
const SPAN_SEP_JA = /\s{0,2}[年月]\s{0,2}/uy;
// 区切りの中黒「・」（見出しの後の YYYY・M・D の形）も「.」と同じ（core と同じ。10回目のレビュー Q8）
const SPAN_SEP_PUNCT = /\s{0,2}[/.\-・]\s{0,2}/uy;
const SPAN_SEP_SPACE = /\s{0,2},\s{0,2}|\s{1,3}/uy;
const SPAN_DAY_JA = /\s{0,2}日(?!曜)/uy;
const SPAN_DAY = /日(?!曜)/uy;
const SPAN_UNIT_AFTER = /^\s*(?:kg|g(?![A-Za-z])|cm|mm|%|γ|μg|mcg|mg|mL|ml|L(?![A-Za-z])|歳|才|か月|ヶ月|カ月|ヵ月|週|時間|分|秒|回|本|錠|円|点|倍)/u;
const SPAN_BORN = new RegExp(BORN, 'uy');
const SPAN_START = new RegExp(
  String.raw`(?<![\d〇零一二三四五六七八九十A-Za-z/-])(?<![\d〇零一二三四五六七八九十]\.)(?:\d|[〇零一二三四五六七八九十元]|明治|大正|昭和|平成|令和|(?<!\p{sc=Han})[明大昭平令]|(?<![\p{sc=Katakana}ー])(?<!\p{M})[MTSHR](?![A-Za-z])|${ENGLISH_MONTH})`,
  'giu',
);
// DOB のすぐ後の「/」は、年齢の語が続くとき（DOB/Age）だけ見出しの続き。年齢の語を添えた DOB（DOB/Age、DOB (age)、DOB／年齢）は
// 生年月日の見出しの語と同じ（core と同じ。8回目のレビュー M7）
const DOB_WORD = String.raw`(?<![/A-Za-z\d])DOB(?![A-Za-z\d]|\/(?!\s*(?:age|年齢)))`;
const DOB_AGE_LABEL = String.raw`${DOB_WORD}\s*(?:[/／・、,]\s*(?:age|年齢)|[(（]\s*(?:age|年齢)\s*[)）])`;
const BIRTH_LABEL_AT = new RegExp(
  String.raw`生年月日|誕生日(?![\p{sc=Han}\p{sc=Katakana}ー])|出生日|D\.O\.B\.?|\bbirth\s*(?:day|date)|\bdate\s+of\s+birth|\bb-?day|\bborn(?:\s+on)?|生ま?れ\s*(?:は|:)|(?:出生|誕生|生誕)(?![\p{sc=Han}\p{sc=Katakana}ー])|${DOB_AGE_LABEL}|(?<dob>${DOB_WORD})`,
  'giu',
);
// 見出しを閉じるかっこ（【生年月日】）、数字のない短いかっこ書き（生年月日(年齢):）、区切りと添えた語（生年月日/年齢:、生年月日、）、
// 字・数字のない短い記号の並び（|、-、→、;、…、::）は3つまで続けてよい（core と同じ）
const LABEL_CLOSE = String.raw`[)\]）】〕〉》」』>＞≫»〗]`;
const LABEL_SYMBOLS = String.raw`(?:\.{2,3}|[|¦:;=<*#\-‐‑‒–—―−→⇒⇨➡➔⟶]{1,3})`;
const LABEL_EXTRA = String.raw`(?:\s*(?:${LABEL_CLOSE}|[(（][^()（）\d\n]{1,8}[)）]|[/／・、,](?:\s*(?:年齢|性別|age|sex))?|${LABEL_SYMBOLS})){0,3}`;
// 見出しの語と並びのあいだの「は」「:」「=」「is」と、並びの始まりの開きかっこ（core と同じ）
const LABEL_IS = String.raw`(?:は|:|=|is(?![A-Za-z]))`;
const SPAN_OPEN = String.raw`(?:[([【〔〈《「『]\s*)?`;
const AFTER_LABEL = new RegExp(String.raw`${LABEL_EXTRA}\s*(?:${LABEL_IS}\s*)?${SPAN_OPEN}`, 'iuy');
// 文の始まりの見出しの語は、並びとのあいだに1つの「。」「.」をはさんでもよい（生年月日．YYYY/3/4。core と同じ。11回目のレビュー R6）
const AFTER_LABEL_STOP = new RegExp(String.raw`${LABEL_EXTRA}\s*(?:(?:${LABEL_IS}|[。.])\s*)?${SPAN_OPEN}`, 'iuy');
const LABEL_HEAD_BEFORE = /(?:^|[\s。.、,:;・|(（[［【「『])$/u;
// DOB の後は「:」「=」と、1つの「。」「.」（ＤＯＢ．YYYY/3/4。DOB の見出しは年・元号・英語の月のある並びだけなので、文の中でもよい。11回目のレビュー R6）
const AFTER_DOB = new RegExp(String.raw`(?:\s*(?:${LABEL_CLOSE}|${LABEL_SYMBOLS})){0,3}\s*(?:[:=。.]\s*)?${SPAN_OPEN}`, 'iuy');
// 量の変わり方の語（DOB 10-5-3と漸減、DOB 10-5-3→off。core と同じ）
const DOSE_CHANGE_AFTER =
  /^\s*(?:(?:[とでに]|から)\s*)?(?:漸減|減量|漸増|増量|中止|離脱|off(?![A-Za-z])|OFF(?![A-Za-z]))|^\s*(?:→|->|⇒)\s*(?:off(?![A-Za-z])|OFF(?![A-Za-z])|中止|\d+(?:\.\d+)?\s*γ)/u;

function sticky(re, s, at) {
  re.lastIndex = at;
  return re.exec(s);
}
function scanDateSpan(line, at, max = 3) {
  for (const withEra of [true, false]) {
    let i = at;
    const e = withEra ? sticky(SPAN_ERA, line, at) : null;
    if (withEra && e === null) continue;
    if (e !== null) i += e[0].length;
    const units = [];
    let mode = null;
    let ja = false;
    let end = i;
    while (units.length < max) {
      let j = end;
      let sepMode = null;
      if (units.length > 0) {
        for (const [re, m] of [[SPAN_SEP_JA, 'ja'], [SPAN_SEP_PUNCT, 'punct'], [SPAN_SEP_SPACE, 'space']]) {
          const s = sticky(re, line, end);
          if (s !== null) {
            sepMode = m;
            j = end + s[0].length;
            break;
          }
        }
        if (sepMode === null) sepMode = 'none';
        if ((sepMode === 'punct' && mode === 'space') || (sepMode === 'space' && mode === 'punct')) break;
      }
      const mon = sticky(SPAN_MONTH, line, j);
      const num = mon === null ? sticky(SPAN_NUM, line, j) : null;
      const kan = mon === null && num === null ? sticky(SPAN_KANJI, line, j) : null;
      const hit = mon ?? num ?? kan;
      if (hit === null) break;
      if (sepMode === 'none' && mon === null && units.at(-1)?.month !== true) break;
      const unit =
        mon !== null ? { n: englishMonthNumber(mon[0]), digits: null, month: true, lower: !CASED_MONTH.test(mon[0]) } : num !== null ? { n: Number(num[1]), digits: num[1].length, month: false } : { n: kanjiValue(hit[0]), digits: null, month: false };
      units.push(unit);
      if (sepMode === 'punct' || sepMode === 'space') mode = sepMode;
      if (sepMode === 'ja') ja = true;
      end = j + hit[0].length;
    }
    if (units.length === 0) continue;
    const day = sticky(ja ? SPAN_DAY_JA : SPAN_DAY, line, end);
    return { end: day === null ? end : end + day[0].length, units, era: e !== null, eraName: e === null ? null : e[0].replace(/[\s.]/gu, '').toUpperCase() };
  }
  return null;
}
// 並びの西暦の年（元号の年、4桁の数、区切りのない8桁の頭の4桁。年が2桁か、年のないものは null。core と同じ。10回目のレビュー Q9）
function spanYear(span) {
  const nums = span.units.filter((u) => !u.month);
  const first = nums[0];
  if (span.eraName !== null) {
    if (first === undefined) return null;
    const lead = first.digits === 5 ? 1 : first.digits === 6 ? 2 : 0;
    const n = lead > 0 ? Number(String(first.n).padStart(first.digits ?? 0, '0').slice(0, lead)) : first.n;
    const start = ERA_START[span.eraName];
    return start === undefined || Number.isNaN(n) ? null : start + n - 1;
  }
  const four = nums.find((u) => u.digits === 4);
  if (four !== undefined) return four.n;
  const eight = nums.find((u) => u.digits === 8);
  return eight === undefined ? null : Number(String(eight.n).padStart(8, '0').slice(0, 4));
}
const md = (m, d) => m !== undefined && d !== undefined && validMonthDay(m.n, d.n);
// 元号の後は年が1桁の5桁（YMMDD）と6桁（YYMMDD）
function compactValid(u, era = false) {
  const s = String(u.n).padStart(u.digits ?? 0, '0');
  const at = era ? (u.digits === 5 ? 1 : u.digits === 6 ? 2 : -1) : u.digits === 4 ? 0 : u.digits === 6 ? 2 : u.digits === 8 ? 4 : -1;
  return at >= 0 && validMonthDay(Number(s.slice(at, at + 2)), Number(s.slice(at + 2, at + 4)));
}
// kind は label（見出しの語）か dob（DOB）。DOB の後の小文字の英語の月の略は、日と4桁の年が続くときだけ月。
// DOB を見出しとみなすのは、年（4桁、6・8桁）・元号・英語の月か、「DOB:」「DOB=」の後の3つの数で、はっきり年の2桁（32 以上、0 で始まる）を含むとき（core と同じ）
function dateLikeSpan(span, kind, colon) {
  const nums = span.units.filter((u) => !u.month);
  const month = span.units.find((u) => u.month);
  if (kind !== 'label' && month?.lower === true) {
    const [u0, u1, u2] = span.units;
    if (!(u0 === month && u1 !== undefined && !u1.month && (u1.digits ?? 3) <= 2 && u2?.digits === 4)) return false;
  }
  if (kind === 'dob') {
    const year = nums.some((u) => u.digits === 4 || u.digits === 6 || u.digits === 8);
    const twoDigitYear = colon && nums.length === 3 && nums.some((u) => u.digits === 2 && (u.n > 31 || u.n < 10));
    if (!(span.era || month !== undefined || year || twoDigitYear)) return false;
  }
  if (month !== undefined) return nums.some((u) => u.n >= 1 && u.n <= 31 && (u.digits ?? 2) <= 2);
  const [a, b, c] = nums;
  if (span.era) {
    if (c !== undefined) return md(b, c);
    if (b !== undefined) return b.n >= 1 && b.n <= 12;
    return a !== undefined && compactValid(a, true);
  }
  if (c !== undefined) return md(b, c) || md(a, b) || md(b, a);
  if (b !== undefined) return md(a, b) || md(b, a) || (a?.digits === 4 && b.n >= 1 && b.n <= 12);
  return a !== undefined && compactValid(a);
}
// 並びの「日」のすぐ後の日数・日の数え方（誕生日 2日後、2日前に）。語の頭（後医、間質）は日数にしない
// （core の text/normalize.ts の DAY_COUNT_END の写し。15回目のレビュー W10）
const DAY_COUNT_END = String.raw`(?=$|[\s、。,.:;)\]」』】〜~\-/!?]|[にでのはをがもとやへか]|ほど|くらい|ぐらい|まで|より|ずつ|だけ|ばかり|おき|ごと|程|以[上内下]|前後|未満|続|継続|持続|経過|入院|入所|投与|内服|服用|使用|治療|加療|絶食|禁食|絶飲食|安静|休薬|観察|施行|点滴|静注|留置|延長|追加|連続|外泊|通院|発熱|毎)`;
const DAY_COUNT_AFTER_SPAN = new RegExp(String.raw`^[後前間目]${DAY_COUNT_END}`, 'u');
function birthSpanAfterLabel(line, at, kind, head = false) {
  const gap = sticky(kind === 'label' ? (head ? AFTER_LABEL_STOP : AFTER_LABEL) : AFTER_DOB, line, at);
  const start = at + (gap?.[0].length ?? 0);
  const withColon = /[:=]/u.test(gap?.[0] ?? '');
  let span = scanDateSpan(line, start);
  // 見出しの語の後で、並び全体が暦日らしくなければ、前から短くした並びも見る（「生年月日/年齢:」の後の「6桁/年齢」の6桁。core と同じ）
  for (let n = (span?.units.length ?? 0) - 1; kind === 'label' && span !== null && !dateLikeSpan(span, kind, withColon) && n >= 1; n -= 1) span = scanDateSpan(line, start, n);
  if (span === null || !dateLikeSpan(span, kind, withColon)) return null;
  const text = line.slice(start, span.end);
  const after = line.slice(span.end, span.end + 16);
  if (SPAN_UNIT_AFTER.test(after) || (text.endsWith('日') && DAY_COUNT_AFTER_SPAN.test(after))) return null;
  if (kind !== 'label' && DOSE_CHANGE_AFTER.test(after)) return null;
  return { start, end: span.end, kind, year: spanYear(span) };
}
function birthDateSpans(line) {
  const out = [];
  for (const m of line.matchAll(BIRTH_LABEL_AT)) {
    const head = LABEL_HEAD_BEFORE.test(line.slice(Math.max(0, m.index - 1), m.index));
    const s = birthSpanAfterLabel(line, m.index + m[0].length, m.groups?.dob !== undefined ? 'dob' : 'label', head);
    if (s !== null) out.push(s);
  }
  // 「生」「生まれ」「誕生」のすぐ前の並びは、その語が行にあるときだけ探す（core と同じ）
  if (!/[生産誕]/u.test(line)) return out.sort((a, b) => a.start - b.start);
  let taken = 0;
  for (const m of line.matchAll(SPAN_START)) {
    if (m.index < taken) continue;
    const span = scanDateSpan(line, m.index);
    if (span === null || sticky(SPAN_BORN, line, span.end) === null || !dateLikeSpan(span, 'label', false)) continue;
    out.push({ start: m.index, end: span.end, kind: 'label', year: null });
    taken = span.end;
  }
  return out.sort((a, b) => a.start - b.start);
}

function validMonthDay(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function* matchAll(re, line) {
  re.lastIndex = 0;
  for (const m of line.matchAll(re)) yield m;
}

function span(m, extra = {}) {
  return { start: m.index, end: m.index + m[0].length, ...extra };
}

// 電話番号：0 で始まる（または +81）10〜11桁
function findPhones(line) {
  const hits = [];
  const separated = new RegExp(
    `(?<![\\d+])(?:\\+81${PHONE_SEP}?|0)\\d{1,4}${PHONE_SEP}{1,2}\\d{1,4}${PHONE_SEP}{1,2}\\d{3,4}(?!\\d)`,
    'g',
  );
  for (const m of matchAll(separated, line)) {
    const digits = m[0].replace(/\D/g, '');
    const n = m[0].startsWith('+81') ? digits.length - 2 + 1 : digits.length;
    if (n >= 10 && n <= 11) hits.push(span(m));
  }
  for (const m of matchAll(/(?<!\d)0[1-9]\d{8,9}(?!\d)/g, line)) hits.push(span(m));
  // 国番号の後に区切りのないもの（+81 の後の 0 は書いても省いてもよい。core と同じ）
  for (const m of matchAll(new RegExp(`(?<![\\d+])\\+81${PHONE_SEP}?0?[1-9]\\d{8,9}(?!\\d)`, 'g'), line)) hits.push(span(m));
  return hits;
}

function findEmails(line) {
  const hits = [];
  // @ の前は64字まで（長い英数字の並びで、始まりの位置ごとに並びの終わりまで読み直さないため。core と同じ）
  const re = /[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
  for (const m of matchAll(re, line)) {
    // 画像の倍率指定（icon@2x.png など）は除く
    if (/^\d+x\.(png|jpe?g|webp|gif|svg|avif)$/i.test(m[1])) continue;
    hits.push(span(m));
  }
  return hits;
}

function findPostalCodes(line) {
  const hits = [];
  for (const m of matchAll(new RegExp(`〒\\s?\\d{3}\\s?[${DASH}]?\\s?\\d{4}`, 'g'), line)) hits.push(span(m));
  const bare = new RegExp(`(?<![\\d${DASH}.:/])\\d{3}[${DASH}]\\d{4}(?![\\d${DASH}.:/])`, 'g');
  for (const m of matchAll(bare, line)) hits.push(span(m));
  return hits;
}

// 12桁以上の数字。小数の一部は除き、英字の後の「.」（No.）と文の終わりの「.」は見る。13桁以上は、英字と続かないものだけ（ULID・ハッシュの中は除く）。
// 4桁ずつ区切った12桁は、3つとも年の形の並びを除く（core と同じ）
const YEARISH = (g) => /^(?:19|20)\d{2}$/u.test(g);
function findTwelveDigits(line) {
  const hits = [];
  for (const m of matchAll(/(?<!\d)(?<!\d\.)\d{12}(?!\d)(?!\.\d)/g, line)) hits.push(span(m));
  for (const m of matchAll(/(?<![\dA-Za-z])(?<!\d\.)\d{13,}(?![\dA-Za-z])(?!\.\d)/g, line)) hits.push(span(m));
  for (const m of matchAll(/(?<!\d)(\d{4})[ -](\d{4})[ -](\d{4})(?!\d)/g, line)) {
    if (![m[1], m[2], m[3]].every(YEARISH)) hits.push(span(m));
  }
  return hits;
}

// 年が最後に来る数字の年月日（D/M/YYYY、M.D.YYYY。日・月の順はどちらでもよい。区切りは同じ記号。core の YEAR_LAST_DATE と同じ）
const YEAR_LAST_DATE = /(?<![\d./-])(\d{1,2})([/.-])(\d{1,2})\2((?:19|20)\d{2})(?!\d)(?![./-]\d)/g;
// 漢数字の月日（年は元号・西暦。ないこともある。core の KANJI_MONTH_DAY と同じ）
const KANJI_NUM = '[〇零一二三四五六七八九十]{1,3}';
const KANJI_MONTH_DAY_RE = new RegExp(
  String.raw`(?<![\d〇零一二三四五六七八九十])(?:(?:(明治|大正|昭和|平成|令和)\s*(元|${KANJI_NUM}|\d{1,2})|(\d{4}|[〇零一二三四五六七八九]{4}))\s*年\s*)?(${KANJI_NUM}|\d{1,2})\s*月\s*(${KANJI_NUM}|\d{1,2})\s*日`,
  'gu',
);
const numeral = (s) => (/^\d+$/u.test(s) ? Number(s) : kanjiValue(s));
// 漢数字の月日の年（漢数字を含まないもの・月日が成り立たないもの・年のないものは null。core の kanjiMonthDay と同じ）
function kanjiDateYear(m) {
  if (!/[〇零一二三四五六七八九十元]/u.test(m[0])) return null;
  if (!validMonthDay(numeral(m[4] ?? ''), numeral(m[5] ?? ''))) return null;
  if (m[1] !== undefined) return (ERA_START[m[1]] ?? 0) + numeral(m[2] ?? '') - 1;
  return m[3] !== undefined ? numeral(m[3]) : null;
}

function findBirthDates(line, dobMaxYear) {
  // 生年月日の見出しのすぐ後と、「生」「生まれ」「誕生」のすぐ前の暦日らしい並びは、年を問わず、形によらず疑う。
  // 先に置く（同じ位置の短い形（05APR）より、並び全体（05APR1948）を採る。core と同じ）
  // DOB のすぐ後の並びで、年が dobMaxYear より後のもの（今年の年月日。ドブタミンの開始・終了の日）は、birth-date にしない。
  // ほかの見出しの語の後は年を問わない。年が2桁のものと年のないものは今まで通り（core と同じ。10回目のレビュー Q9）
  const hits = birthDateSpans(line)
    .filter((s) => !(s.kind === 'dob' && s.year !== null && s.year > dobMaxYear))
    .map((s) => ({ start: s.start, end: s.end }));
  const western = /(?<!\d)((?:19|20)\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?!\d)/g;
  for (const m of matchAll(western, line)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y <= dobMaxYear && validMonthDay(mo, d)) hits.push(span(m));
  }
  for (const m of matchAll(ERA_DATE, line)) {
    const n = m[4] === '元' ? 1 : Number(m[4]);
    const y = ERA_START[m[1] ?? m[2] ?? m[3]] + n - 1;
    if (eraDateShape(m) && y <= dobMaxYear && validMonthDay(Number(m[5]), Number(m[6]))) hits.push(span(m));
  }
  const compact = /(?<!\d)((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g;
  for (const m of matchAll(compact, line)) {
    if (Number(m[1]) <= dobMaxYear) hits.push(span(m));
  }
  // 年のある英語の月日（Mar 4, YYYY、4 Mar YYYY の形）
  for (const [re, order] of [[EN_YEAR_FIRST, 'year'], [EN_MONTH_FIRST, 'month'], [EN_DAY_FIRST, 'day']]) {
    for (const m of matchAll(re, line)) {
      const p = englishDateParts(m, order);
      if (p.year !== null && p.year <= dobMaxYear && validMonthDay(p.month, p.day)) hits.push(span(m));
    }
  }
  // 年が最後の年月日と、漢数字の年（元号・西暦）の年月日（core と同じ。全体のレビュー、2026-10-16）
  for (const m of matchAll(YEAR_LAST_DATE, line)) {
    const [a, b] = [Number(m[1]), Number(m[3])];
    if (Number(m[4]) <= dobMaxYear && (validMonthDay(a, b) || validMonthDay(b, a))) hits.push(span(m));
  }
  for (const m of matchAll(KANJI_MONTH_DAY_RE, line)) {
    const y = kanjiDateYear(m);
    if (y !== null && y >= 1868 && y <= dobMaxYear) hits.push(span(m));
  }
  // 生年月日・誕生日・D.O.B の語が同じ行にあれば、その行の年月日・M月D日・英語の月日を、年を問わず疑う（生まれ・DOB は除く）
  if (BIRTH_LINE.test(line)) {
    for (const m of matchAll(BIRTH_LINE_DATE, line)) if (birthDateValid(m[0])) hits.push(span(m));
  }
  return hits;
}

function findLongDigits(line) {
  const hits = [];
  for (const m of matchAll(/(?<![\d.,])\d{8,11}(?![\d.,])/g, line)) hits.push(span(m));
  return hits;
}

const HONORIFIC_KANJI = /([\p{sc=Han}]{1,4})(さん|さま|ちゃん|様|氏|殿|君|先生)(?![\p{sc=Han}])/gu;
const HONORIFIC_KATAKANA = /([ァ-ヶ][ァ-ヶー]{1,7})(さん|さま|ちゃん|様|氏|先生)(?![\p{sc=Han}])/gu;
const HONORIFIC_LATIN = /\b(?:Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+[A-Z][a-z]+/g;
// 敬称の前が一般名詞や慣用句のときは人名とみなさない（「患者さん」「同様」「仕様」など）
const NAME_STOP_SUFFIX = [
  '者', '師', '士', '員', '医', '族', '婦', '長', '生', '官', '手', '屋', '店', '方', '位', '客',
  '本人', '主人', '友人', '知人', '恋人', '隣人', '老人', '婦人', '個人', '後見人', '代理人', '保証人',
  '息子', '神', '王', '殿', '奥', '皆', '様',
];
const NAME_STOP_EXACT = new Set([
  '同', '多', '仕', '模', '異', '一', '貴', '有', '左', '文', '紋', '今', '外', '何', '態', '彼', '摂', '華',
  '某', '両', '諸', '主', '暴', '御', '宮', '赤', '母', '父', '兄', '姉', '妹', '弟', '娘', '孫', '嫁', '婿', '子',
]);
const KATAKANA_STOP = new Set(['ユーザー', 'ドクター', 'ナース', 'スタッフ', 'ヘルパー', 'ケアマネ', 'ケアマネジャー', 'ゲスト', 'オーナー', 'パパ', 'ママ']);

function findHonorificNames(line) {
  const hits = [];
  for (const m of matchAll(HONORIFIC_KANJI, line)) {
    const run = m[1];
    if (NAME_STOP_EXACT.has(run) || NAME_STOP_SUFFIX.some((w) => run.endsWith(w))) continue;
    hits.push(span(m));
  }
  for (const m of matchAll(HONORIFIC_KATAKANA, line)) {
    if (KATAKANA_STOP.has(m[1])) continue;
    hits.push(span(m));
  }
  for (const m of matchAll(HONORIFIC_LATIN, line)) hits.push(span(m));
  return hits;
}

function findAddresses(line) {
  const hits = [];
  const res = [
    /(?:北海道|東京都|京都府|大阪府|[\p{sc=Han}]{2,3}県)[\p{sc=Han}ヶケ]{0,6}?[市区町村郡]/gu,
    /(?<!\d)\d{1,3}\s*丁目/g,
    /(?<!\d)\d{1,5}\s*番地/g,
    new RegExp(`[\\p{sc=Han}]{1,6}[市区町村][\\p{sc=Han}ぁ-んァ-ヶー]{0,8}\\d{1,4}[${DASH}]\\d{1,4}(?:[${DASH}]\\d{1,4})?`, 'gu'),
  ];
  for (const re of res) for (const m of matchAll(re, line)) hits.push(span(m));
  return hits;
}

export const RULES = [
  { id: 'phone', level: 'error', message: '電話番号らしき文字列', find: findPhones },
  { id: 'email', level: 'error', message: 'メールアドレスらしき文字列', find: findEmails },
  { id: 'postal-code', level: 'error', message: '郵便番号らしき文字列', find: findPostalCodes },
  { id: 'digits-12', level: 'error', message: '12桁以上の数字', find: findTwelveDigits },
  { id: 'birth-date', level: 'error', message: '生年月日らしき日付', find: (line, ctx) => findBirthDates(line, ctx.dobMaxYear) },
  { id: 'digits-8-11', level: 'warn', message: '8〜11桁の数字（患者IDの可能性）', find: findLongDigits },
  { id: 'honorific-name', level: 'warn', message: '敬称つきの人名らしき文字列', find: findHonorificNames },
  { id: 'address', level: 'warn', message: '住所らしき文字列', find: findAddresses },
];

const ALLOW_RE = /phi-guard:\s*allow\b(.*)$/;

function allowReason(rawLine) {
  const m = rawLine.match(ALLOW_RE);
  if (!m) return null;
  return {
    col: m.index + 1,
    reason: m[1]
      .replace(/(-->|\*\/|#\}|%>)\s*$/, '')
      .replace(/^[\s:：\-—–]+/, '')
      .trim(),
  };
}

export function scanText(text, { dobMaxYear = defaultDobMaxYear() } = {}) {
  const findings = [];
  const ctx = { dobMaxYear };
  // 改行は CRLF・LF・CR・U+2028・U+2029（CR だけの改行で、ファイル全体が1行になり、最後の allow が全体に効くのを防ぐ）
  const lines = text.split(/\r\n|[\n\r\u2028\u2029]/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const allow = allowReason(raw);
    if (allow && allow.reason) return;
    if (allow) {
      findings.push({ line: lineNo, col: allow.col, level: 'error', rule: 'allow-without-reason', message: 'phi-guard の allow に理由がない' });
    }
    // 見えない書式の文字は、取り除いてから調べる（core の normalizeWithMap の dropInvisible と同じ順序）
    const line = foldDateDashes(foldEnclosedNumbers(foldSentencePunct(raw)).replace(INVISIBLE, '').normalize('NFKC'));
    const hits = [];
    for (const rule of RULES) {
      for (const h of rule.find(line, ctx)) hits.push({ ...h, rule });
    }
    // エラーを先に採り、同じ箇所に重なる警告は出さない
    hits.sort((a, b) => levelRank(a.rule.level) - levelRank(b.rule.level) || a.start - b.start);
    const taken = [];
    for (const h of hits) {
      if (!takeSpan(taken, h)) continue;
      findings.push({ line: lineNo, col: h.start + 1, level: h.rule.level, rule: h.rule.id, message: h.rule.message });
    }
  });
  return findings.sort((a, b) => a.line - b.line || a.col - b.col);
}

// 重ならなければ taken（始まりの順）に入れて true を返す。重なりは前後の1つずつだけを見る（core の lint/anonymize.ts と同じ）
function takeSpan(taken, h) {
  let lo = 0;
  let hi = taken.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (taken[mid].start < h.end) lo = mid + 1;
    else hi = mid;
  }
  const left = taken[lo - 1];
  if (left !== undefined && left.end > h.start) return false;
  taken.splice(lo, 0, { start: h.start, end: h.end });
  return true;
}

function levelRank(level) {
  return level === 'error' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// ファイル1つ分の検査

// バイト列 → テキスト。UTF-8（BOM は除く）と、BOM つきの UTF-16 を読む。NUL を含むほかのもの（BOM のない UTF-16 も）は、
// 読めないバイナリとして null（推測で読むと、NUL を差し込んだ UTF-8 などを見逃しうる。バイナリは置けないので、止まる）
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  if (buf.includes(0)) return null;
  const text = buf.toString('utf8');
  return text.startsWith('\ufeff') ? text.slice(1) : text;
}

export function scanFile({ path, size, read, symlink = false }) {
  const findings = [...checkPath(path)];
  if (symlink) return findings;
  if (size > MAX_BYTES) {
    findings.push(fileFinding('error', 'too-large', '1MB を超えるファイルは置けない'));
    return findings;
  }
  const text = decodeText(read());
  if (isFixturePath(path)) {
    if (text === null) {
      findings.push(fileFinding('error', 'fixture-not-synthetic', 'fixtures/ にバイナリは置けない（synthetic: true を確かめられない）'));
    } else if (!SYNTHETIC_RE.test(text)) {
      findings.push(fileFinding('error', 'fixture-not-synthetic', 'fixtures/ のファイルに synthetic: true がない'));
    }
  }
  if (text === null) {
    // 読めないバイナリ：中身を確かめられないので、置けない（画面の撮影・表計算のファイルなど）。アプリのアイコンだけは置ける
    if (!BINARY_ALLOWED_RE.test(toPosix(path))) findings.push(fileFinding('error', 'binary-file', 'バイナリのファイルは置けない（中身を確かめられない。アイコンは apps/web/public の png・ico・webp だけ）'));
    return findings;
  }
  return findings.concat(scanText(text));
}

// ---------------------------------------------------------------------------
// 対象ファイルの集め方

function git(args, opts = {}) {
  return execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function splitZ(buf) {
  return buf.toString('utf8').split('\0').filter(Boolean);
}

function stagedTargets() {
  // 消したファイル以外のすべて（種類の変わったファイル〔T〕も含む）
  const changed = new Set(splitZ(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=d'])));
  const targets = [];
  for (const entry of splitZ(git(['ls-files', '--stage', '-z']))) {
    const tab = entry.indexOf('\t');
    const [mode, sha] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (!changed.has(path) || mode === '160000') continue;
    targets.push({
      path,
      symlink: mode === '120000',
      size: Number(git(['cat-file', '-s', sha]).toString().trim()),
      read: () => git(['cat-file', 'blob', sha]),
    });
  }
  return targets;
}

function workingTreeTargets(paths, root) {
  const targets = [];
  for (const p of paths) {
    const abs = resolve(root, p);
    let st;
    try {
      st = lstatSync(abs, { throwIfNoEntry: false });
    } catch {
      st = undefined;
    }
    if (!st) continue;
    const path = toPosix(relative(root, abs));
    // シンボリックリンクは、リンクの名前だけを見る（リンク先を読まない。作業ツリーの外を読まないように）。普通のファイル以外は読まない
    if (st.isSymbolicLink()) targets.push({ path, size: 0, symlink: true, read: () => Buffer.alloc(0) });
    else if (st.isFile()) targets.push({ path, size: st.size, read: () => readFileSync(abs) });
  }
  return targets;
}

// 無視対象のうち、検査しないもの：依存・ビルドの出力・キャッシュ・OS が作るファイル
const IGNORED_SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.vite', '.wrangler', '.git', '.turbo', 'test-results', 'playwright-report']);
const IGNORED_SKIP_FILES = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.eslintcache|[^/]*\.tsbuildinfo)$/i;

function allTargets() {
  const root = git(['rev-parse', '--show-toplevel']).toString().trim();
  const paths = splitZ(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }));
  // .gitignore に頼らない：無視対象も検査する（data/・.env.*・*.sqlite などは、無視対象に並んでいる）
  const ignored = splitZ(git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { cwd: root })).filter(
    (p) => !p.split('/').slice(0, -1).some((d) => IGNORED_SKIP_DIRS.has(d)) && !IGNORED_SKIP_FILES.test(p),
  );
  return workingTreeTargets([...paths, ...ignored], root);
}

// pre-push：標準入力の行（<local ref> <local sha> <remote ref> <remote sha>）ごとに、送るコミットを集め、
// 各コミットで変わったファイル（その時点の中身）とメッセージを検査する。途中のコミットにだけあった実データも見つける
const ZERO_SHA = /^0+$/;

function pushTargets(stdinText) {
  const files = new Map(); // blob の sha → 対象（同じ中身は1回）
  const messages = [];
  for (const line of stdinText.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (localSha === undefined || ZERO_SHA.test(localSha)) continue;
    const range = remoteSha === undefined || ZERO_SHA.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`];
    const commits = git(['rev-list', ...range]).toString().split('\n').filter(Boolean);
    for (const c of commits) {
      messages.push({ commit: c, text: git(['log', '-1', '--format=%B', c]).toString() });
      // 変わったファイル（消したものを除く）。-z の --raw は「:mode mode sha sha status」と道が NUL で交互に並ぶ
      const raw = splitZ(git(['diff-tree', '-r', '-z', '--raw', '--no-commit-id', '--root', '-m', '--diff-filter=d', c]));
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const meta = raw[i].split(' ');
        const mode = meta[1];
        const sha = meta[3];
        const path = raw[i + 1];
        if (mode === '160000' || sha === undefined || files.has(`${sha}:${path}`)) continue;
        files.set(`${sha}:${path}`, {
          path,
          symlink: mode === '120000',
          size: Number(git(['cat-file', '-s', sha]).toString().trim()),
          read: () => git(['cat-file', 'blob', sha]),
        });
      }
    }
  }
  return { targets: [...files.values()], messages };
}

// git の決まった署名の行（共同作者など。名前と <メールアドレス>）。メールアドレスは、ここでは検査しない（コミットの作者と同じ扱い）
const TRAILER_RE = /^(Co-authored-by|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Helped-by|Suggested-by):\s.*<[^<>\s]+>\s*$/i;

// コミットメッセージ（# で始まる行は git が除くので、検査しない。署名の行も除く）
export function scanMessage(text) {
  const body = text
    .split(/\r?\n/)
    .map((l) => (l.startsWith('#') || TRAILER_RE.test(l) ? '' : l))
    .join('\n');
  return scanText(body);
}

// ---------------------------------------------------------------------------

const USAGE = '使い方: node scripts/phi-guard.mjs [--staged | --all | --push | --message <file> | <path>...] [--strict]\n';

function main(argv, stdinText = () => readFileSync(0, 'utf8')) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const paths = argv.filter((a) => !a.startsWith('--'));
  const strict = flags.has('--strict');
  const modes = ['--staged', '--all', '--push', '--message'].filter((m) => flags.has(m));
  const unknown = [...flags].filter((f) => !['--staged', '--all', '--push', '--message', '--strict'].includes(f));
  if (unknown.length > 0 || modes.length > 1 || (flags.has('--message') && paths.length !== 1)) {
    process.stderr.write(USAGE);
    return 2;
  }

  let targets;
  let messages = [];
  try {
    if (flags.has('--staged')) targets = stagedTargets();
    else if (flags.has('--all')) targets = allTargets();
    else if (flags.has('--push')) ({ targets, messages } = pushTargets(stdinText()));
    else if (flags.has('--message')) {
      targets = [];
      messages = [{ commit: null, text: readFileSync(paths[0], 'utf8') }];
    } else if (paths.length > 0) {
      targets = workingTreeTargets(paths, process.cwd());
      // ない道・ディレクトリだけを渡したときは、検査したように見せない（打ち間違いに気づくように）
      if (targets.length === 0) {
        process.stderr.write('phi-guard: 検査できるファイルがない（道を確かめてください）\n');
        return 2;
      }
    } else {
      process.stderr.write(USAGE);
      return 2;
    }
  } catch (e) {
    process.stderr.write(`phi-guard: 対象ファイルを集められなかった（${e.message.split('\n')[0]}）\n`);
    return 2;
  }

  let errors = 0;
  let warns = 0;
  const report = (label, f) => {
    if (f.level === 'error') errors += 1;
    else warns += 1;
    const where = f.line > 0 ? `${label}:${f.line}:${f.col}` : label;
    process.stderr.write(`  ${where}  ${f.level}  ${f.rule}  ${f.message}\n`);
  };
  for (const t of targets) for (const f of scanFile(t)) report(t.path, f);
  for (const m of messages) for (const f of scanMessage(m.text)) report(m.commit === null ? '(コミットメッセージ)' : `(コミット ${m.commit.slice(0, 7)} のメッセージ)`, f);

  const failed = errors > 0 || (strict && warns > 0);
  process.stderr.write(`phi-guard: ${targets.length} ファイル${messages.length > 0 ? `・メッセージ ${messages.length} 件` : ''}、エラー ${errors} 件、警告 ${warns} 件\n`);
  if (failed) {
    process.stderr.write(
      'phi-guard: 止めました。実データなら取り除いてください。誤検知なら、その行に「phi-guard: allow <理由>」と書いてください。\n',
    );
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
