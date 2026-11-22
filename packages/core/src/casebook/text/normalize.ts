// 1文字ずつ NFKC にし、正規化後の各位置が元の文字列のどこから来たかを覚える。
// 全角の数字や記号をそろえて調べ、見つけた位置は元の文字列（全角のまま）で返すために使う。
// 濁点・半濁点（半角の ﾞ ﾟ と結合文字 U+3099、U+309A）は、前の字といっしょに NFKC にする（ﾀﾞ は「ダ」）。
// 1字ずつだと「タ」と結合文字に分かれ、行ごと NFKC にする phi-guard と判定が変わるため（6回目のレビュー H13）。
// 合わせた字の位置は、前の字の始まりから濁点の終わりまで
export type NormalizedText = {
  norm: string;
  from: number[]; // 正規化後の位置 i の文字が、元の文字列で始まる位置
  to: number[]; // 同じく、元の文字列で終わる位置（含まない）
};

const isVoicedMark = (c: number) => c === 0xff9e || c === 0xff9f || c === 0x3099 || c === 0x309a;

// 見えない書式の文字：ソフトハイフン、ゼロ幅の空白・接続子、左右の向きの印・埋め込み・分離、語をつなぐ字、見えない演算子、BOM、モンゴル文字の母音の区切り。
// 数字のあいだにはさむと、電話番号・12桁の数字・暦日が見えないまま形を崩す（全体のレビュー、2026-10-16）。
// 匿名化リンタは、これらを取り除いてから調べる（dropInvisible。phi-guard の INVISIBLE と同じ集まり）
const INVISIBLE_ONLY = /^[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]+$/u;

export function normalizeWithMap(text: string, options: { readonly dropInvisible?: boolean } = {}): NormalizedText {
  let norm = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  while (i < text.length) {
    const first = text.codePointAt(i) ?? 0;
    let end = i + (first > 0xffff ? 2 : 1);
    while (end < text.length && isVoicedMark(text.charCodeAt(end))) end += 1;
    if (options.dropInvisible === true && INVISIBLE_ONLY.test(text.slice(i, end))) {
      // 正規化後には残さない（位置の対応も作らない。見つけた範囲は、前後の字の位置から元の文字列に戻る）
      i = end;
      continue;
    }
    const piece = text.slice(i, end).normalize('NFKC');
    for (let k = 0; k < piece.length; k += 1) {
      from.push(i);
      to.push(end);
    }
    norm += piece;
    i = end;
  }
  return { norm, from, to };
}

