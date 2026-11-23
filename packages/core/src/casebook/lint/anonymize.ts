// 匿名化リンタ。docs/06-outputs-and-linters.md の5。
//
// - 保存する前、AI に送る前、書き出す前、コピーする前に動かす。error があれば保存しない。
// - 見つけた文字列は返さない。返すのは規則・重さ・元の文字列の中の位置（UI の強調に使う）だけ。
// - 検出の方式は phi-guard（scripts/phi-guard.mjs）と揃える。共通の規則は、同じ文字列に同じ判定をする（テストで確かめる）。
// - 1行ずつ、NFKC で全角の数字や記号をそろえてから調べる（丸数字などの番号は、その前に「・」にする。foldEnclosedNumbers。
//   「，．」の書き方の読点・句点は「、」「。」にする。foldSentencePunct の暦日の見分けの形（detect）。11回目のレビュー R6、13回目のレビュー T5）。位置は元の文字列に戻して返す。
import { BORN_CORE, DAY_COUNT_END, DAY_COUNT_SUFFIX, foldSentencePunct, normalizeWithMap, originalRange } from '../text/normalize.ts';

export type AnonymizationRule =
  | 'A-PHONE'
  | 'A-EMAIL'
  | 'A-POSTAL'
  | 'A-DIGITS12'
  | 'A-DOB'
  | 'A-PATIENT-ID'
  | 'A-HONORIFIC'
  | 'A-INITIALS'
  | 'A-ADDRESS'
  | 'A-FACILITY'
  | 'A-CALENDAR-DATE';

export type LintLevel = 'error' | 'warn';

// start と end は元の文字列の中の位置（UTF-16 のコード単位、end は含まない）
export type AnonymizationFinding = { rule: AnonymizationRule; level: LintLevel; start: number; end: number };

export type AnonymizationContext = {
  // 患者IDの形（^ と $ は付けても付けなくてもよい）。患者IDはアプリに入れない（A-007）ので、既定は持たない。
  // 本人が自分の施設のIDの形を知っていて、うっかり書くのを止めたいときだけ使う
  patientIdPatterns?: readonly string[];
  // この年より前（含む）の年月日を生年月日とみなす。受持時年齢の下限（要件セット）と今日から、呼び出し側が決める
  dobMaxYear: number;
  // 文章の中の暦日の重さ。既定は error（A-023：暦日を持つのは受持期間、入退院日、外来の受診日だけ。文章は病日で書く）。
  // 取り込みの確認画面などで、止めずに知らせるだけにするときは 'warn'
  calendarDates?: LintLevel;
};

// 今日と受持時年齢の下限から、生年月日とみなす年の上限を出す
export function dobMaxYearFor(asOfYear: number, minAge: number): number {
  return asOfYear - minAge;
}

type Span = { start: number; end: number };

const DASH = '\\-‐‑‒–—−ー';
// 電話番号の区切り：ダッシュ・かっこ・空白と「.」（市外局番.市内局番.番号 の書き方。全体のレビュー、2026-10-16）
const PHONE_SEP = `[${DASH}().\\s]`;

// ダッシュの変種（‐ ‑ ‒ – — ― − と長音の「ー」。全角の －・﹣ と半角の ｰ は NFKC で「-」「ー」になる）を「-」にそろえる。
// そろえるのは、数字のあいだ（空白2つまでをはさんでよい）と、英字・「日」「月」「)」と数字のあいだ、数字と英字のあいだだけ
// （かな入力の 2025ー11ー8、11/10–12、Nov—8—2025、11月8日ー10日。6回目のレビュー H9）。
// カタカナの語（ヘモグロビン）の「ー」や、矢印の一部（15 ー> 3）は変えない。字数は変えないので、位置はそのまま使える。
// 日付と生年月日の見分けの前に、匿名化リンタ・phi-guard・calendar-dates.ts（AI に送る文面と保存する文）で同じようにそろえる
const DASH_VARIANTS = '‐‑‒–—―−ー';
const DASH_FOLD = new RegExp(
  String.raw`(?<=[\dA-Za-z)日月]\.?\s{0,2})[${DASH_VARIANTS}](?=\s{0,2}\d)|(?<=\d\s{0,2})[${DASH_VARIANTS}](?=\s{0,2}[A-Za-z])`,
  'gu',
);
export function foldDateDashes(line: string): string {
  return line.replace(DASH_FOLD, '-');
}
// 丸数字・かっこ数字・数字と「.」の番号（①、⑫、⑴、⒈、㉑、㊱、⓪。🄁 などの数字と「,」も）は、NFKC で数字（⒈ は「1.」）になり、
// すぐ後の暦日に数字がくっつく（①11/8 が「111/8」になり、暦日と見分けられない。9回目のレビュー P5）。
// そこで NFKC の前に、1字ずつ箇条書きの印「・」にする（1つのコード単位を1つに。位置はそのまま使える）。
// 上付き・下付きの数字（²、₂）は、すぐ後に数字が続くときだけ同じにする（SpO₂、m² のふつうの書き方は変えない）。
// 暦日と生年月日の見分けの前に、匿名化リンタ・phi-guard・calendar-dates.ts（AI に送る文面と保存する文）で同じようにそろえる
const ENCLOSED_NUMBER = /[\u2460-\u249B\u24EA\u3251-\u325F\u32B1-\u32BF]|[\u00B2\u00B3\u00B9\u2070\u2074-\u2079\u2080-\u2089](?=[0-9\uFF10-\uFF19〇一二三四五六七八九十])|[\u{1F100}-\u{1F10A}]/gu;
export function foldEnclosedNumbers(line: string): string {
  return line.replace(ENCLOSED_NUMBER, (c) => '・'.repeat(c.length));
}
// 文章から記録・ラフ記法・今日のメモの読み取りだけで、foldEnclosedNumbers と NFKC の前に使う（保存する文の数を書いたとおりに残す。
// 10回目のレビュー Q10、Q13）【案】：
// - 数字のすぐ後の上付きの数字の並び（「⁻」「⁺」で始まってもよい）は「^」を付けた書き方にする（10⁴ は 10^4、10⁻³ は 10^-3。
//   NFKC だけだと 10⁴ が「104」になり、値が変わる）。すぐ後に数字が続くものは今まで通り（foldEnclosedNumbers で「・」）。
// - 英字と数字にはさまれた下付きの数字は、その数字と空白1つにする（SpO₂98% は SpO2 98%、PaCO₂45 は PaCO2 45。
//   foldEnclosedNumbers だけだと「SpO・98%」になる）。
// 単位の上付き（m²、mm³）と、後ろに数字のない下付き（SpO₂ 98%、HCO₃⁻）は NFKC のまま（m2、SpO2、HCO3-）。
// 字数が変わるので、位置を元の文字列に戻す見分け（匿名化リンタ、phi-guard、calendar-dates.ts）では使わない（行ごとに読むだけの読み取りで使う）
const SUPERSCRIPT_RUN = /(?<=[0-9０-９])[⁺⁻]?[²³¹⁰⁴-⁹]+(?![0-9０-９])/gu;
const SUBSCRIPT_BETWEEN = /(?<=[A-Za-zＡ-Ｚａ-ｚ])[₀-₉](?=[0-9０-９])/gu;
export function keepScriptDigits(text: string): string {
  if (!/[²³¹⁰-₉]/u.test(text)) return text;
  return text.replace(SUPERSCRIPT_RUN, (m) => `^${m.normalize('NFKC')}`).replace(SUBSCRIPT_BETWEEN, (m) => `${m.normalize('NFKC')} `);
}
const ERA_START: Readonly<Record<string, number>> = {
  明治: 1868, 大正: 1912, 昭和: 1926, 平成: 1989, 令和: 2019, M: 1868, T: 1912, S: 1926, H: 1989, R: 2019,
  明: 1868, 大: 1912, 昭: 1926, 平: 1989, 令: 2019,
};
// 元号の年月日。1字の元号（平30.4.1 の形。漢字に続くもの（最大、不明、扁平）は除く）と、「.」を付けた英字の元号（H.30.4.1）も（E5）。
// 元号は1〜3番目のどれか、年・月・日は4〜6番目。
// 1字の英字の元号は、英字・数字・カタカナ・「ー」に続くもの（ヒューマリンR、3T）を除き、「.」を付けないときは「-」の区切りを読まない
// （「R 4-4-4」「T4-5-6」は用量や椎体。4回目のレビュー F14）。「-」は eraDateShape で除く（calendar-dates.ts と phi-guard も同じ）。
// 半角カナの濁点・半濁点（ﾄﾞ）は1字ずつ NFKC にすると結合文字（U+3099、U+309A）になるので、結合文字の後もカタカナと同じに扱う
// （phi-guard は行ごと NFKC にして「ド」になる。どちらでも同じ判定にする。5回目のレビュー）
const ERA_DATE = /(?<![A-Za-z])(?:(明治|大正|昭和|平成|令和)|(?<!\p{sc=Han})([明大昭平令])|(?<![\d\p{sc=Katakana}ー])(?<!\p{M})([MTSHR])\.?)\s*(元|\d{1,2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})(?!\d)/gu;
const eraOf = (m: RegExpMatchArray) => m[1] ?? m[2] ?? m[3] ?? '';
// 元号の年月日の形として読めるか（「.」のない1字の英字の元号に「-」の区切りがあれば読まない）
export function eraDateShape(m: RegExpMatchArray): boolean {
  return !(m[3] !== undefined && m[0].charAt(1) !== '.' && m[0].includes('-'));
}
// 生年月日の見分けで「生」とみなす語（生検・生食・生化学・生活などの語の頭は除く）。「出生」も（M/D 出生、M月D日出生。出生時・出生歴・出生体重など
// 漢字が続くものは除く。11回目のレビュー N1）【案】
// 生れ・産れ（15回目のレビュー W12）も。誕生会・誕生日会・誕生祝い・生まれ故郷は除く（W11）。生まれつき・生まれ育ち・生まれながら・
// 生まれ持った・生まれて初めても除く（16回目のレビュー X6。text/normalize.ts の BORN_CORE）
const BORN = String.raw`\s*(?:[にで]\s*)?${BORN_CORE}`;

