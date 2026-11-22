// clinical-playbook の packages/core/src/text/normalize.ts の matchKey・hasKeyword から写した（2026-11-22）。carte に合わせて変えたところ：
// 1字ずつの NFKC（normalizeWithMap）の代わりに、文全体の NFKC を使う（位置の対応は要らないので。半角の濁点も、文全体の NFKC で前の字と合わさる）。
//
// 語を探すときの比べる形：NFKC、英字は小文字、空白は除く（「Ｓｅｐｓｉｓ」「敗 血症」も同じ形）。
// ひらがなとカタカナ、「ー」と「-」、言い換え（心不全と CHF）はそろえない。

export function matchKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

const ASCII_ONLY = /^[\x21-\x7e]+$/u;
const ASCII_WORD = /[a-z0-9]/u;

// 文に語があるか（プロブレムの語でおすすめを出すときなど）。比べる形は matchKey。
// 英数字と記号だけの語（AF、DM、PE）は、文の中で前後が英字・数字でないときだけ（AF が AFP・Afib に、PE が PEG に当たらないように）。
// 英数字の語どうしの区切りを見るため、英数字だけの語は空白を1つの区切りとして残した形で比べる（aspiration pneumonia の pneumonia）。
// 否定や疑い（肺炎疑い、…除外）は見分けない（おすすめを出すだけで、決めない）
export function hasKeyword(text: string, keyword: string): boolean {
  const k = matchKey(keyword);
  if (k === '') return false;
  if (!ASCII_ONLY.test(k)) return matchKey(text).includes(k);
  const word = keyword.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
  const t = text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');
  for (let i = t.indexOf(word); i >= 0; i = t.indexOf(word, i + 1)) {
    const before = i === 0 ? '' : t.charAt(i - 1);
    const after = t.charAt(i + word.length);
    if (!ASCII_WORD.test(before) && !ASCII_WORD.test(after)) return true;
  }
  return false;
}