// 「，．」の書き方（学術の文でよく使う全角の読点・句点）と小字形の「﹐」「﹒」を、NFKC の前に「、」「。」にする【案】。
// NFKC だけだと「．」が「.」、「，」が「,」になり、文の終わりの「．」のすぐ後の暦日（72歳男性．3.4.YYYY 生まれ、発熱し，11.10 に入院）が
// 小数や数の続きに見え、見分けられない（11回目のレビュー R6）。1つのコード単位を1つにする（字数を変えないので、位置はそのまま使える）。
// 次のものはそのまま（NFKC で「.」「,」）：
// - 英数字（全角も）にはさまれた「．」（小数 １２．３、メールアドレス、ＤＯＢ．３/４）と、1字の英字の後の「．」（かしら文字 Ｔ．Ｙ．、Ｔ． Ｙ．）
// - 数字にはさまれた「，」（数の区切り １，０００、英語の月日の年の前 Mar Ｄ，ＹＹＹＹ）
// 暦日と生年月日の見分け（匿名化リンタ・phi-guard・calendar-dates.ts）と、文章から記録・ラフ記法・今日のメモの読み取り（保存する文を読みやすい
// 「。」「、」にし、文の区切りを見分けられるようにする）の前に使う。「…」「‥」は変えない（NFKC で「...」「..」。暦日の見分けは、
// 数字のすぐ後の「.」だけを小数の続きとみなすので、「...」の後の暦日も見る。DOB… の「...」は見出しの続きの記号）
// 数字にはさまれた「．」「，」でも、すぐ後が暦日の形（DATE_AFTER_PUNCT）なら、数で終わる文の区切りとみなして「。」「、」にする
// （CRP 12.3．11/10 に、eGFR 25．11/12 に透析導入、Hb 7.2，11.10 に、BMI 22．3.4.YYYY 生まれ。12回目のレビュー S5）【案】。
// ただし数字にはさまれた「．」は値の小数点かもしれないので、次のときは区切りにしない（13回目のレビュー T5）【案】：
// - 「-」でつないだ組（０．５－１錠、PSL ０．５－１ ｍｇ/ｋｇ、INR 1．5-2 に調整）は、組のすぐ後に暦日の語（に、から、入院、退院、曜日など）が
//   あるときだけ区切りにする（「11-8」の形を暦日とみなすのと同じ。に の後が量の変わり方（に調整、に増量）なら区切りにしない）
// - 「/」「.」でつないだ組（Cr 1．2/1、3．5/5γ）は、組のすぐ後に単位・助数詞・γ・時の語・「を目標」が続けば区切りにしない
// - 前の数がすでに小数（CRP 12.3．11/10）なら、その「．」は小数点になれないので区切り
// 保存する文の読み取り（mode 'stored'。文章から記録・ラフ記法・今日のメモ）では、数字にはさまれた「．」はいつも書いたとおりに残す
// （値の小数点・数の区切りかもしれない。保存する文の数を変えない。14回目のレビュー V7）【案】。区切りにするのは暦日の見分け（mode 'detect'。
// AI に送る文面・匿名化リンタ・phi-guard）だけで、そこで見つけた暦日は暦日かもしれないもの（AI に送る文面では伏せ、保存する文は書いたまま残して
// その行を知らせる。calendar-dates.ts）。生まれの語が続く生年月日らしいものと、残すと前の数と後ろの暦日が1つの暦日の形になるもの（BNP 1980．11/12）は、
// 保存する文でも区切りにする（foldSentencePunct と calendar-dates.ts の foldStoredPunct）
// 前が元号の年（R7．11/8、平成30．4/1）か年のものは年月日の区切りなので、そのまま。4桁の数を年とみなすのは、YYYY．M.D の形と、
// 行頭と、年・誕生の語の後と、生まれの語が続くときだけ（BNP 1980．11/12、尿量 2000．11/10 は値）。
// 1字の英字の元号（M、T、S、H、R）は、すぐ前が英数字でなく（E4V5M6、cT2N1M0 の M は元号でない）、年が元号の範囲の中のものだけ
// （M 45、T 15、S 64、H 31、R 10 まで。T 38 は体温）。S1〜S4 は心音の名前なので元号にしない（年・生年月日の語の後は除く。13回目のレビュー T6）【案】
const SENTENCE_PUNCT = /[．﹒，﹐]/gu;
const PUNCT_ALNUM = /[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]/u;
const PUNCT_LATIN = /[A-Za-zＡ-Ｚａ-ｚ]/u;
const PUNCT_DIGIT = /[0-9０-９]/u;
// 「．」「，」のすぐ後の暦日の形（NFKC の前の字で見る。全角の「．」は区切りにしない（２０２５．１１．８ はそのまま））：
// - 数の組（11/10、11.9、25/11/10、3/4/YYYY、YYYY.11、53.3.4）。組の後に数・小数（「.」「．」「。」と数。２回かけても同じになるよう「。」も）・英字・単位・「/」が
//   続くもの（1．5/24h、1．2/1．0）は除く。組の始まり・区切り・終わり・3つめの数を取り出す
// - 英語の月の前の日（10 Nov YYYY、4 Mar YYYY）
// - 生まれの語の前の区切りのない4〜8桁（MMDD 生、YYMMDD 生）と、区切りのない8桁の年月日
const D = '[0-9０-９]';
// 生まれの語の本体（生まれ・生れ・産まれ・産れ、誕生・誕生日、出生、「生」だけ）。匿名化リンタ・AI に送る文面・保存する文で同じものを使う
// （phi-guard は写し。NFKC の前の字でも見るので、全角・半角のどちらでもよい）【案】。
// - 生食・生検・生化学・生活・生理食塩水などの語の頭の「生」と、出生時・出生歴・出生体重などは除く（11回目のレビュー N1、14回目のレビュー V5）
// - 送り仮名を略した「生れ」「産れ」も生まれの語（15回目のレビュー W12）
// - 「誕生」は、そのままか「誕生日」だけ。誕生会・誕生日会・誕生祝い・誕生パーティのように漢字・カタカナが続く語は、生まれた日の書き方でない。
//   「誕生日」だけのものは、生まれた月日を書いたものかもしれないので今まで通り生まれの語（15回目のレビュー W11）
// - 「生まれ故郷」「生まれ変わ」も生まれた日の書き方でない（W11）
// - 「生まれつき」「生まれ付き（付いた）」「生まれ育ち」「生まれ育った」「生まれながら」「生まれ持った」「生まれて初めて（はじめて）」も
//   生まれた日の書き方でない（前の値・暦日を生年月日にしない。「生まれ」「生まれの」「生まれた」「生まれで」は今まで通り。16回目のレビュー X6）【案】
// - 「生の」は生まれの語にしない（生の魚・生の牡蠣のような食べ物の書き方と見分けられないので。15回目のレビュー W12）
export const BORN_CORE = String.raw`(?:[生産]ま?れ(?!故郷|変わ|つき|付|育|ながら|持|て(?:初|始|はじ))|誕生日?(?![\p{sc=Han}\p{sc=Katakana}ー])|出生(?!\p{sc=Han})|生(?![\p{sc=Han}\p{sc=Katakana}\p{sc=Hiragana}ー]))`;
const BORN_WORD = String.raw`\s?(?:[にで]\s*)?${BORN_CORE}`;