// 英語の月の名前（Nov、November、NOV）。語の途中（Marker、Decadron、Novolin、Sepsis）は除く（4回目のレビュー F8）
export const ENGLISH_MONTH = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEP(?:T(?:EMBER)?)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)(?![A-Za-z])`;
// 英語の月日。月の名前が先（Nov 8、Nov. 8th, 2025、Nov/8、Nov-08-2025）：1番目が月、2番目が日、3番目が年（ないこともある）。
// 月と日のあいだは空白か「/」「-」、日と年のあいだは「,」・空白・「/」・「-」（6回目のレビュー H12）
export const ENGLISH_DATE_MONTH_FIRST = String.raw`(?<![A-Za-z])(${ENGLISH_MONTH})\.?(?:\s*[/-]\s*|\s*)(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:(?:\s*[,/-]\s*|\s+)(\d{4})(?!\d))?`;
// 英語の月日。日が先（8 Nov 2025、8-Nov-2025、08/Nov/2025、8th of November）：1番目が日、2番目が月、3番目が年（ないこともある）。
// 前の「.」は、数字か英字のすぐ後のもの（1.8 Nov、Ver.8 Nov）だけ見分けを止める（文の終わりの「発熱あり.8 Nov 2025」は見る。11回目のレビュー R6）
export const ENGLISH_DATE_DAY_FIRST = String.raw`(?<![\dA-Za-z/])(?<![\dA-Za-z]\.)(\d{1,2})(?:st|nd|rd|th)?(?:\s*[/-]\s*|\s+of\s+|\s*)(${ENGLISH_MONTH})\.?(?:(?:\s*[,/-]\s*|\s+)(\d{4})(?!\d))?`;
// 英語の月日。年が先（2025-Nov-08、2025/Nov/8）：1番目が年、2番目が月、3番目が日（6回目のレビュー H12）
export const ENGLISH_DATE_YEAR_FIRST = String.raw`(?<![\d/-])(?<![\dA-Za-z]\.)(\d{4})\s*[/-]\s*(${ENGLISH_MONTH})\.?\s*[/-]\s*(\d{1,2})(?:st|nd|rd|th)?(?![\d/])`;
// 英語の月日の並び方（月が先、日が先、年が先）
export type EnglishDateOrder = 'month' | 'day' | 'year';
const EN_MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// 英語の月の名前の月（1〜12。名前でなければ 0）
export function englishMonthNumber(name: string): number {
  return EN_MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}
// 英語の月日の月・日・年（order は見つけた形。ENGLISH_DATE_MONTH_FIRST・DAY_FIRST・YEAR_FIRST）
export function englishDateParts(m: RegExpMatchArray, order: EnglishDateOrder): { month: number; day: number; year: number | null } {
  const [monthName, dayText, yearText] =
    order === 'day' ? [m[2] ?? '', m[1] ?? '', m[3]] : order === 'year' ? [m[2] ?? '', m[3] ?? '', m[1]] : [m[1] ?? '', m[2] ?? '', m[3]];
  return { month: englishMonthNumber(monthName), day: Number(dayText), year: yearText === undefined ? null : Number(yearText) };
}
const EN_MONTH_FIRST = new RegExp(ENGLISH_DATE_MONTH_FIRST, 'gu');
const EN_DAY_FIRST = new RegExp(ENGLISH_DATE_DAY_FIRST, 'gu');
const EN_YEAR_FIRST = new RegExp(ENGLISH_DATE_YEAR_FIRST, 'gu');
const EN_FORMS: readonly [RegExp, EnglishDateOrder][] = [
  [EN_YEAR_FIRST, 'year'],
  [EN_MONTH_FIRST, 'month'],
  [EN_DAY_FIRST, 'day'],
];
// 月が先の英語の月日の日のすぐ後が「/数字」なら、英語の月日でない（OCT 11/10 施行 の 11/10 は月日。6回目のレビュー H11）
export function englishSlashAfter(line: string, end: number): boolean {
  return /^\s*\/\s*\d/u.test(line.slice(end, end + 8));
}

// 生年月日の見出しの語のある行（4回目のレビュー F11、F13。5回目のレビュー G14。phi-guard も同じ）。
// 行の中にあれば、その行の年月日・M月D日・英語の月日をすべて疑う。DOB はドブタミンの略でもあるので、行ごとの見出しにしない
// （「11月12日 DOBは漸減」「DOB: 2-3γ、11月10日から」の暦日はふつうの暦日）。DOB は下の見出しのすぐ後の並びだけで見る
const BIRTH_LINE = /生年月日|誕生日(?![\p{sc=Han}\p{sc=Katakana}ー])|D\.O\.B/iu;
// 生年月日らしい暦日の形（年月日、月/日/年、M月D日、元号の年月日、英語の月日）。数字や小数の続き（1.2-1.5、80-90-100）は除く。
// 文の終わりの「.」は続けてよい（M.D.YYYY.。5回目のレビュー G15）。前の「.」は、数字のすぐ後のもの（1.3/4/1953 の小数の続き）だけ見分けを止める
// （文の終わりの「.」や「...」の後の 72歳男性.3.4.YYYY は見る。11回目のレビュー R6）。
// 区切りの中黒「・」（YYYY・M・D、S年・M・D の形。半角の「･」は NFKC で「・」）も「.」と同じ（見出しの語のある行だけ。10回目のレビュー Q8）【案】
const BIRTH_DATE_FORMS = String.raw`(?<!\d)(?<!\d\.)\d{1,4}\s*[-/.・年]\s*\d{1,2}\s*[-/.・月]\s*\d{1,2}(?!\d|\.\d)|(?<!\d)(?<!\d\.)\d{1,2}\s*[-/.・]\s*\d{1,2}\s*[-/.・]\s*\d{4}(?!\d|\.\d)|(?<!\d)\d{1,2}\s*月\s*(?:の\s*)?\d{1,2}\s*日|(?:明治|大正|昭和|平成|令和|[明大昭平令]|[MTSHR]\.?)\s*(?:元|\d{1,2})\s*[年./・-]\s*\d{1,2}\s*[月./・-]\s*\d{1,2}(?!\d)|${ENGLISH_DATE_YEAR_FIRST}|${ENGLISH_DATE_MONTH_FIRST}|${ENGLISH_DATE_DAY_FIRST}`;
// 生年月日の見出しの行の暦日
const BIRTH_LINE_DATE = new RegExp(BIRTH_DATE_FORMS, 'gu');
const EN_MONTH_NAME = new RegExp(ENGLISH_MONTH, 'iu');
// 生年月日らしい暦日の月と日が成り立つか（英語の月の名前か、数字の並びから月と日を取る）。
// 3つの数で終わりが4桁でなければ、年/月/日 か 月/日/年（3/4/53。5回目のレビュー G15）
function birthDateValid(text: string): boolean {
  const en = EN_MONTH_NAME.exec(text);
  const nums = (text.match(/\d+/g) ?? []).map((s) => ({ s, n: Number(s) }));
  if (en !== null) {
    const day = nums.find((x) => x.s.length <= 2);
    return day !== undefined && validMonthDay(englishMonthNumber(en[0]), day.n);
  }
  if (nums.length === 2) return validMonthDay(nums[0]?.n ?? 0, nums[1]?.n ?? 0);
  const [a, b, c] = nums;
  if (a === undefined || b === undefined || c === undefined) return false;
  return c.s.length === 4 ? validMonthDay(a.n, b.n) : validMonthDay(b.n, c.n) || validMonthDay(a.n, b.n);
}

// ---------------------------------------------------------------------------
// 生年月日の見出しのすぐ後と、「生」「生まれ」「誕生」のすぐ前の、暦日らしい並び【案】（5回目のレビュー G10、G14、G15、G16。
// phi-guard と calendar-dates.ts も同じものを使う。phi-guard は同じ手順の写し）。
// 形によらず、並び全体を生年月日とみなす：数字、漢数字（〇一二…十、元）、区切り（/ . - ・ 年 月 日、空白、「,」。中黒は10回目のレビュー Q8）、英語の月の名前と序数（4th）、
// 前に元号（名前か1字の英字）。数は3つまで（年・月・日）。1つの並びでは「/ . -」の区切りと「空白・,」の区切りを混ぜない
// （「3/4 11/10 入院」の 11/10 は含めない）。
// - 暦日らしいもの：月・日として成り立つ2つ以上の数（年/月/日、月/日/年、日/月/年も）、4桁の年と月、元号と2つ以上の数、英語の月と日、
//   区切りのない4桁（月日）・6桁（年月日）・8桁（年月日）。「誕生日 2日後」「生年月日 不明」「一生」「2年生」は含めない。
// - すぐ後に単位・助数詞（2.8kg、3γ、72歳、2回）が続くもの、「日」で終わって「後・前・間・目」が続くもの（3-4日後）は含めない。
// - 見出しの語：生年月日、誕生日、出生日、D.O.B、Birthday、birth date、date of birth、bday、born（on）、「生まれは」「生まれ:」、「出生」「誕生」「生誕」（出生 M/D、出生：M/D、誕生 M/D。出生時・出生歴・誕生日など
//   漢字の続くものは除く。11回目のレビュー N1【案】）。文の始まりの見出しの語と並びのあいだの1つの「。」「.」（生年月日．…、Birthday.…。11回目のレビュー R6【案】）も。
//   見出しと並びのあいだに「は」「:」「=」、開きかっこ（「（」「[」「【」）と空白をはさんでよい。見出しを閉じるかっこ（【生年月日】、(生年月日)）、
//   数字のない短いかっこ書き（生年月日(年齢):）、区切りと添えた語（生年月日/年齢:、生年月日・年齢:、生年月日、）も（7回目のレビュー K8）。
//   字・数字のない短い記号の並び（表の「|」、「-」「→」「;」「…」「::」。8回目のレビュー M7）も。
//   元号の後の区切りのない5桁（年が1桁）も年月日。並び全体が暦日らしくなければ、前から短くした並びも見る（見出しの語の後だけ）。
// - DOB（ドブタミンの略でもある）は、「DOB」「DOB:」「DOB=」（添えた年齢の語 DOB/Age:、DOB (age):、DOB／年齢：と、閉じかっこ・記号の並びの後も。
//   8回目のレビュー M7）のすぐ後の並びが、年（4桁の数、区切りのない6・8桁。「DOB:」「DOB=」の後の
//   3つの数では、32 以上か 0 で始まる2桁の数も）・元号・英語の月を含むときだけ見出しにする。「DOBは」と、量（2-3γ）・off・年のない月日
//   （DOB: 11/12 まで）・量の変わり方の語（10-5-3と漸減、10-5-3→off）が続くもの、小文字の月の略（dec 5→3）は見出しにしない（6回目のレビュー H10）。
const KANJI_DIGIT: Readonly<Record<string, number>> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const kanjiDigits = (s: string) => (/^[〇零一二三四五六七八九]+$/u.test(s) ? Number(s.replace(/[〇零一二三四五六七八九]/gu, (c) => String(KANJI_DIGIT[c] ?? 0))) : NaN);
// 漢数字の値（二十三 は 23、一九四八 は 1948、元 は 1）
function kanjiValue(s: string): number {
  if (s === '元') return 1;
  const k = s.indexOf('十');
  if (k < 0) return kanjiDigits(s);
  const tens = k === 0 ? 1 : kanjiDigits(s.slice(0, k));
  const ones = k === s.length - 1 ? 0 : kanjiDigits(s.slice(k + 1));
  return tens * 10 + ones;
}
// 漢数字の月日（十一月八日、11月十日、十一月8日、令和七年十一月八日、二〇二五年十一月八日。6回目のレビュー H12）。
// 1・2番目が元号と年、3番目が4桁の年（どちらもないこともある）、4番目が月、5番目が日。漢数字を1つも含まないもの（11月8日）は、ほかの形で見る
const KANJI_NUM = '[〇零一二三四五六七八九十]{1,3}';
export const KANJI_MONTH_DAY = String.raw`(?<![\d〇零一二三四五六七八九十])(?:(?:(明治|大正|昭和|平成|令和)\s*(元|${KANJI_NUM}|\d{1,2})|(\d{4}|[〇零一二三四五六七八九]{4}))\s*年\s*)?(${KANJI_NUM}|\d{1,2})\s*月\s*(${KANJI_NUM}|\d{1,2})\s*日`;
const KANJI_MONTH_DAY_RE = new RegExp(KANJI_MONTH_DAY, 'gu');
const numeral = (s: string) => (/^\d+$/u.test(s) ? Number(s) : kanjiValue(s));
// 漢数字の月日の年・月・日（年がなければ null）。漢数字を含まないもの、月・日が成り立たないものは null
export function kanjiMonthDay(m: RegExpMatchArray): { year: number | null; month: number; day: number } | null {
  if (!/[〇零一二三四五六七八九十元]/u.test(m[0])) return null;
  const [month, day] = [numeral(m[4] ?? ''), numeral(m[5] ?? '')];
  if (!validMonthDay(month, day)) return null;
  const era = m[1];
  const year = era !== undefined ? (ERA_START[era] ?? 0) + numeral(m[2] ?? '') - 1 : m[3] !== undefined ? numeral(m[3]) : null;
  // 読めない年（NaN）は 0 にする（年があるのに決められないので、日まで決めない暦日になる）
  return { year: year === null ? null : Number.isNaN(year) ? 0 : year, month, day };
}
const SPAN_ERA = /(?:明治|大正|昭和|平成|令和|[明大昭平令]|[MTSHR](?![A-Za-z])\.?)\s{0,2}/iuy;
const SPAN_NUM = /(\d{1,8})(?!\d)(?:st|nd|rd|th)?/iuy;
const SPAN_KANJI = /[〇零一二三四五六七八九十]{1,6}(?![〇零一二三四五六七八九十])|元/uy;
const SPAN_MONTH = new RegExp(String.raw`${ENGLISH_MONTH}\.?`, 'iuy');
// 大文字・小文字の決まった形の英語の月の名前（Dec、DEC、December）。dec・mar・sep のような小文字の略は、DOB の後では月としない（下の dateLikeSpan）
const CASED_MONTH = new RegExp(String.raw`^${ENGLISH_MONTH}`, 'u');
const SPAN_SEP_JA = /\s{0,2}[年月]\s{0,2}/uy;
// 区切りの記号。中黒「・」（見出しの後の YYYY・M・D、「生まれ」の前の S年・M・D、M・D の形）も「.」と同じ（10回目のレビュー Q8）【案】。
// 見出しのすぐ後と「生まれ」のすぐ前の並びだけで見る（Na・K 140・4.0、11月10・12日 のような文の中の「・」は暦日にしない）
const SPAN_SEP_PUNCT = /\s{0,2}[/.\-・]\s{0,2}/uy;
const SPAN_SEP_SPACE = /\s{0,2},\s{0,2}|\s{1,3}/uy;
const SPAN_DAY_JA = /\s{0,2}日(?!曜)/uy;
const SPAN_DAY = /日(?!曜)/uy;
const SPAN_UNIT_AFTER = /^\s*(?:kg|g(?![A-Za-z])|cm|mm|%|γ|μg|mcg|mg|mL|ml|L(?![A-Za-z])|歳|才|か月|ヶ月|カ月|ヵ月|週|時間|分|秒|回|本|錠|円|点|倍)/u;
// 生まれの語（生検・生食・生化学・生活・生じた などの語の頭は除く）
const SPAN_BORN = new RegExp(BORN, 'uy');
// 並びの始まりになれる位置（数字・漢数字・元号・英語の月の途中からは始めない）。前の「.」は、数字・漢数字のすぐ後のもの（小数の続き）だけ
// 止める（文の終わりの「.」「...」の後と、英語の語に続けた「.」の後（72歳男性.M.D 生まれ、HT.M.D 生まれ）は見る。並びは見出しの語の後か
// 生まれの語の前だけなので、番号の略語（Ver.3.4）と見分けなくてよい。11回目のレビュー R6）
const SPAN_START = new RegExp(
  String.raw`(?<![\d〇零一二三四五六七八九十A-Za-z/-])(?<![\d〇零一二三四五六七八九十]\.)(?:\d|[〇零一二三四五六七八九十元]|明治|大正|昭和|平成|令和|(?<!\p{sc=Han})[明大昭平令]|(?<![\p{sc=Katakana}ー])(?<!\p{M})[MTSHR](?![A-Za-z])|${ENGLISH_MONTH})`,
  'giu',
);
// 生年月日の見出しの語。dob は DOB（すぐ後の並びに年・元号・英語の月があるときだけ見出し）。
// DOB のすぐ後の「/」は、年齢の語が続くとき（DOB/Age、DOB／年齢）だけ見出しの続き（DOA/DOB・DOB/DOA は量の書き方）。
// 年齢の語を添えた DOB（DOB/Age、DOB (age)、DOB／年齢、DOB, age）はドブタミンの量の書き方にならないので、生年月日の見出しの語と同じに見る
// （年のない並びも生年月日。8回目のレビュー M7）【案】
export const DOB_WORD = String.raw`(?<![/A-Za-z\d])DOB(?![A-Za-z\d]|\/(?!\s*(?:age|年齢)))`;
export const DOB_AGE_LABEL = String.raw`${DOB_WORD}\s*(?:[/／・、,]\s*(?:age|年齢)|[(（]\s*(?:age|年齢)\s*[)）])`;
const BIRTH_LABEL_AT = new RegExp(
  String.raw`生年月日|誕生日(?![\p{sc=Han}\p{sc=Katakana}ー])|出生日|D\.O\.B\.?|\bbirth\s*(?:day|date)|\bdate\s+of\s+birth|\bb-?day|\bborn(?:\s+on)?|生ま?れ\s*(?:は|:)|(?:出生|誕生|生誕)(?![\p{sc=Han}\p{sc=Katakana}ー])|${DOB_AGE_LABEL}|(?<dob>${DOB_WORD})`,
  'giu',
);
// 見出しと並びのあいだ（DOB は「は」をはさまない）。見出しを閉じるかっこ（【生年月日】、(生年月日)、[生年月日]、〈生年月日〉）、
// 数字のない短いかっこ書き（生年月日(年齢):）、区切りと添えた語（生年月日/年齢:、生年月日・年齢:、生年月日、）は3つまで続けてよい
// （7回目のレビュー K8）【案】。数字を含むかっこ（誕生日(m/d)）は並びの始まりの開きかっことして読む。phi-guard も同じ。
// 区切りの記号の短い並び（表の「|」、「-」「→」「;」「…」「::」「<」「*」「#」。8回目のレビュー M7）も区切りとしてはさんでよい【案】。
// 記号は決めたものだけ（NFKC のあとの形。開きかっこ、文の終わりの「。」「!」「?」、範囲の「〜」、引用符や「{}」「$」は区切りにしない）。
// 「.」は2つ以上続くもの（…、...）だけ（「D.O.B.」の後や文の終わりの1つの「.」と分ける）。
// calendar-dates.ts の前の行の見出し（【生年月日】だけの行）と暦日のすぐ前の見出しも同じもので見る
export const BIRTH_LABEL_CLOSE = String.raw`[)\]）】〕〉》」』>＞≫»〗]`;
export const BIRTH_LABEL_SYMBOLS = String.raw`(?:\.{2,3}|[|¦:;=<*#\-‐‑‒–—―−→⇒⇨➡➔⟶]{1,3})`;
export const BIRTH_LABEL_EXTRA = String.raw`(?:\s*(?:${BIRTH_LABEL_CLOSE}|[(（][^()（）\d\n]{1,8}[)）]|[/／・、,](?:\s*(?:年齢|性別|age|sex))?|${BIRTH_LABEL_SYMBOLS})){0,3}`;
// 見出しの語と並びのあいだの「は」「:」「=」と、英語の「is」（date of birth is …。8回目のレビュー M7）
export const BIRTH_LABEL_IS = String.raw`(?:は|:|=|is(?![A-Za-z]))`;
// 並びの始まりの開きかっこ
const SPAN_OPEN = String.raw`(?:[([【〔〈《「『]\s*)?`;
const AFTER_LABEL = new RegExp(String.raw`${BIRTH_LABEL_EXTRA}\s*(?:${BIRTH_LABEL_IS}\s*)?${SPAN_OPEN}`, 'iuy');
// 文の始まり（行頭、句読点・区切り・空白・開きかっこの後）の見出しの語は、並びとのあいだに1つの「。」「.」をはさんでもよい
// （「，．」の書き方の 生年月日．YYYY/M/D、誕生日．M.D と、見出しに続けた Birthday.D Mon YYYY。11回目のレビュー R6）【案】。
// 文の中の見出しの語の後の「。」は文の終わり（本日誕生日。11/8 入院 の 11/8 は生年月日でない）
const AFTER_LABEL_STOP = new RegExp(String.raw`${BIRTH_LABEL_EXTRA}\s*(?:(?:${BIRTH_LABEL_IS}|[。.])\s*)?${SPAN_OPEN}`, 'iuy');
const LABEL_HEAD_BEFORE = /(?:^|[\s。.、,:;・|(（[［【「『])$/u;
// DOB の後は「:」「=」と、1つの「。」「.」（ＤＯＢ．YYYY/3/4。DOB の見出しは年・元号・英語の月のある並びだけなので、文の中でもよい。11回目のレビュー R6）
const AFTER_DOB = new RegExp(String.raw`(?:\s*(?:${BIRTH_LABEL_CLOSE}|${BIRTH_LABEL_SYMBOLS})){0,3}\s*(?:[:=。.]\s*)?${SPAN_OPEN}`, 'iuy');
// 量の変わり方の語（10-5-3と漸減、15-10-5 で減量、10-5-3→off、12/10/8 から中止）。DOB の後の並びにこれが続けば、ドブタミンの量の並びとみなし、
// 見出しにしない（6回目のレビュー H10）。2桁の年の3つの数の並び（月/日/年、年/月/日）の見分けにも使う（calendar-dates.ts）【案】
export const DOSE_CHANGE_AFTER =
  /^\s*(?:(?:[とでに]|から)\s*)?(?:漸減|減量|漸増|増量|中止|離脱|off(?![A-Za-z])|OFF(?![A-Za-z]))|^\s*(?:→|->|⇒)\s*(?:off(?![A-Za-z])|OFF(?![A-Za-z])|中止|\d+(?:\.\d+)?\s*γ)/u;

// digits は算用数字の桁数（漢数字は null）。lower は小文字の英語の月の略（dec、mar。大文字・小文字の決まった形でないもの）
type DateUnit = { n: number; digits: number | null; month: boolean; lower?: boolean };
const sticky = (re: RegExp, s: string, at: number): RegExpExecArray | null => {
  re.lastIndex = at;
  return re.exec(s);
};
// at から始まる暦日らしい並びの終わりと中身（並びでなければ null）。eraName は並びの前の元号（名前か1字の英字。なければ null）
type DateSpanScan = { end: number; units: DateUnit[]; era: boolean; eraName: string | null };
function scanDateSpan(line: string, at: number, max = 3): DateSpanScan | null {
  for (const withEra of [true, false]) {
    let i = at;
    const e = withEra ? sticky(SPAN_ERA, line, at) : null;
    if (withEra && e === null) continue;
    if (e !== null) i += e[0].length;
    const units: DateUnit[] = [];
    let mode: 'punct' | 'space' | null = null;
    let ja = false;
    let end = i;
    while (units.length < max) {
      let j = end;
      let sepMode: 'punct' | 'space' | 'ja' | 'none' | null = null;
      if (units.length > 0) {
        for (const [re, m] of [[SPAN_SEP_JA, 'ja'], [SPAN_SEP_PUNCT, 'punct'], [SPAN_SEP_SPACE, 'space']] as const) {
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
      // 区切りのない続きは、英語の月の前後だけ（05APR1948）
      if (sepMode === 'none' && mon === null && units.at(-1)?.month !== true) break;
      const unit: DateUnit =
        mon !== null ? { n: englishMonthNumber(mon[0]), digits: null, month: true, lower: !CASED_MONTH.test(mon[0]) } : num !== null ? { n: Number(num[1]), digits: (num[1] ?? '').length, month: false } : { n: kanjiValue(hit[0]), digits: null, month: false };
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
// 並びの西暦の年（DOB の後の並びを生年月日とみなすかに使う。10回目のレビュー Q9）。元号の年（元号の後の区切りのない5・6桁は頭の1・2桁）、
// 4桁の数、区切りのない8桁の頭の4桁から読む。年が2桁（m/d/yy の形、区切りのない6桁）か、年のないものは null
function spanYear(span: DateSpanScan): number | null {
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
const md = (m: DateUnit | undefined, d: DateUnit | undefined) => m !== undefined && d !== undefined && validMonthDay(m.n, d.n);
// 区切りのない数（月日の4桁 MMDD、年月日の6桁 YYMMDD と8桁 YYYYMMDD。元号の後は年が1桁の5桁 YMMDD と6桁 YYMMDD）の月日が成り立つか
function compactValid(u: DateUnit, era = false): boolean {
  const s = String(u.n).padStart(u.digits ?? 0, '0');
  const at = era ? (u.digits === 5 ? 1 : u.digits === 6 ? 2 : -1) : u.digits === 4 ? 0 : u.digits === 6 ? 2 : u.digits === 8 ? 4 : -1;
  return at >= 0 && validMonthDay(Number(s.slice(at, at + 2)), Number(s.slice(at + 2, at + 4)));
}
// 暦日らしい並びか。DOB の後（dob、after-dob）では、小文字の英語の月の略（dec、mar、sep、may）は、すぐ後に日と4桁の年が続くときだけ月とみなす
// （DOB dec 5→3 は減量。6回目のレビュー H10）。
// dob（DOB を見出しとみなすか）は、年（4桁の数、区切りのない6・8桁）・元号・英語の月を含むものだけ。「DOB:」「DOB=」の後の3つの数は、
// はっきり年と分かる2桁の数（32 以上か、0 で始まる 05 のようなもの）を含むときも（DOB: m/d/53、DOB: m/d/05 の形）。
// 「:」のない「DOB 10-5-3」や、31 以下の2桁の数だけの「DOB: 12-10-8」は、量の並びと見分けられないので見出しにしない【案】
function dateLikeSpan(span: { units: DateUnit[]; era: boolean }, kind: BirthSpanKind, colon: boolean): boolean {
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
// 見出しのすぐ後（at は見出しの終わり）の生年月日らしい並び。なければ null。
// kind は見出しの語（label）、DOB（dob。年・元号・英語の月を含む並びだけ）、見出しにならない DOB の後（after-dob。年は問わない）。
// DOB の後の並びに量の変わり方の語（と漸減、→off）が続けば、どちらでもない。
// colon は DOB と並びのあいだに「:」「=」があるか（DOB だけの行の次の行では、前の行の「DOB:」を渡す。省けば見出しと並びのあいだを見る）
export type BirthSpanKind = 'label' | 'dob' | 'after-dob';
// 並びと、並びの見出しの種類、並びの西暦の年（spanYear。匿名化リンタが DOB の後の今の年の暦日を生年月日にしないのに使う）
type BirthSpan = Span & { kind: BirthSpanKind; year: number | null };
// 並びの「日」のすぐ後の日数・日の数え方（誕生日 2日後、2日前に）。語の頭（後医、間質）は日数にしない（15回目のレビュー W10）
const DAY_COUNT_AFTER_SPAN = new RegExp(String.raw`^[後前間目]${DAY_COUNT_END}`, 'u');
export function birthSpanAfterLabel(line: string, at: number, kind: BirthSpanKind, colon?: boolean): { start: number; end: number } | null {
  const s = birthSpanAt(line, at, kind, colon);
  return s === null ? null : { start: s.start, end: s.end };
}
function birthSpanAt(line: string, at: number, kind: BirthSpanKind, colon?: boolean, head = false): BirthSpan | null {
  const gap = sticky(kind === 'label' ? (head ? AFTER_LABEL_STOP : AFTER_LABEL) : AFTER_DOB, line, at);
  const start = at + (gap?.[0].length ?? 0);
  const withColon = colon ?? /[:=]/u.test(gap?.[0] ?? '');
  let span = scanDateSpan(line, start);
  // 見出しの語の後で、並び全体が暦日らしくなければ、前から短くした並びも見る（「生年月日/年齢:」の後の「6桁/年齢」の6桁。7回目のレビュー K8）
  for (let n = (span?.units.length ?? 0) - 1; kind === 'label' && span !== null && !dateLikeSpan(span, kind, withColon) && n >= 1; n -= 1) span = scanDateSpan(line, start, n);
  if (span === null || !dateLikeSpan(span, kind, withColon)) return null;
  const text = line.slice(start, span.end);
  const after = line.slice(span.end, span.end + 16);
  if (SPAN_UNIT_AFTER.test(after) || (text.endsWith('日') && DAY_COUNT_AFTER_SPAN.test(after))) return null;
  if (kind !== 'label' && DOSE_CHANGE_AFTER.test(after)) return null;
  return { start, end: span.end, kind, year: spanYear(span) };
}
// 行の中の生年月日らしい並び（見出しのすぐ後と、「生」「生まれ」「誕生」のすぐ前）。start の順
function birthSpansIn(line: string): BirthSpan[] {
  const out: BirthSpan[] = [];
  for (const m of line.matchAll(BIRTH_LABEL_AT)) {
    const head = LABEL_HEAD_BEFORE.test(line.slice(Math.max(0, m.index - 1), m.index));
    const s = birthSpanAt(line, m.index + m[0].length, m.groups?.dob !== undefined ? 'dob' : 'label', undefined, head);
    if (s !== null) out.push(s);
  }
  // 「生」「生まれ」「誕生」のすぐ前の並びは、その語が行にあるときだけ探す（結果は同じ。手間を減らす。8回目のレビューの時間の指摘）
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
export function birthDateSpans(line: string): Span[] {
  return birthSpansIn(line).map((s) => ({ start: s.start, end: s.end }));
}
// 見出しにならない「DOB:」「DOB=」（DOB: 11-8、DOB: 3.4）のすぐ後の暦日らしい並び。生年月日かドブタミンの量か見分けられないので、
// AI に送る文面では伏せ、保存する文では暦日かもしれないものとして残す（calendar-dates.ts だけが使う。匿名化リンタの error にはしない）。
// 「DOB 3.5」のように「:」「=」のないものは量とみなして見ない。閉じかっこ・記号の後の「:」（【DOB】: 3.4）と、表の「|」、
// 見出しを閉じるかっこ（| DOB | 3.4、【DOB】3.4）の後はよい（8回目のレビュー M7）
const DOB_AT = new RegExp(DOB_WORD, 'giu');
const BARE_DOB_GAP = /[:=|】\]〕〗]/u;
export function spansAfterBareDob(line: string): Span[] {
  const out: Span[] = [];
  for (const m of line.matchAll(DOB_AT)) {
    const at = m.index + m[0].length;
    if (!BARE_DOB_GAP.test(sticky(AFTER_DOB, line, at)?.[0] ?? '')) continue;
    if (birthSpanAfterLabel(line, at, 'dob') !== null) continue;
    const s = birthSpanAfterLabel(line, at, 'after-dob');
    if (s !== null) out.push(s);
  }
  return out;
}

function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function spans(re: RegExp, line: string, keep: (m: RegExpMatchArray) => boolean = () => true): Span[] {
  const out: Span[] = [];
  for (const m of line.matchAll(re)) {
    const start = m.index;
    if (m[0].length > 0 && keep(m)) out.push({ start, end: start + m[0].length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// phi-guard と共通の規則

function findPhones(line: string): Span[] {
  const separated = new RegExp(
    `(?<![\\d+])(?:\\+81${PHONE_SEP}?|0)\\d{1,4}${PHONE_SEP}{1,2}\\d{1,4}${PHONE_SEP}{1,2}\\d{3,4}(?!\\d)`,
    'g',
  );
  return [
    ...spans(separated, line, (m) => {
      const digits = m[0].replace(/\D/g, '');
      const n = m[0].startsWith('+81') ? digits.length - 2 + 1 : digits.length;
      return n >= 10 && n <= 11;
    }),
    ...spans(/(?<!\d)0[1-9]\d{8,9}(?!\d)/g, line),
    // 国番号の後に区切りのないもの（+81 の後の 0 は書いても省いてもよい。+81 と市外局番の 0 を省いた番号を続けた形、+81 の後に空白と 0 から続けた形）
    ...spans(new RegExp(`(?<![\\d+])\\+81${PHONE_SEP}?0?[1-9]\\d{8,9}(?!\\d)`, 'g'), line),
  ];
}

function findEmails(line: string): Span[] {
  // @ の前は64字まで（長い英数字の並びで、始まりの位置ごとに並びの終わりまで読み直さないため。phi-guard も同じ）
  const re = /[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
  return spans(re, line, (m) => !/^\d+x\.(png|jpe?g|webp|gif|svg|avif)$/i.test(m[1] ?? ''));
}

function findPostalCodes(line: string): Span[] {
  return [
    ...spans(new RegExp(`〒\\s?\\d{3}\\s?[${DASH}]?\\s?\\d{4}`, 'g'), line),
    ...spans(new RegExp(`(?<![\\d${DASH}.:/])\\d{3}[${DASH}]\\d{4}(?![\\d${DASH}.:/])`, 'g'), line),
  ];
}

// 12桁以上の数字（全体のレビュー、2026-10-16）。小数の一部（「0.」に続く12桁、12桁に続く「.5」）は除く。
// 英字の後の「.」（No. に続く12桁）と、文の終わりの「.」（12桁の後の句点の「.」）は、小数でないので見る。
// 13桁以上は、英字と続かないものだけ（ULID・ハッシュの中の数字の並びは除く。カード番号のような数だけの並びを見る）。
// 4桁ずつ区切った12桁は、3つとも年の形（1900〜2099）の並び（年の一覧の推移）を除く（4桁の値の並びは D-039）
const YEARISH = (s: string) => /^(?:19|20)\d{2}$/u.test(s);
function findTwelveDigits(line: string): Span[] {
  return [
    ...spans(/(?<!\d)(?<!\d\.)\d{12}(?!\d)(?!\.\d)/g, line),
    ...spans(/(?<![\dA-Za-z])(?<!\d\.)\d{13,}(?![\dA-Za-z])(?!\.\d)/g, line),
    ...spans(/(?<!\d)(\d{4})[ -](\d{4})[ -](\d{4})(?!\d)/g, line, (m) => ![m[1], m[2], m[3]].every((g) => YEARISH(g ?? ''))),
  ];
}

// 年が最後に来る数字の年月日（D/M/YYYY、M.D.YYYY、D-M-YYYY。日・月の順はどちらでもよい）。区切りは同じ記号。年は 4桁（19xx・20xx）。
// 数の並びの途中（前に「数.」「数/」が続くもの、後ろに「/数」が続くもの）は除く（全体のレビュー、2026-10-16。phi-guard と同じ）
const YEAR_LAST_DATE = /(?<![\d./-])(\d{1,2})([/.-])(\d{1,2})\2((?:19|20)\d{2})(?!\d)(?![./-]\d)/g;
const yearLastValid = (m: RegExpMatchArray): boolean => {
  const [a, b] = [Number(m[1]), Number(m[3])];
  return validMonthDay(a, b) || validMonthDay(b, a);
};

function findBirthDates(line: string, dobMaxYear: number): Span[] {
  const western = /(?<!\d)((?:19|20)\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?!\d)/g;
  const compact = /(?<!\d)((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g;
  const englishOld = (order: EnglishDateOrder) => (m: RegExpMatchArray) => {
    const p = englishDateParts(m, order);
    return p.year !== null && p.year <= dobMaxYear && validMonthDay(p.month, p.day);
  };
  // DOB（ドブタミンの略でもある）のすぐ後の並びで、年が dobMaxYear より後のもの（今年の年月日や令和の年の書き方で、ドブタミンの開始・終了の日）は、
  // A-DOB にしない（ふつうの暦日の A-CALENDAR-DATE で知らせる。10回目のレビュー Q9）【案】。
  // ほかの見出しの語（DOB/Age も）の後は年を問わない。年が2桁のもの（m/d/yy の形）と年のないものは今まで通り
  const labeled = birthSpansIn(line)
    .filter((s) => !(s.kind === 'dob' && s.year !== null && s.year > dobMaxYear))
    .map((s) => ({ start: s.start, end: s.end }));
  const out = [
    // 見出しのすぐ後と「生まれ」のすぐ前の並びを先に置く（同じ位置の短い形（05APR）より、並び全体（05APR1948）を採る）
    ...labeled,
    ...spans(western, line, (m) => Number(m[1]) <= dobMaxYear && validMonthDay(Number(m[2]), Number(m[3]))),
    ...spans(ERA_DATE, line, (m) => {
      const n = m[4] === '元' ? 1 : Number(m[4]);
      const year = (ERA_START[eraOf(m)] ?? 0) + n - 1;
      return eraDateShape(m) && year <= dobMaxYear && validMonthDay(Number(m[5]), Number(m[6]));
    }),
    ...spans(compact, line, (m) => Number(m[1]) <= dobMaxYear),
    ...EN_FORMS.flatMap(([re, order]) => spans(re, line, englishOld(order))),
    // 年が最後の年月日と、漢数字の年（元号・西暦）の年月日（全体のレビュー、2026-10-16。phi-guard と同じ）
    ...spans(YEAR_LAST_DATE, line, (m) => Number(m[4]) <= dobMaxYear && yearLastValid(m)),
    ...spans(KANJI_MONTH_DAY_RE, line, (m) => {
      const p = kanjiMonthDay(m);
      return p !== null && p.year !== null && p.year >= 1868 && p.year <= dobMaxYear;
    }),
  ];
  // 生年月日・誕生日・D.O.B の語が同じ行にあれば、その行の年月日・M月D日・英語の月日を、年を問わず疑う（生まれ・DOB は除く。F11、G14）
  if (BIRTH_LINE.test(line)) out.push(...spans(BIRTH_LINE_DATE, line, (m) => birthDateValid(m[0])));
  return out;
}

const HONORIFIC_KANJI = /([\p{sc=Han}]{1,4})(さん|さま|ちゃん|様|氏|殿|君|先生)(?![\p{sc=Han}])/gu;
const HONORIFIC_KATAKANA = /([ァ-ヶ][ァ-ヶー]{1,7})(さん|さま|ちゃん|様|氏|先生)(?![\p{sc=Han}])/gu;
const HONORIFIC_LATIN = /\b(?:Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+[A-Z][a-z]+/g;
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

function findHonorificNames(line: string): Span[] {
  return [
    ...spans(HONORIFIC_KANJI, line, (m) => {
      const run = m[1] ?? '';
      return !NAME_STOP_EXACT.has(run) && !NAME_STOP_SUFFIX.some((w) => run.endsWith(w));
    }),
    ...spans(HONORIFIC_KATAKANA, line, (m) => !KATAKANA_STOP.has(m[1] ?? '')),
    ...spans(HONORIFIC_LATIN, line),
  ];
}

function findAddresses(line: string): Span[] {
  const res = [
    /(?:北海道|東京都|京都府|大阪府|[\p{sc=Han}]{2,3}県)[\p{sc=Han}ヶケ]{0,6}?[市区町村郡]/gu,
    /(?<!\d)\d{1,3}\s*丁目/g,
    /(?<!\d)\d{1,5}\s*番地/g,
    new RegExp(`[\\p{sc=Han}]{1,6}[市区町村][\\p{sc=Han}ぁ-んァ-ヶー]{0,8}\\d{1,4}[${DASH}]\\d{1,4}(?:[${DASH}]\\d{1,4})?`, 'gu'),
  ];
  return res.flatMap((re) => spans(re, line));
}

// ---------------------------------------------------------------------------
// core だけの規則

// 患者IDの形の本体（^ と $ を外したもの）。読めない形や、空の文字列に合う形（.* など）は null
export function patientIdPatternBody(pattern: string): string | null {
  const body = pattern.replace(/^\^/, '').replace(/(?<!\\)\$$/, '');
  try {
    return new RegExp(`^(?:${body})$`, 'u').test('') ? null : body;
  } catch {
    return null;
  }
}

// 患者IDの形。英数字の途中では合わないようにして探す。使えない形は設定のスキーマで止める（DeviceSettings）
function findPatientIds(line: string, patterns: readonly string[]): Span[] {
  const out: Span[] = [];
  for (const p of patterns) {
    const body = patientIdPatternBody(p);
    if (body === null) continue;
    out.push(...spans(new RegExp(`(?<![0-9A-Za-z])(?:${body})(?![0-9A-Za-z])`, 'gu'), line));
  }
  return out;
}

// 「T.Y.」「T. Y」「Y氏」「TYさん」
function findInitials(line: string): Span[] {
  return [
    ...spans(/(?<![A-Za-z.])[A-Z]\s?\.\s?[A-Z]\.?(?![A-Za-z])/g, line),
    ...spans(/(?<![A-Za-z])[A-Z]{1,2}\s?(?:氏|さん|さま|様|君|ちゃん)/g, line),
  ];
}

// 病院・医院・クリニックなどの名前。「当院」「近医」「前医」や一般名（大学病院、急性期病院 など）は除く。
// 名前は24字まで（長い漢字・カタカナ・英数字の並びで、始まりの位置ごとに並びの終わりまで読み直さないため）
const FACILITY = /([\p{sc=Han}\p{sc=Katakana}ーA-Za-z0-9]{2,24}?)(病院|医院|クリニック|診療所|医療センター)/gu;
const FACILITY_GENERIC = new Set([
  '大学', '総合', '一般', '市中', '地域', '基幹', '連携', '急性期', '慢性期', '療養', '療養型', '精神科', '専門',
  '公立', '民間', '個人', '中小', '近隣', '協力', '研修', '救急', '指定', '拠点', '中核', '災害', '支援', '有床',
  '無床', '転院先', '紹介先', '紹介元', '他', '前', '近', '当', '同', '別', '各', '小児', '循環器', '専門医',
]);

function findFacilities(line: string): Span[] {
  return spans(FACILITY, line, (m) => !FACILITY_GENERIC.has(m[1] ?? ''));
}

// 英語の月の名前の後の数が、量・回数・大きさ・時刻や方向（AUG 3錠、OCT 2回施行、Dec 2 mg、May 5mg、OCT 1.5 mm、Mar 2 回、
// OCT 12時方向。「時点」は除く。6回目のレビュー H11）なら暦日でない
// （5回目のレビュー G17。calendar-dates.ts も同じものを使う）。1字の助数詞は、続けて書いたときは後ろに漢字が続いてもよい（2回施行）。
// 空白をはさんだときは後ろが区切りのときだけ（「Nov 12 回診」「Nov 12 本日」は暦日）
const ENGLISH_COUNT_AFTER =
  /^(?:\.\d|\s?時(?!点)|\s?(?:mEq|mmol|μg|mcg|mg|mL|ml|dL|cm|mm|kg|γ|錠|単位|日分|日間|時間|か月|ヶ月|カ月|ヵ月|週|歳|才|ずつ|程度|以上|以下|未満)|[gLAV%](?![A-Za-z\p{sc=Katakana}ー-]|型|群|病棟|棟)|[本回個枚管袋包切周倍量]|T(?![A-Za-z])|\s[本回個枚管袋包](?=$|[\s、。,.):;/\d]))/u;
export function englishCountAfter(line: string, end: number): boolean {
  return ENGLISH_COUNT_AFTER.test(line.slice(end, end + 16));
}

// 本文中の暦日（年月日、月日、元号、英語の月日）。生年月日らしいもの（error）は別の規則が先に採る。
// 月と日のあいだの「の」（11月の10日、2025年11月の10日）も月日（calendar-dates.ts と同じ。13回目のレビュー T8）。
// 日数・日の数え方（11月の3日間、2月の14日間、11月の2日目、11月3日間）は暦日でない（calendar-dates.ts と同じ。14回目のレビュー V9）。
// 日数の終わりは後ろの語まで見る（11月10日間質性肺炎、11月12日後医へ、11月9日目標達成 は暦日。DAY_COUNT_SUFFIX。15回目のレビュー W10）
const YMD_DATE = new RegExp(String.raw`(?<!\d)\d{4}\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(?:(?<=月\s*)の\s*)?(\d{1,2})(?!\s*日${DAY_COUNT_SUFFIX})日?(?!\d)`, 'g');
const MONTH_DAY_DATE = new RegExp(String.raw`(?<![\d年])(\d{1,2})\s*月\s*(?:の\s*)?(\d{1,2})\s*日(?!${DAY_COUNT_SUFFIX})`, 'g');
function findCalendarDates(line: string): Span[] {
  const english = (order: EnglishDateOrder) => (m: RegExpMatchArray) => {
    const p = englishDateParts(m, order);
    const end = (m.index ?? 0) + m[0].length;
    return validMonthDay(p.month, p.day) && !englishCountAfter(line, end) && !(order === 'month' && p.year === null && englishSlashAfter(line, end));
  };
  return [
    ...spans(YMD_DATE, line, (m) =>
      validMonthDay(Number(m[1]), Number(m[2])),
    ),
    ...spans(MONTH_DAY_DATE, line, (m) => validMonthDay(Number(m[1]), Number(m[2]))),
    // 年が最後の年月日（D/M/YYYY。全体のレビュー、2026-10-16）
    ...spans(YEAR_LAST_DATE, line, yearLastValid),
    // 月日の並び（11月10・12日、11月10、12日。5回目のレビュー G13）
    ...spans(/(?<![\d年])(\d{1,2})\s*月\s*(?:の\s*)?(\d{1,2})(?:\s*[・、,]\s*\d{1,2})+\s*日/g, line, (m) => validMonthDay(Number(m[1]), Number(m[2]))),
    ...spans(ERA_DATE, line, (m) => eraDateShape(m) && validMonthDay(Number(m[5]), Number(m[6]))),
    // 漢数字の月日（十一月八日、11月十日。6回目のレビュー H12）
    ...spans(KANJI_MONTH_DAY_RE, line, (m) => kanjiMonthDay(m) !== null),
    ...EN_FORMS.flatMap(([re, order]) => spans(re, line, english(order))),
  ];
}

type Rule = { id: AnonymizationRule; level: LintLevel; find: (line: string, ctx: AnonymizationContext) => Span[] };

// 規則の重さ。文章の中の暦日だけは、呼び出し側が決められる（既定は error。A-023）
function levelOf(rule: Rule, ctx: AnonymizationContext): LintLevel {
  return rule.id === 'A-CALENDAR-DATE' ? (ctx.calendarDates ?? 'error') : rule.level;
}

// 並び順が同じ重さのなかでの優先順位になる（phi-guard と同じく、error を先に採る）
const ANONYMIZATION_RULES: readonly Rule[] = [
  { id: 'A-PHONE', level: 'error', find: findPhones },
  { id: 'A-EMAIL', level: 'error', find: findEmails },
  { id: 'A-POSTAL', level: 'error', find: findPostalCodes },
  { id: 'A-DIGITS12', level: 'error', find: findTwelveDigits },
  { id: 'A-DOB', level: 'error', find: (line, ctx) => findBirthDates(line, ctx.dobMaxYear) },
  { id: 'A-PATIENT-ID', level: 'error', find: (line, ctx) => findPatientIds(line, ctx.patientIdPatterns ?? []) },
  { id: 'A-HONORIFIC', level: 'warn', find: findHonorificNames },
  { id: 'A-INITIALS', level: 'warn', find: findInitials },
  { id: 'A-ADDRESS', level: 'warn', find: findAddresses },
  { id: 'A-FACILITY', level: 'warn', find: findFacilities },
  { id: 'A-CALENDAR-DATE', level: 'warn', find: findCalendarDates },
];

// 重ならなければ taken（始まりの順に並べておく）に入れて true を返す。重なりは前後の1つずつだけを見る
// （採ったものどうしは重ならないので、終わりも始まりの順に並ぶ。長い行でも手間を行の長さにほぼ比例させる。5回目のレビュー。phi-guard も同じ）
function takeSpan(taken: Span[], h: Span): boolean {
  let lo = 0;
  let hi = taken.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((taken[mid]?.start ?? 0) < h.end) lo = mid + 1;
    else hi = mid;
  }
  const left = taken[lo - 1];
  if (left !== undefined && left.end > h.start) return false;
  taken.splice(lo, 0, { start: h.start, end: h.end });
  return true;
}

export function lintAnonymization(text: string, ctx: AnonymizationContext): AnonymizationFinding[] {
  const findings: AnonymizationFinding[] = [];
  let base = 0;
  for (const line of text.split('\n')) {
    // 丸数字などの番号は、NFKC の前に「・」にする（字数は変えない。すぐ後の暦日・生年月日に数字をくっつけない。9回目のレビュー P5）。
    // 「，．」の書き方の読点・句点は「、」「。」にする（字数は変えない。文の終わりの「．」の後の暦日を小数の続きにしない。11回目のレビュー R6）
    // 見えない書式の文字（ゼロ幅の空白・ソフトハイフンなど）は取り除いて調べる（数字のあいだにはさんで、形を崩せないように。phi-guard と同じ）
    const normalized = normalizeWithMap(foldEnclosedNumbers(foldSentencePunct(line, 'detect')), { dropInvisible: true });
    const norm = foldDateDashes(normalized.norm);
    const hits: (Span & { rule: Rule; order: number })[] = [];
    ANONYMIZATION_RULES.forEach((rule, order) => {
      for (const s of rule.find(norm, ctx)) hits.push({ ...s, rule, order });
    });
    // error を先に、同じ重さなら始まりの早い順（同じなら規則の順）に採り、重なる判定は出さない
    const rank = (l: LintLevel) => (l === 'error' ? 0 : 1);
    hits.sort((a, b) => rank(levelOf(a.rule, ctx)) - rank(levelOf(b.rule, ctx)) || a.start - b.start || a.order - b.order);
    const taken: Span[] = [];
    for (const h of hits) {
      if (!takeSpan(taken, h)) continue;
      const r = originalRange(normalized, h.start, h.end, line.length);
      findings.push({ rule: h.rule.id, level: levelOf(h.rule, ctx), start: base + r.start, end: base + r.end });
    }
    base += line.length + 1;
  }
  return findings.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function hasAnonymizationErrors(findings: readonly AnonymizationFinding[]): boolean {
  return findings.some((f) => f.level === 'error');
}