// 日数・日の数え方の終わり（NFKC にそろえたあとの形）。暦日の見分け（calendar-dates.ts）と匿名化リンタで同じものを使う（phi-guard は写し）。
// 「日」のすぐ後に続けて書いた「間」「目」「後」（3日間、2日目、3日後）が日数・日の数え方になるのは、その後ろが行末・空白・区切り・助詞か、
// 日数に続けて書く語（入院、投与、経過、続く、程度、以内、おき、ごと…）のときだけ。
// 間質・間欠・間接・後医・後壁・後日・目標・目眩などの語の頭は日数の終わりでない（11月10日間質性肺炎、11月12日後医へ は暦日。15回目のレビュー W10）【案】
export const DAY_COUNT_END = String.raw`(?=$|[\s、。,.:;)\]」』】〜~\-/!?]|[にでのはをがもとやへか]|ほど|くらい|ぐらい|まで|より|ずつ|だけ|ばかり|おき|ごと|程|以[上内下]|前後|未満|続|継続|持続|経過|入院|入所|投与|内服|服用|使用|治療|加療|絶食|禁食|絶飲食|安静|休薬|観察|施行|点滴|静注|留置|延長|追加|連続|外泊|通院|発熱|毎)`;
export const DAY_COUNT_SUFFIX = String.raw`(?:間|目|後)${DAY_COUNT_END}`;
const DATE_AFTER_PUNCT = new RegExp(
  String.raw`^(?:(${D}{1,4})\s?([./／\-－])\s?(${D}{1,2})(\s?[./／\-－]\s?${D}{1,4})?(?!${D}|[.．﹒。/／]${D}|[A-Za-zＡ-Ｚａ-ｚμ%％])` +
    String.raw`|${D}{1,2}(?:st|nd|rd|th)?\s?[/\-]?\s?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?![a-z])` +
    String.raw`|${D}{4,8}${BORN_WORD}|(?:19|20|１９|２０)${D}{6}(?!${D}))`,
  'iu',
);

// 数のすぐ後の助数詞と単位（NFKC にそろえたあとの形。暦日の見分け（calendar-dates.ts の COUNTER）と同じもの）。
// 1字の助数詞は、後ろに漢字が続けば語の頭（本人、回診、管理）とみなして助数詞にしない。
// 1字の英字の単位（A、V、L、g、%）は続けて書いたときだけで、後ろに英字・カタカナ・「-」・「型」「群」「病棟」が続けば単位にしない。
// γ は空白1つをはさんでよい。後ろに「-」・英字・カタカナが続けば単位にしない（γ-GTP）
export const COUNTER_ONE = '本|回|管|個|切|点|包|周|枚|倍|量|袋|筒|杯|滴|秒';
export const COUNTER_WORD = '錠(?!剤)|単位|程度|ずつ|以下|以上|未満|日分|項目|セット|アンプル|バイアル|カプセル';
export const UNITS_MULTI = 'mEq|mmol|μg|mcg|mg|mL|ml|dL|cm|mm';
export const UNITS_ONE = 'g|L|A|V|%';
export const COUNTER = String.raw`(?:(?:${COUNTER_ONE})(?!(?!目)\p{sc=Han})|\s(?:${COUNTER_ONE})(?=$|[\s、。,.):;/\d])|\s?(?:${COUNTER_WORD})(?![ァ-ヶー])|\s?(?:${UNITS_MULTI})(?![A-Za-z])|\s?γ(?![A-Za-z\p{sc=Katakana}ー-])|(?:${UNITS_ONE})(?![A-Za-z\p{sc=Katakana}ー-]|型|群|病棟|棟))`;
// に の後が量・大きさ・広がりの変わり方か位置（1/2に減量、2/3に縮小、1/3 に潰瘍）。暦日の語とみなさない（calendar-dates.ts と同じ）
export const NI_NOT_DATE = '減|増|な[っりる]|低下|上昇|軽減|改善|悪化|縮小|短縮|拡大|調整|変更|分割|希釈|半減|漸|及|相当|達|潰瘍|狭窄|以下|以上|程度|病変|浸潤|限局';
// 曜日（11/10(月)、11/10（月曜）。NFKC にそろえたあとの形）
export const WEEKDAY = String.raw`\(\s*[月火水木金土日](?:曜日?)?\s*\)`;
// 「-」でつないだ組のすぐ後の暦日の語（NFKC にそろえたあとの形。13回目のレビュー T5）。
// 数字にはさまれた「．」の後の組だけに使うので、に・まで の後が目標の値の書き方（に維持、に設定、にコントロール、に保つ、に是正、に補正、まで延長）の
// ものも暦日の語にしない（INR 2．5-3 にコントロール、目標 Hb 7．5-8 に維持 は値の範囲。14回目のレビュー V7）【案】
const NI_TARGET = '維持|設定|コントロール|保|是正|緩和|補正|延長|管理|安定|留|収|抑|調節|目標';
const DASH_DATE_AFTER = new RegExp(
  String.raw`^\s*(?:${WEEKDAY}|に(?!(?:${NI_NOT_DATE}|${NI_TARGET}))|から|より|まで(?!\s*(?:${NI_NOT_DATE}|${NI_TARGET}|回復))|頃|ごろ|入院|退院|受診|来院|転院|転科|手術|施行|開始|終了|中止|再開|予定|提出|採取|採血|以降|以後)`,
  'u',
);
// 「/」「.」でつないだ組のすぐ後の量の書き方：助数詞・単位・γ・時の語・「を目標」（3．5/5γ、1．5/2時間、7．5/8 を目標。13回目のレビュー T5）。
// 時の語は語の終わりのものだけ（日間、時間後、週ごと、か月以上はよい。日中、日没、週末、週明け、時間外、月末、月初は語の頭なので値の書き方にしない）。
// 「を目標に」（Hb 8．11/30 を目標に退院調整）は目標の日の書き方にもなるので、値の書き方にしない（14回目のレビュー V8）【案】
const TIME_WORD_END = String.raw`(?=$|[間目後前毎以程分半]|[^\p{sc=Han}\p{sc=Katakana}ー])`;
const VALUE_AFTER_PAIR = new RegExp(
  String.raw`^(?:${COUNTER}|\s(?:L|g)(?![A-Za-z\p{sc=Katakana}ー-])|\s?(?:歳|才|度|°C|kg|割)|\s?(?:時間|分(?!娩)|週|か月|ヶ月|カ月|ヵ月|ケ月|日|月)${TIME_WORD_END}|\s*を?\s*目標(?!\s*に))`,
  'u',
);
// 前の数がすでに小数（CRP 12.3．11/10、Ｈｂ ７．２．１１/１０）
const DECIMAL_BEFORE = new RegExp(String.raw`${D}[.．]${D}+$`, 'u');
// 年月日の区切りの前の年と元号の年（13回目のレビュー T6）
const YEAR_BEFORE = new RegExp(String.raw`(?<!${D})(?:19|20|１９|２０)${D}{2}$`, 'u');
const ERA_LETTER_BEFORE = new RegExp(String.raw`(?<![A-Za-zＡ-Ｚａ-ｚ0-9０-９])([MTSHRＭＴＳＨＲ])\s?(${D}{1,2})$`, 'u');
const ERA_WORD_BEFORE = new RegExp(String.raw`(?:(?<!\p{sc=Han})[明大昭平令]|明治|大正|昭和|平成|令和)\s?${D}{1,2}$`, 'u');
const ERA_LETTER_MAX: Readonly<Record<string, number>> = { M: 45, T: 15, S: 64, H: 31, R: 10 };
// 年・生年月日の語（西暦 YYYY．…、生年月日：YYYY．…）と、生まれの語（YYYY．M/D 生まれ。生食・生検などの語の頭は除く。14回目のレビュー V5）
const YEAR_WORD_BEFORE = /(?:年|西暦|生年月日|誕生日|出生日?|生ま?れ|D\.?O\.?B\.?|birth\s*(?:day|date)?)\s*[)）】\]]?\s*[:：=]?\s*$/iu;
const BORN_AFTER_PAIR = new RegExp(String.raw`^${BORN_WORD}`, 'u');
const BORN_AT_END = new RegExp(String.raw`${BORN_WORD}$`, 'u');
const LINE_HEAD_BEFORE = /(?:^|\n)[\s・*+-]*$/u;
// from が行頭（箇条書きの印のあと）か
const lineHeadAt = (text: string, from: number) =>
  LINE_HEAD_BEFORE.test(text.slice(Math.max(0, from - 12), from)) && (from < 12 || text.lastIndexOf('\n', from - 1) >= from - 12);
function yearOrEraBefore(text: string, at: number, dotted: boolean, pairAfter: string): boolean {
  const before = text.slice(Math.max(0, at - 8), at);
  const y = YEAR_BEFORE.exec(before);
  // 4桁の数は、年月日の形（YYYY．M.D）か、行頭か、年・生年月日の語の後か、生まれの語が続くときだけ年とみなす（BNP 1980．11/12 は値）
  const wordBefore = (from: number) => YEAR_WORD_BEFORE.test(text.slice(Math.max(0, from - 12), from).normalize('NFKC'));
  const born = BORN_AFTER_PAIR.test(pairAfter);
  if (y !== null) return dotted || born || wordBefore(at - y[0].length) || lineHeadAt(text, at - y[0].length);
  if (ERA_WORD_BEFORE.test(before)) return true;
  const e = ERA_LETTER_BEFORE.exec(before);
  if (e === null) return false;
  const letter = (e[1] ?? '').normalize('NFKC');
  const n = Number((e[2] ?? '').normalize('NFKC'));
  if (n < 1 || n > (ERA_LETTER_MAX[letter] ?? 0)) return false;
  // S1〜S4 は心音（心音 S3．11/10 に消失）。年・生年月日の語の後と、生まれの語が続くときだけ元号にする
  return letter !== 'S' || n > 4 || born || wordBefore(at - e[0].length);
}
// 生まれの語の前の年（YYYY 生まれ）の「．」「，」の前が、月日・日月（M．D．YYYY、M/D．YYYY、ＭＭ．Ｄ．ＹＹＹＹ生、M，D，YYYY）か、
// 英語の月日・日月（Mon D，YYYY）なら、その「．」「，」は年月日の中の区切り（文の区切りにすると、生年月日が月日と年に分かれ、
// 生年月日として見分けられない。14回目のレビュー V6）【案】
const BORN_YEAR_AFTER = new RegExp(String.raw`^(?:19|20|１９|２０)${D}{2}${BORN_WORD}`, 'u');
const EN_MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_DAY_BEFORE = new RegExp(
  String.raw`(?:(?<![0-9])[0-9]{1,2}\s?[./,・-]\s?[0-9]{1,2}|(?<![a-z])${EN_MONTH}\.?\s?[/-]?\s?[0-9]{1,2}(?:st|nd|rd|th)?|(?<![0-9])[0-9]{1,2}(?:st|nd|rd|th)?\s?[/-]?\s?${EN_MONTH}\.?)\s?$`,
  'iu',
);
const monthDayBefore = (text: string, at: number) => MONTH_DAY_BEFORE.test(text.slice(Math.max(0, at - 14), at).normalize('NFKC'));
// 英語の月の名前のすぐ後（D Mon，YYYY の「，」。年の前の区切り）
const EN_MONTH_BEFORE = new RegExp(String.raw`(?<![a-z])${EN_MONTH}\.?\s?$`, 'iu');
// 「．」「，」のすぐ後の暦日の形。'none' は暦日の形でない（区切りにしない）、'birth' は生まれの語が続く生年月日らしいもの、'date' はほかの暦日
type PunctDate = 'none' | 'date' | 'birth';
function dateAfterPunct(text: string, at: number, digits: boolean): PunctDate {
  const m = DATE_AFTER_PUNCT.exec(text.slice(at + 1, at + 25));
  if (m === null) return 'none';
  const pairEnd = at + 1 + m[0].length;
  const pairAfter = text.slice(pairEnd, pairEnd + 16).normalize('NFKC');
  const sep = (m[2] ?? '').normalize('NFKC');
  if (yearOrEraBefore(text, at, sep === '.', pairAfter)) return 'none';
  const found: PunctDate = BORN_AFTER_PAIR.test(pairAfter) || BORN_AT_END.test(m[0]) ? 'birth' : 'date';
  if (m[1] === undefined) return BORN_YEAR_AFTER.test(m[0]) && monthDayBefore(text, at) ? 'none' : found;
  // 数の組は、月/日（1〜12/1〜31）か、2桁・4桁の年/月（…/1〜12）として成り立つものだけ（１，０００.５ は数の区切り）
  const [aText, bText] = [m[1].normalize('NFKC'), (m[3] ?? '').normalize('NFKC')];
  const [a, b] = [Number(aText), Number(bText)];
  if (!((a >= 1 && a <= 12 && b >= 1 && b <= 31) || ((aText.length === 2 || aText.length === 4) && b >= 1 && b <= 12))) return 'none';
  if (!digits || DECIMAL_BEFORE.test(text.slice(Math.max(0, at - 12), at))) return found;
  // 数字にはさまれた「．」「，」：値の小数点かもしれないもの（13回目のレビュー T5）
  if (sep === '-' && m[4] === undefined) return DASH_DATE_AFTER.test(pairAfter) ? found : 'none';
  return VALUE_AFTER_PAIR.test(pairAfter) ? 'none' : found;
}
// 空白をはさんだ「．」「，」の年月日の並び（YYYY． M． D、SYY． M． D（全角の空白も）、ＹＹＹＹ ． Ｍ ． Ｄ、生年月日：YYYY， M， D。16回目のレビュー X4）【案】。
// 数字のすぐ隣でない「．」「，」は文の区切りにするが、それでは全角で打った「YYYY． M． D」の形の暦日・生年月日が「YYYY。 M。 D」に分かれ、
// 暦日と生年月日の見分けから漏れる（半角の「YYYY. M. D」は見分けられる）。空白をはさんだ「．」は小数点にならないので、文の区切りか年月日の区切りのどちらか。
// 前後の空白（半角・全角・タブ）を飛ばした両隣が数字で、その「．」「，」が次の並びの中にあるときだけ、区切りにせず書いたまま（NFKC で「.」「,」）にし、
// 半角で書いたものと同じに見分ける（保存する文の読み取りでも同じ。数は変えない）：
// - 元号の年月日（SYY． M． D、昭和ＹＹ． Ｍ． Ｄ）。1字の英字の元号の年は元号の範囲の中のもの（S1〜S4 は年・生まれの語があるときだけ）
// - 元号の年月（ＲＹ． ＭＭ）。半角の見分けと同じく、T（体温）と、量の書き方の続くもの（H2． 5 mg）は除く
// - 4桁の年（18xx〜20xx）の年月日（YYYY． MM． DD）と、月日・日月の後の4桁の年（M． D． YYYY）
// - 2桁の年の年月日（YY． M． D、M． D． YY）は、生まれの語が続くか、年・生年月日の語の後のときだけ（Hb 12． 5． 3 は値の並びかもしれない）
// - 4桁の年と月だけ（YYYY． M）は、生まれの語が続くか、生年月日・DOB の見出しの後のときだけ（BNP 2000． 11/10、尿量 2000． 11 時 は値と文の区切り。
//   14回目のレビュー V5）
// - 月日だけ（M． D）は、生まれの語が続くか、生年月日・誕生日の見出しの後のときだけ
// 「，」で区切ったもの（YYYY， M， D、M， D， YYYY）は、生まれの語か生年月日・DOB の見出しのあるときだけ（暦日の見分けは「,」の区切りを生年月日でだけ読む）。
// 英語の月日の後の4桁の年の前の「，」（Mar D， YYYY）もそのまま。
// 並びの前後に、空白のない「．」「，」と数字（小数・数の区切り）が続くものは並びにしない（CRP 12.3． 11． 10）。
// 元号のない3つの数の並びで、空白のある区切りと空白のない区切りが混ざったもの（BNP 2000． 11．10 に再検）は、値の後の文の区切りと
// 暦日かもしれないものの並びとも読めるので、年・生まれの語、生年月日・DOB の見出しの後か、行頭のときだけ（生年月日：YYYY． M．D、行頭の
// YYYY． MM．DD）。ほかは今まで通り、空白のある「．」を文の区切りにし、空白のない「．」の後の暦日を暦日かもしれないものにする（値を［日付］にしない）
const HSPACE = /[ \t\u3000]/u;
const SPACED_SEP = String.raw`[ \t\u3000]*[.．﹒,，﹐][ \t\u3000]*`;
const RUN_ERA = String.raw`(?:(明治|大正|昭和|平成|令和|(?<!\p{sc=Han})[明大昭平令])|(?<![A-Za-zＡ-Ｚａ-ｚ0-9０-９])([MTSHRＭＴＳＨＲ]))[ \t\u3000]?`;
// 数のすぐ前の元号（空白1つをはさんでよい。並びの始まりの候補）と、並びの区切りの字
const ERA_BEFORE_NUMBER = /(?:明治|大正|昭和|平成|令和|[明大昭平令MTSHRＭＴＳＨＲ])[ \t\u3000]?$/u;
const RUN_SEP_CHAR = /[.．﹒,，﹐]/u;
const SPACED_RUN = new RegExp(
  String.raw`(?<![0-9０-９]|[0-9０-９][.．﹒,，﹐])(?:${RUN_ERA})?(${D}{1,4})${SPACED_SEP}(${D}{1,2})(?:${SPACED_SEP}(${D}{1,4}))?(?![0-9０-９]|[.．﹒,，﹐][0-9０-９])`,
  'uy',
);
// 生まれた日の見出し（年の語「年」「西暦」と、ドブタミンの略でもある DOB は含めない）と、DOB の見出し
const BIRTH_LABEL_BEFORE = /(?:生年月日|誕生日|出生日?|生ま?れ|birth\s*(?:day|date)?)\s*[)）】\]]?\s*[:：=]?\s*$/iu;
const DOB_LABEL_BEFORE = /(?<![A-Za-z])D\.?O\.?B\.?\s*[)）】\]]?\s*[:：=]?\s*$/iu;
const EN_MONTH_DAY_BEFORE = new RegExp(String.raw`(?<![a-z])${EN_MONTH}\.?\s?[0-9]{1,2}(?:st|nd|rd|th)?\s*$`, 'iu');
// 並びの2つの区切りの一方にだけ空白があるか
function mixedSpacing(run: string): boolean {
  const spaced: boolean[] = [];
  for (let i = 0; i < run.length; i += 1) {
    if (RUN_SEP_CHAR.test(run.charAt(i))) spaced.push(HSPACE.test(run.charAt(i - 1)) || HSPACE.test(run.charAt(i + 1)));
  }
  return spaced.length === 2 && spaced[0] !== spaced[1];
}
function spacedRunIsDate(text: string, start: number, m: RegExpExecArray): boolean {
  const [a, b, c] = [m[3], m[4], m[5]].map((x) => (x === undefined ? undefined : x.normalize('NFKC')));
  if (a === undefined || b === undefined) return false;
  const month = (s: string) => s.length <= 2 && Number(s) >= 1 && Number(s) <= 12;
  const day = (s: string) => s.length <= 2 && Number(s) >= 1 && Number(s) <= 31;
  const year4 = (s: string) => /^(?:18|19|20)\d{2}$/u.test(s);
  const era = m[1] !== undefined || m[2] !== undefined;
  // 数の形だけで年月日にならないものは、前後の語を見ない（区切りの多い長い文でも手間を小さくする）
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
// at の「．」「，」が、空白をはさんだ年月日の並びの中の区切りか。runs は1回の畳みの中で見た並びの始まり → 年月日の並びの終わり（ないなら -1）
// （隣の「．」「，」で同じ始まりを読み直さない。区切りの多い長い文でも手間を文の長さに比べて一定にする）
function inSpacedDate(text: string, at: number, runs: Map<number, number>): boolean {
  let [b, a] = [at - 1, at + 1];
  while (b >= 0 && HSPACE.test(text.charAt(b))) b -= 1;
  while (a < text.length && HSPACE.test(text.charAt(a))) a += 1;
  if (!PUNCT_DIGIT.test(text.charAt(b)) || !PUNCT_DIGIT.test(text.charAt(a))) return false;
  const c = text.charAt(at);
  if ((c === '，' || c === '﹐') && EN_MONTH_DAY_BEFORE.test(text.slice(Math.max(0, b - 16), b + 1).normalize('NFKC'))) {
    return /^(?:19|20)[0-9]{2}(?![0-9])/u.test(text.slice(a, a + 5).normalize('NFKC'));
  }
  // 並びの始まりの候補：at のすぐ前の数と、その前の区切りの前の数（at が2つめの区切りのとき）の始まりと、その前の元号の始まり
  const starts: number[] = [];
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
// 単位で終わる文（PSL 30mg．11/10 に）も同じ。単位は閉じた一覧だけ（No．、Ver．、ＤＯＢ．の後の数は番号や見出しの続きなので変えない）
const UNIT_BEFORE_PUNCT = /(?<![A-Za-z])(?:mg|g|mL|ml|L|dL|kg|mEq|mmol|mcg|cm|mm|mmHg|bpm|U|IU)$/u;
// mode：'stored' は保存する文の読み取り（文章から記録・ラフ記法・今日のメモ）、'detect' は暦日の見分け（AI に送る文面・匿名化リンタ・phi-guard）。
// 数字にはさまれた「．」（値の小数点かもしれないもの）は、保存する文の読み取りではいつも書いたとおりに残す
// （保存する文の数を変えない。CRP 12.3．11/10 に、INR 2．5-3 に）。数字にはさまれた「，」は小数点にならないので、どちらも暦日の見分けと同じ
// （Hb 7.2，11.10 に は区切り、１，０００ はそのまま）。暦日の見分けでは、すぐ後が暦日の形なら区切りにし、
// そこで見つけた暦日は暦日かもしれないもの（AI に送る文面では伏せ、保存する文は書いたまま残して、その行を知らせる。detectOnlyStops、
// calendar-dates.ts の heldDateAfterStop）。ただし生まれの語が続く生年月日らしいもの（BMI 22．3.4.YYYY 生まれ）は、保存する文でも区切りにする
// （生年月日をいつも「［日付］」にするため。14回目のレビュー V7）【案】
export type FoldMode = 'stored' | 'detect';
export function foldSentencePunct(text: string, mode: FoldMode = 'stored'): string {
  if (!/[．﹒，﹐]/u.test(text)) return text;
  const runs = new Map<number, number>();
  return text.replace(SENTENCE_PUNCT, (c: string, at: number) => {
    const [before, after] = [text.charAt(at - 1), text.charAt(at + 1)];
    const digits = PUNCT_DIGIT.test(before) && PUNCT_DIGIT.test(after);
    const stop = c === '，' || c === '﹐' ? '、' : '。';
    // 空白をはさんで数字の隣にある「．」「，」は、年月日の並びの中なら書いたまま（16回目のレビュー X4）
    if (!digits && (HSPACE.test(before) || HSPACE.test(after)) && inSpacedDate(text, at, runs)) return c;
    if (digits) {
      // 「，」は小数点にならないので、いつも暦日の見分けと同じ（数の区切り １，０００ は区切りにしない）
      const found = dateAfterPunct(text, at, true);
      return found === 'birth' || (found === 'date' && (mode === 'detect' || stop === '、')) ? stop : c;
    }
    const latinDigit = PUNCT_LATIN.test(before) && PUNCT_DIGIT.test(after);
    if (stop === '、') return latinDigit && EN_MONTH_BEFORE.test(text.slice(Math.max(0, at - 12), at).normalize('NFKC')) ? c : stop;
    if (latinDigit && UNIT_BEFORE_PUNCT.test(text.slice(Math.max(0, at - 6), at).normalize('NFKC')) && dateAfterPunct(text, at, false) !== 'none') return '。';
    const initial = PUNCT_LATIN.test(before) && !PUNCT_LATIN.test(text.charAt(at - 2));
    return (PUNCT_ALNUM.test(before) && PUNCT_ALNUM.test(after)) || initial ? c : '。';
  });
}

// 暦日の見分けでだけ文の区切りにした「．」の位置（数字にはさまれ、mode 'detect' で「。」にし、'stored' ではそのままのもの）。
// そのすぐ後の暦日は、暦日かもしれないものにする（calendar-dates.ts。13回目のレビュー T5、14回目のレビュー V7）
export function detectOnlyStops(text: string): Set<number> {
  const out = new Set<number>();
  if (!/[．﹒]/u.test(text)) return out;
  const [d, s] = [foldSentencePunct(text, 'detect'), foldSentencePunct(text)];
  for (let i = 0; i < text.length; i += 1) if (d[i] === '。' && s[i] !== '。') out.add(i);
  return out;
}

// 正規化後の範囲 [start, end) を、元の文字列の範囲に戻す
export function originalRange(t: NormalizedText, start: number, end: number, originalLength: number): { start: number; end: number } {
  const s = t.from[start] ?? originalLength;
  const e = end > start ? (t.to[end - 1] ?? originalLength) : s;
  return { start: s, end: e };
}

// 語を探すときの比べる形（T065）：NFKC、英字は小文字、空白は除く（「Ｐｎｅｕｍｏｎｉａ」「肺 炎」も同じ形）。
// ひらがなとカタカナ、「ー」と「-」、言い換え（心不全と CHF）はそろえない
export function matchKey(text: string): string {
  return normalizeWithMap(text).norm.toLowerCase().replace(/\s+/gu, '');
}

const ASCII_ONLY = /^[\x21-\x7e]+$/u;
const ASCII_WORD = /[a-z0-9]/u;

// 文に語があるか（T065。プロブレムの語でおすすめを出すときなど）。比べる形は matchKey。
// 英数字と記号だけの語（AF、DM、PE）は、文の中で前後が英字・数字でないときだけ（AF が AFP・Afib に、PE が PEG に当たらないように）。
// 英数字の語どうしの区切りを見るため、英数字だけの語は空白を1つの区切りとして残した形で比べる（aspiration pneumonia の pneumonia）。
// 否定や疑い（肺炎疑い、…除外）は見分けない（おすすめを出すだけで、決めない）
export function hasKeyword(text: string, keyword: string): boolean {
  const k = matchKey(keyword);
  if (k === '') return false;
  if (!ASCII_ONLY.test(k)) return matchKey(text).includes(k);
  const word = normalizeWithMap(keyword).norm.toLowerCase().trim().replace(/\s+/gu, ' ');
  const t = normalizeWithMap(text).norm.toLowerCase().replace(/\s+/gu, ' ');
  for (let i = t.indexOf(word); i >= 0; i = t.indexOf(word, i + 1)) {
    const before = i === 0 ? '' : t.charAt(i - 1);
    const after = t.charAt(i + word.length);
    if (!ASCII_WORD.test(before) && !ASCII_WORD.test(after)) return true;
  }
  return false;
}

// 名前を比べる形（検査名・別名・定義の語）：前後の空白を除き、NFKC にして、英字は小文字（大文字・小文字の違いは同じとみなす）
export const nameKey = (s: string): string => normalizeWithMap(s.trim()).norm.toLowerCase();

// 7桁を超える数字の並び（識別子の貼り付けを止める。phi-guard の8桁と合わせる）。NFKC にそろえた文に当てる
export const LONG_DIGIT_RUN = /\d{8,}/u;
