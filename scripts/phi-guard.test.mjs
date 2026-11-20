// phi-guard のテスト。実行：node --test 'scripts/*.test.mjs'
//
// 陽性サンプルは実行時に組み立てる。ソースに直接書くと、このファイル自体がフックに止められるため。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkPath, decodeText, foldSentencePunct, MAX_BYTES, scanFile, scanMessage, scanText } from './phi-guard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'phi-guard.mjs');

const AT = String.fromCharCode(64);
const ALLOW = ['phi-guard', 'allow'].join(': ');

const sample = {
  phone: () => ['03', '1234', '5678'].join('-'),
  phoneCompact: () => ['090', '1234', '5678'].join(''),
  phoneWide: () => ['03', '1234', '5678'].join('－').replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d))),
  email: () => ['someone', 'example.org'].join(AT),
  postal: () => '〒' + ['100', '0001'].join('-'),
  digits12: () => '1234'.repeat(3),
  dob: () => ['1950', '05', '12'].join('-'),
  dobEra: () => ['昭和', '25年', '5月', '12日'].join(''),
  dobKeyword: () => ['生年', '月日：', '2015', '/1/2'].join(''),
  idLike: () => '1234' + '5678',
  honorific: () => ['山田', 'さ', 'ん'].join(''),
  address: () => ['東京', '都', '千代田', '区'].join(''),
};

function rules(text) {
  return scanText(text).map((f) => `${f.level}:${f.rule}`);
}

test('エラーになる文字列', () => {
  assert.deepEqual(rules(`連絡先 ${sample.phone()}`), ['error:phone']);
  assert.deepEqual(rules(`連絡先 ${sample.phoneCompact()}`), ['error:phone']);
  assert.deepEqual(rules(`連絡先 ${sample.phoneWide()}`), ['error:phone']);
  assert.deepEqual(rules(`宛先 ${sample.email()}`), ['error:email']);
  assert.deepEqual(rules(sample.postal()), ['error:postal-code']);
  assert.deepEqual(rules(`番号 ${sample.digits12()}`), ['error:digits-12']);
  assert.deepEqual(rules(sample.dob()), ['error:birth-date']);
  assert.deepEqual(rules(sample.dobEra()), ['error:birth-date']);
  assert.deepEqual(rules(sample.dobKeyword()), ['error:birth-date']);
});

test('生年月日の書き方の違い（1字の元号、「.」の英字の元号、2桁の年のすぐ後の「生」、誕生日の語のすぐ後の月日）もエラー', () => {
  const forms = [
    ['昭28', '3', '4'].join('.') + '生',
    ['S.28', '3', '4'].join('.') + '生',
    ['53', '3', '4'].join('.') + '生',
    ['誕生', '日は', '3/4'].join(''),
    // DOB の後は、年が dobMaxYear 以下のもの（より後の年はドブタミンの日。10回目のレビュー Q9）
    ['D', 'OB: ', '1953', '/1/2'].join(''),
    ['D', 'OB ', '1953', '/1/2'].join(''),
    ['3/4', '生ま', 'れ'].join(''),
    ['生ま', 'れは ', '2015', '/1/2'].join(''),
    ['B', 'day ', '3/4'].join(''),
    ['出生', '日 ', '3/4'].join(''),
    ['D', 'OB ', 'Mar 4', ', ', '1953'].join(''),
    // 見出しのすぐ後と「生まれ」のすぐ前の並びは、形によらず（5回目のレビュー G10、G15、G16）
    ['生年', '月日 ', '48', '0405'].join(''),
    ['S23', '0405', '生'].join(''),
    ['生年', '月日 ', '1948', ' 4 5'].join(''),
    ['生年', '月日 ', 'Apr-5', '-1948'].join(''),
    ['生年', '月日: ', '05APR', '1948'].join(''),
    ['生年', '月日 ', '昭和二十三', '年四月五日'].join(''),
    ['四月', '五日', '生ま', 'れ'].join(''),
    ['生年', '月日 ', '11', '.8'].join(''),
    ['誕生', '日は', '11月', '8'].join(''),
    ['11', '.8', '生ま', 'れ'].join(''),
    ['D', 'OB: ', '3/4', '/53'].join(''),
    ['生年', '月日：', '4.3', '.1953.'].join(''),
    ['生年', '月日 ', '53.3', '.4.'].join(''),
    // ダッシュの変種の区切り、英語の月の「/」「-」と年が先の形、「DOB:」の後のはっきり年の2桁、小文字の月でも日と4桁の年が続くもの（6回目のレビュー H9、H10、H12）
    ['生年', '月日：', '1950', 'ー3ー4'].join(''),
    ['1950', 'ｰ3ｰ4', '生ま', 'れ'].join(''),
    ['生年', '月日 ', '1950', '−3−4'].join(''),
    ['D', 'OB ', '1950', '–3–4'].join(''),
    ['Birth', 'day: Mar', '—4—', '1950'].join(''),
    ['生年', '月日 ', 'S25', 'ー3ー4'].join(''),
    ['生年', '月日 ', '1948', '-Nov-08'].join(''),
    ['Birth', 'day: Nov', '/8/', '1948'].join(''),
    ['D', 'OB Nov', '-08-', '1948'].join(''),
    ['D', 'OB: ', '3/4', '/05'].join(''),
    ['D', 'OB dec 5', ' 1953'].join(''),
  ];
  for (const t of forms) assert.deepEqual(rules(`架空 ${t}`), ['error:birth-date'], t);
  // 出身地の「生まれ」の行の月日、生検・生食、漢字に続く1字（最大）は誤検知しない
  for (const line of [['東京生ま', 'れ、11/8 入院'].join(''), '11/8 生検施行、11/10 生食', '最大12.5.3', ['誕生', '日カードを書いた。痛み 3/10'].join('')]) assert.deepEqual(rules(line), [], line);
});

test('ドブタミン（DOB）の量、生まれつき・出身地の「生まれ」の行、薬の名前の後の R・錠数の後の T は、生年月日にしない（4回目のレビュー F11、F13、F14）', () => {
  const clean = [
    '11/10 心原性ショック、DOB 3γ開始。Cr 1.8 K 5.2',
    'DOA/DOB 3/3γ で開始',
    'DOB 3/5',
    'NAD/DOB 0.1/3γ',
    'DOB 3γ開始後、Cr 1.2-1.5 で推移',
    'EF 25%、DOB 3γ、sBP 80-90-100',
    '11月8日 DOB 3γ 開始',
    ['東京', '生まれ。11月8日入院'].join(''),
    ['北海道', '生まれ、11月8日から発熱'].join(''),
    ['生まれ', 'つき腎低形成、Cr 1.2-1.5 で推移'].join(''),
    ['生まれ', '育ちは東北。インスリン 10-8-8'].join(''),
    'ヒューマリンR 4-4-4 で血糖管理',
    '酸化マグネシウム 330mg 3T 1-1-1',
    'T4-5-6 の圧迫骨折',
    'S1-2-3',
    // 「DOBは」、量・off の後の暦日、「DOB:」の後の年のない月日（5回目のレビュー G14）
    'DOBは11/12まで',
    'DOBは漸減し11月10日に中止',
    '11月12日 DOBは漸減し中止',
    'DOB: 2-3γ、11月10日から',
    'DOB：off（11月12日）',
    'DOBは 1.5-3γ',
    'DOBは1/2に減量',
    'DOB: 3/4',
    'DOB: 11-8',
    // 見出しの後の日数・不明、年代の「生まれ」、出生時の体重、半角カナの濁点に続く1字の英字（5回目のレビュー）
    '誕生日 2日後に発熱',
    '生年月日 不明',
    '1950年代生まれ',
    'born 2.8kg',
    'ﾉﾎﾞﾗﾋﾟｯﾄﾞH 4/4/4',
    'ﾄﾞT 1.2.3',
    // DOB（ドブタミン）の量の並び：減量・増量・中止・off の語が続くもの、「:」のない DOB の後の年のない3つの数、
    // 「DOB:」の後の 31 以下の2桁だけの3つの数、小文字の英語の月の略（6回目のレビュー H10）
    'DOB 10-5-3と漸減',
    'DOB 15-10-5 で漸減し離脱',
    'DOB 10/5/3 と減量',
    'DOB: 10, 5, 3 と漸減',
    'DOB 10 5 3',
    'DOB 3-5-10',
    'DOB 10-5-3→off',
    'DOA 3 DOB 12/10/8 開始',
    'DOB: 12-10-8',
    'DOB dec 5→3',
    'DOB dec 3',
    'DOB: dec 5 → 3',
    'DOBをsep',
    // カタカナの語の長音と、かな入力の「ー」の量の並び（H9）
    'ヘモグロビン、ワーファリン、インスリン 10ー8ー8、CRP 15 ー> 3',
  ];
  for (const line of clean) assert.deepEqual(rules(line), [], line);
  assert.deepEqual(rules(['生ま', 'れは', '3月', '4日'].join('')), ['error:birth-date']);
  assert.deepEqual(rules(['S.28', '3', '4'].join('.') + ' 手術'), ['error:birth-date']);
});

test('長い行（空白・数字・中黒の並び）でも、行の長さにほぼ比例した手間で終わる（4回目のレビュー F12）', () => {
  const n = 20000;
  const fill = (piece, len = n) => piece.repeat(Math.ceil(len / piece.length)).slice(0, len);
  const lines = [
    'Cr' + ' '.repeat(n) + '1/2',
    'x' + '　'.repeat(n) + 'x',
    '1'.repeat(n),
    'a'.repeat(n),
    '・'.repeat(n),
    '11/8 '.repeat(n / 5),
    'DOB' + ' '.repeat(n) + 'x' + ' '.repeat(n) + '3/4',
    // 5回目のレビュー：重なりの見分け（ヒットの多い行）と、生年月日の並び
    fill(['1', '丁目'].join(''), 4 * n),
    fill('1 '),
    fill(['3/4', '生 '].join('')),
    fill(['生年', '月日 ', '3/4 '].join('')),
    fill('DOB: 3-4 '),
    '1' + ' '.repeat(n) + '生',
    // 6回目のレビュー：ダッシュの変種、量の並び、英語の月の「/」、半角カナの濁点
    fill('1ー'),
    fill('aー1 '),
    fill('DOB 10-5-3と漸減 '),
    fill('Nov/8/'),
    fill('ﾀﾞ'),
    '1' + ' '.repeat(n) + 'ー' + ' '.repeat(n) + '1',
  ];
  for (const line of lines) {
    const start = performance.now();
    scanText(line);
    assert.ok(performance.now() - start < 1500, line.slice(0, 10));
  }
});

test('警告になる文字列', () => {
  assert.deepEqual(rules(`ID ${sample.idLike()}`), ['warn:digits-8-11']);
  assert.deepEqual(rules(`${sample.honorific()}は`), ['warn:honorific-name']);
  assert.deepEqual(rules(`${sample.address()}在住`), ['warn:address']);
  // 半角カナの濁点・半濁点のある名前（架空。実行時に組み立てる）。core の匿名化リンタも同じ判定（6回目のレビュー H13）
  const k = (...cs) => String.fromCharCode(...cs);
  for (const name of [k(0xff94, 0xff8f, 0xff80, 0xff9e) + 'さん', k(0xff7d, 0xff7d, 0xff9e, 0xff77) + '様', k(0xff8c, 0xff7c, 0xff9e, 0xff80) + '先生']) {
    assert.deepEqual(rules(`${name}が来院`), ['warn:honorific-name'], name);
  }
});

test('ダッシュの変種（かな入力の長音「ー」、マイナス、ダッシュ）の生年月日と12桁の数字もエラー（6回目のレビュー H9）', () => {
  for (const d of ['ー', 'ｰ', '−', '‐', '‑', '‒', '–', '—', '―', '－', '﹣']) {
    assert.deepEqual(rules(['生年', '月日：', '1950', d, '3', d, '4'].join('')), ['error:birth-date'], d);
    assert.deepEqual(rules(['1950', d, '3', d, '4', '生ま', 'れ'].join('')), ['error:birth-date'], d);
    assert.deepEqual(rules(['1234', '5678', '9012'].join(d)), ['error:digits-12'], d);
  }
});

test('かっこで囲んだ見出し、かっこ書き・区切りと添えた語のある見出しの後の並びもエラー（7回目のレビュー K8。core と同じ）', () => {
  const forms = [
    ['【生年', '月日】', '53', '0304'].join(''),
    ['【生年', '月日】', 'S28', '0304'].join(''),
    ['【生年', '月日】', 'H1', '0304'].join(''),
    ['【生年', '月日】 ', '1953', ' 3 4'].join(''),
    ['【誕生', '日】', '3', '.4'].join(''),
    ['【誕生', '日】', '3', '-4'].join(''),
    ['[生年', '月日] ', '53', '0304'].join(''),
    ['（生年', '月日）', '53', '0304'].join(''),
    ['〈生年', '月日〉', '53', '0304'].join(''),
    ['生年', '月日（年齢）：', 'S28', '0304', '（72歳）'].join(''),
    ['生年', '月日／年齢：', '53', '0304', '／72'].join(''),
    ['生年', '月日・年齢：', '53', '0304'].join(''),
    ['生年', '月日、', '53', '0304'].join(''),
    ['【生年', '月日】', '昭和二十八', '年三月四日'].join(''),
    ['【D', 'OB】', '53', '0304'].join(''),
    ['生年', '月日 ', 'H1', '0304'].join(''),
  ];
  for (const t of forms) assert.deepEqual(rules(`架空 ${t}`), ['error:birth-date'], t);
  // 1行に1つずつ書く（生年月日の語のある行は、その行の日付らしい並びをすべて疑うので）
  const clean = [
    '（誕生日）3日後に退院',
    '（誕生日）2回目の入院',
    '【生年月日】不明',
    '生年月日・年齢は不詳',
    '生年月日、住所は記載しない',
    '【DOB】10-5-3と漸減',
    '(DOB) 3γ',
  ];
  for (const line of clean) assert.deepEqual(rules(line), [], line);
});

test('区切りの記号（|、-、→、;、…、::）・英語の is・年齢の語を添えた DOB の後の並びもエラー（8回目のレビュー M7。core と同じ）', () => {
  const forms = [
    ['| 生年', '月日 | ', '53', '0304', ' |'].join(''),
    ['| 生年', '月日 | ', 'S28', '0304', ' |'].join(''),
    ['| 生年', '月日 | ', '3', '.4', ' |'].join(''),
    ['生年', '月日 - ', '1953', ' 3 4'].join(''),
    ['生年', '月日 → ', 'S28', '0304'].join(''),
    ['生年', '月日；', '53', '0304'].join(''),
    ['生年', '月日…', '53', '0304'].join(''),
    ['生年', '月日 :: ', '3', '.4'].join(''),
    ['生年', '月日：：', '3', '-4'].join(''),
    ['生年', '月日<', '53', '0304'].join(''),
    ['生年', '月日：（和暦）', 'S28', '0304'].join(''),
    ['date of ', 'birth is ', '1953', ' 3 4'].join(''),
    ['D', 'OB/Age: ', '53', '0304', ' (72)'].join(''),
    ['D', 'OB/Age: ', 'S28', '-3-4', ' (72)'].join(''),
    ['D', 'OB (age): ', '1953', ' 3 4'].join(''),
    ['D', 'OB／年齢：', 'S28', '0304', '／72'].join(''),
    ['D', 'OB, age: ', '53', '0304'].join(''),
    ['D', 'OB/Age: ', '3月', '4日'].join(''),
    ['| D', 'OB | ', '53', '0304', ' |'].join(''),
  ];
  for (const t of forms) assert.deepEqual(rules(`架空 ${t}`), ['error:birth-date'], t);
  const clean = [
    '誕生日 → 3日後に退院',
    '生年月日 - 不明',
    '| 生年月日 | 不明 |',
    '生年月日 :: 記載なし',
    'DOB/DOA 5/3γ',
    'DOB → 5γ に増量',
    'DOB | 3γ で継続',
    'DOB, 3γ',
    // 引用符・波かっこ・「$」は区切りにしない（テンプレート文字列の中の変数の名前）
    ['${', 'BIRTH', 'DAY} 3/4'].join(''),
  ];
  for (const line of clean) assert.deepEqual(rules(line), [], line);
});

test('丸数字などの番号のすぐ後の生年月日・電話番号もエラー（9回目のレビュー P5。core と同じ）', () => {
  const markers = ['①', '⑫', '⒈', '⑴', '㊶', '⓪', String.fromCodePoint(0x1f101)];
  for (const m of markers) {
    for (const old of [['1990', '/4/1'].join(''), ['S28', '.3.4'].join(''), ['1953', '0304'].join('')]) {
      const t = `既往：${m}${old} 胃癌手術`;
      assert.deepEqual(rules(t), ['error:birth-date'], t);
      // 見つけた位置（列）は、番号の後ろの年月日の始まり
      assert.equal(scanText(t)[0]?.col, `既往：${m}`.length + 1, t);
    }
    const phone = `${m}${['090', '1234', '5678'].join('-')}`;
    assert.deepEqual(rules(phone), ['error:phone'], phone);
  }
  // 数字の続く上付きの数字の後も
  assert.deepEqual(rules(`x²${['1990', '/4/1'].join('')}`), ['error:birth-date']);
  // 番号の後のふつうの値と、ふつうの上付き・下付きの数字は止めない
  for (const line of ['①1/2錠 内服', '⑴NYHA 2/4', '①Cr 1.11', '⒈10-20 mg', '①考察', 'SpO₂ 98%', 'x10³/μL']) assert.deepEqual(rules(line), [], line);
});

test('見出しの後と「生まれ」の前の中黒「・」の区切りの生年月日もエラー。DOB の後の今の年の暦日はエラーにしない（10回目のレビュー Q8、Q9。core と同じ）', () => {
  const J = (...p) => p.join('');
  const DOB = J('生年', '月日');
  const DOBW = J('D', 'OB');
  const OLD = J('19', '48');
  const NOW = String(new Date().getFullYear());
  for (const t of [
    J(DOB, '：', OLD, '・3・14'),
    J(DOB, '：S23・3・14'),
    J(DOB, '：昭和23・3・14'),
    J(DOBW, ': ', OLD, '・3・14'),
    J(OLD, '・3・14', '生'),
    J('S23・3・14', '生ま', 'れ'),
    J(DOB, ' ', OLD, '･3･14'),
    J('誕生', '日：3・14'),
    J('【', DOB, '】', OLD, '・03・14'),
    J('Birth', 'day: ', OLD, '・3・14'),
  ]) {
    assert.deepEqual(rules(t), ['error:birth-date'], t);
  }
  // 文の中の「・」と、見出しと年齢の語の行は止めない
  for (const t of ['Na・K 140・4.0', '11月10・12日 発熱', J(DOB, '・年齢：'), '血培 2・2 陽性']) assert.deepEqual(rules(t), [], t);
  // DOB（ドブタミン）の後の今の年の暦日（開始・終了の日）は生年月日にしない。昔の年、年が2桁、見出しの語（生年月日・DOB/Age）の後は今まで通り
  for (const t of [J(DOBW, ' ', NOW, '/11/10〜11/15 3γ'), J(DOBW, ' R', String(Number(NOW) - 2018), '.11.10〜 3γ'), J(DOBW, ': ', NOW, '.11.10 開始'), J('・', DOBW, '（', NOW, '/11/10〜', NOW, '/11/15）')])
    assert.deepEqual(rules(t).filter((r) => r.startsWith('error')), [], t);
  for (const t of [J(DOBW, ' ', '1953', '/3/4'), J(DOBW, ': 3/4', '/05'), J(DOB, ' ', NOW, '/11/10'), J(DOBW, '/Age: ', NOW, '/11/10')]) assert.deepEqual(rules(t), ['error:birth-date'], t);
});

test('「，．」の書き方・「…」・語に続けた「.」の後の生年月日と、「出生」「誕生」「生誕」の前後の月日もエラー（11回目のレビュー R6、N1。core と同じ）', () => {
  const J = (...p) => p.join('');
  const DOB = J('生年', '月日');
  const DOBW = J('D', 'OB');
  const BORN = J('生ま', 'れ');
  const SHUSSEI = J('出', '生');
  const OLD = J('19', '48');
  for (const sep of ['．', '，', '…', '‥', '.', 'HT.']) {
    for (const span of [J('3.4.', OLD), J('53', '.3.4'), J('53', '/3/4'), J('3/4/', OLD), J('4 Mar ', OLD), '3.4', J('53', '0304')]) {
      const t = J('既往なし', sep, span, ' ', BORN);
      assert.deepEqual(rules(t), ['error:birth-date'], t);
    }
  }
  for (const t of [
    J(DOB, '．', '53', '.3.4'),
    J(DOB, '．3/4/', OLD),
    J('誕生', '日．3.4'),
    J(DOBW, '．3/4/', OLD),
    J('Birth', 'day.4 Mar ', OLD),
    J('3月4日', SHUSSEI),
    J('3/4 ', SHUSSEI),
    J(SHUSSEI, ' 3/4'),
    J(SHUSSEI, '：3/4'),
    J(SHUSSEI, 'は3/4'),
    J('誕', '生 3/4'),
    J('生', '誕 3/4'),
  ]) {
    assert.deepEqual(rules(t), ['error:birth-date'], t);
  }
  // 数字のすぐ後の「.」、番号の略語の後、文の中の見出しの語の後の「。」、出生時・出生歴、全角の小数・数の区切りは止めない
  for (const t of ['1.25/11/10', 'Hb 12.3.4', J('No.3/4/', OLD), 'Ver.1.2', J('本日', '誕生', '日。11/8 入院'), '出生時体重 3000g', '出生歴に異常なし', 'Hb １２．３', '尿量 １，２００ mL', '発熱あり．11/10 に入院']) {
    assert.deepEqual(rules(t).filter((r) => r.startsWith('error')), [], t);
  }
});

test('数で終わる文の「．」「，」のすぐ後の生年月日もエラー（12回目のレビュー S5。core と同じ）', () => {
  const J = (...p) => p.join('');
  const BORN = J('生ま', 'れ');
  const OLD = J('19', '53');
  for (const lead of ['BMI 22．', 'Hb 7.2．', 'eGFR 25．', 'IPAP 8．', 'BMI 20.8．', 'Hb 7.2，']) {
    for (const span of [J('3.4.', OLD), J('53', '.3.4'), J('53', '/3/4'), J('3/4/', OLD), J('4 Mar ', OLD), '3.4', J('03', '04'), J('53', '0304')]) {
      const t = J('72歳男性．', lead, span, ' ', BORN, '．');
      assert.deepEqual(rules(t), ['error:birth-date'], t);
    }
  }
  // 年月日の区切り、全角の小数、単位・数の続く分数、数の区切りは止めない
  for (const t of ['２０２５．１１．８ 入院', 'Hb １２．３', '尿量 １．５/２４h', 'Cr １．２/１．０', '尿量 １，２００ mL', 'CRP 12.3．11/10 に改善']) {
    assert.deepEqual(rules(t).filter((r) => r.startsWith('error')), [], t);
  }
});

test('数の小数点・評価尺度・病期・体温・心音・値の後の「．」は生年月日にしない。元号の年・誕生の語の後は今まで通りエラー（13回目のレビュー T5、T6。core と同じ）', () => {
  const J = (...p) => p.join('');
  const BORN = J('生ま', 'れ');
  const DOB = J('生年', '月日');
  for (const t of [
    'T 38．11/10 に解熱．',
    'HR 100 T 38．11/12 に CT．',
    '心音 S3．11/10 に消失．',
    'BNP 1980．11/12 に再検．',
    '尿量 2000．11/10 に利尿薬中止．',
    'GCS E4V5M6．11/10 に退院．',
    'cT2N1M0．11/10 に手術．',
    'P 80 R 20．11/10 に酸素終了．',
    'ラシックス ０．５－１錠 頓用',
    'PSL ０．５－１ ｍｇ/ｋｇ',
    'Cr 1．2/1 に',
  ]) {
    assert.deepEqual(rules(t).filter((r) => r.startsWith('error')), [], t);
  }
  for (const t of [J('S', '3．11/10 ', BORN), J(DOB, '：S', '3．11/10'), J(DOB, '：', '1953', '．4/5'), J('1953', '．4/5 ', BORN), J(DOB, '：3月の', '4日')]) {
    assert.deepEqual(rules(t), ['error:birth-date'], t);
  }
});

test('生食・生検・生活・出生体重の前の数は生年月日にしない。日・月が先で年が後の生年月日の「．」「，」はエラー（14回目のレビュー V5、V6。core と同じ）', () => {
  const J = (...p) => p.join('');
  const BORN = J('生ま', 'れ');
  const OLD = J('19', '53');
  for (const t of [
    '尿量 2000．11/12 生食 500mL 負荷',
    '尿量 2000．11/12 生理食塩水負荷',
    'BNP 1980．11/12 生検予定',
    'NT-proBNP 2010．11/12 生検',
    '尿量 2000．11/12 に出生体重',
    '尿量 2000．11/12 生活指導',
    '心音 S3．11/10 生食負荷後に消失',
    'PT-INR 2．5-3 にコントロール',
    'HR 88．11/10 日中より傾眠',
  ]) {
    assert.deepEqual(rules(t).filter((r) => r.startsWith('error')), [], t);
  }
  for (const t of [
    J('4．5．', OLD, ' ', BORN),
    J('４．５．', J('１９', '５３'), ' ', BORN),
    J('11．3．', OLD, '生'),
    J('72歳男性．11．3．', OLD, ' 生．'),
    J('4，5，', OLD, ' ', BORN),
    J('4/5．', OLD, ' ', BORN),
    J('Mar 4，', OLD, ' ', BORN),
    J('4 Mar，', OLD, ' ', BORN),
    J(OLD, '．4/5 ', BORN),
  ]) {
    assert.deepEqual(rules(t), ['error:birth-date'], t);
  }
});

test('「生れ」「産れ」は生まれの語。誕生会・誕生日会・誕生祝い・生まれ故郷の前の暦日は生年月日でない（15回目のレビュー W11、W12。core と同じ）', () => {
  const J = (...p) => p.join('');
  const UMARE = J('生', 'れ');
  const BIRTHDAY = J('誕生', '日');
  for (const t of [J('4月5日', UMARE, '。'), J('4/5', UMARE, 'の男性'), J('4/5 ', J('産', 'れ')), J(UMARE, 'は 4/5'), J('4月5日 ', BIRTHDAY), J('11/10 ', BIRTHDAY)]) {
    assert.deepEqual(rules(t), ['error:birth-date'], t);
  }
  for (const t of [
    '11/10 誕生会で餅を摂取し窒息',
    '11/10に誕生祝いで外食',
    '11/10 生まれ故郷へ外泊',
    '11月10日 誕生日会で誤嚥',
    '11/10 誕生パーティ',
    '誕生会 11/10 に外出',
    '11/10 生の牡蠣を摂取',
    J(BIRTHDAY, ' 2日後に退院'),
  ]) {
    assert.deepEqual(rules(t).filter((r) => r.startsWith('error')), [], t);
  }
});

test('全角の「．」「，」と空白の生年月日はエラー。生まれつき・生まれ育ち・生まれながらの前の値・暦日はエラーにしない（16回目のレビュー X4、X6。core と同じ）', () => {
  const J = (...p) => p.join('');
  const DOBW = J('生年', '月日');
  const BORN = J('生ま', 'れ');
  const Y = J('19', '53');
  const WIDE = (s) => s.replace(/[0-9A-Z]/gu, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  for (const t of [
    J(DOBW, '：', Y, '． 4． 5'),
    J(DOBW, '：', WIDE(Y), '． ４． ５'),
    J(DOBW, '：S', '28', '． 4． 5'),
    J(DOBW, '：', WIDE('S28'), '． ４． ５'),
    J(DOBW, '　昭和', '28', '． 4． 5'),
    J('昭和', WIDE('28'), '． ４． ５', BORN),
    J(WIDE('S28'), '． ４． ５', '生'),
    J('DOB ', Y, '． 4． 5'),
    J('72歳男性。', Y, '． 4． 5 ', BORN),
    J(DOBW, '：', Y, '．　4．　5'),
    J(DOBW, '：', Y, ' ． 4 ． 5'),
    J(DOBW, '：', Y, '，　4，　5'),
    J(DOBW, '：S', '28', '．4． 5'),
    J('DOB ', 'Mar 4， ', Y),
    J('Mar 4， ', Y, ' ', BORN),
    J('４． ５ ', BORN),
  ]) {
    assert.deepEqual(rules(t), ['error:birth-date'], t);
  }
  for (const t of [
    'Cr 1.2 生まれつき片腎あり',
    'PSL 7.5 生まれつき',
    '11/10 生まれつきの難聴を指摘',
    '11/10 生まれ育った町へ外出',
    'Cr 1．2 生まれ育ちは東北',
    'BMI 22．5 生まれつき小柄',
    '11/10 生れつき',
    '11月10日 生まれながらの難聴',
    '11月10日 生まれて初めての発作',
    '11月10日 生まれ持った体質',
    '2025． 11． 10 CT施行',
    '体温 38． 5． 2 と推移',
    'BNP 2000． 11/10 に再検',
    '2025， 11， 10 入院',
    'DOB ４． ５',
    '11月10日 生まれ付いた体質',
    '11月10日 生まれてはじめての発作',
  ]) {
    assert.deepEqual(rules(t).filter((r) => r.startsWith('error')), [], t);
  }
  // 生年月日の年月・月日（生まれの語・見出しのあるもの）
  for (const t of [J(DOBW, '：', Y, '． 4'), J(Y, '． 4 ', BORN), J(DOBW, '：４． ５'), J(DOBW, '：', Y, '， 4， 5'), J('４， ５ ', BORN)]) {
    assert.deepEqual(rules(t), ['error:birth-date'], t);
  }
  // 年月日の並びでない「．」「，」は、core と同じに区切り
  for (const [t, folded] of [
    ['BNP 2000． 11/10 に再検', 'BNP 2000。 11/10 に再検'],
    ['T3． 5 と低値', 'T3。 5 と低値'],
    ['2025， 11， 10 入院', '2025、 11、 10 入院'],
    ['Nov 10， 12 に CT', 'Nov 10、 12 に CT'],
    ['CRP 12.3． 11． 10 に再検', 'CRP 12.3。 11。 10 に再検'],
  ]) {
    assert.equal(foldSentencePunct(t), folded, t);
  }
  for (const t of [J('4/5 ', BORN), J('4/5 ', BORN, 'の'), J('4/5 ', BORN, 'た'), J('4/5 ', BORN, 'で')]) {
    assert.deepEqual(rules(t), ['error:birth-date'], t);
  }
  // 空白のある区切りと空白のない区切りの混ざった並びは、見出し・生まれの語・元号のあるときだけ生年月日（値の後の文の区切りは除く。core と同じ）
  for (const t of [J(DOBW, '：', Y, '．4． 5'), J(Y, '． 4．5 ', BORN), J('DOB ', Y, '． 4．5'), J('S', '28', '．4． 5 に')]) {
    assert.deepEqual(rules(t), ['error:birth-date'], t);
  }
  for (const [t, folded] of [
    ['BNP 2000． 11．10 に再検', 'BNP 2000。 11．10 に再検'],
    ['BNP 1980． 11．12 に再検', 'BNP 1980。 11．12 に再検'],
    ['BNP 1980．11． 12 に', 'BNP 1980．11。 12 に'],
  ]) {
    assert.deepEqual(rules(t).filter((r) => r.startsWith('error')), [], t);
    assert.equal(foldSentencePunct(t), folded, t);
  }
});

test('年が最後の年月日・漢数字の年の年月日・見えない文字・「.」区切りの電話・+81 の 0 なし・12桁以上もエラー。小数・ULID・年の並びは誤検知しない（全体のレビュー、2026-10-16。core と同じ）', () => {
  const y = ['19', '50'].join('');
  for (const t of [['12', '05', y].join('/'), ['5', '12', y].join('.'), ['12', '5', y].join('-')]) assert.deepEqual(rules(`記載 ${t} 入院`), ['error:birth-date'], t);
  assert.deepEqual(rules(['昭和', '二十五年', '五月', '十二日'].join('')), ['error:birth-date']);
  assert.deepEqual(rules(['一九五〇年', '五月', '十二日'].join('')), ['error:birth-date']);
  // 今年の年が最後の暦日は、生年月日にしない（phi-guard は暦日を見ない）。数の並びの途中も見ない
  const thisYear = String(new Date().getFullYear());
  assert.deepEqual(rules(['11', '4', thisYear].join('/')), []);
  assert.deepEqual(rules(['1', '2', '12', '05', y].join('/')), []);
  for (const z of ['\u200B', '\u00AD', '\u2060', '\uFEFF', '\u200D']) {
    assert.deepEqual(rules(`TEL ${['090', '1234', '5678'].join(z)}`), ['error:phone'], JSON.stringify(z));
    assert.deepEqual(rules(`番号 ${['1234', '5678', '9012'].join(z)}`), ['error:digits-12'], JSON.stringify(z));
  }
  assert.deepEqual(rules(`TEL ${['03', '1234', '5678'].join('.')}`), ['error:phone']);
  assert.deepEqual(rules(`TEL +81${['3', '1234', '5678'].join('')}`), ['error:phone']);
  assert.deepEqual(rules(`TEL +81 0${['3', '1234', '5678'].join('')}`), ['error:phone']);
  assert.deepEqual(rules(`ID ${'1234'.repeat(3)}.`), ['error:digits-12']);
  assert.deepEqual(rules(`No.${'1234'.repeat(3)}`), ['error:digits-12']);
  assert.deepEqual(rules(`番号 ${'1234'.repeat(4)}`), ['error:digits-12']);
  assert.deepEqual(rules(`値 0.${'1234'.repeat(3)}`), []);
  assert.deepEqual(rules(`値 ${'1234'.repeat(3)}.5`), []);
  assert.deepEqual(rules(`id 01J${'0'.repeat(20)}700`), []);
  assert.deepEqual(rules(['2019', '2020', '2021'].join(' ') + ' の推移'), []);
});

test('誤検知しない文字列', () => {
  const clean = [
    '確認日 2026-09-26、2026/04/23版、令和6年11月9日',
    'Cr 2.9@1→1.4@4 mg/dL、K 6.4@1 mEq/L、FENa 0.3@1 %、尿比重 1.028@1',
    'Cr 0.9@~-180→2.9@1 mg/dL',
    '反復回数 600,000、上限 1,048,576 バイト',
    '"packageManager": "pnpm' + AT + '9.12.0"',
    'icon' + AT + '2x.png',
    '患者さんとご家族様、同様に、仕様、様式、氏名、多様な',
    '入院日を第1病日とし、それより前は「入院3日前」と書く',
    '#F5F8F9 #D3DDE2 #1D2B3A',
  ];
  for (const line of clean) assert.deepEqual(rules(line), [], line);
});

test('allow は理由があるときだけ効く', () => {
  assert.deepEqual(rules(`${sample.phone()} ${ALLOW} 架空の番号`), []);
  assert.deepEqual(rules(`${sample.phone()} ${ALLOW}`), ['error:phone', 'error:allow-without-reason']);
});

test('置いてはいけないパス', () => {
  const bad = ['data/a.json', 'apps/web/exports/x.md', '.env', '.env.local', 'x.cbk', 'y.casebook', 'z.sqlite', 'w.db'];
  for (const p of bad) assert.equal(checkPath(p).length, 1, p);
  for (const p of ['.env.example', 'docs/04-data-model.md', 'packages/core/src/database.ts']) {
    assert.equal(checkPath(p).length, 0, p);
  }
});

test('リポジトリの全ファイルでエラーが0', () => {
  const r = spawnSync(process.execPath, [script, '--all'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// ---------------------------------------------------------------------------
// 一時的な git リポジトリで、pre-commit フックがコミットを止めることを確かめる

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'phi-guard-'));
  const run = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.name', 'phi-guard-test');
  run('config', 'user.email', ['test', 'example.invalid'].join(AT));
  run('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, '.githooks'));
  copyFileSync(script, join(dir, 'scripts', 'phi-guard.mjs'));
  for (const hook of readdirSync(join(root, '.githooks'))) {
    copyFileSync(join(root, '.githooks', hook), join(dir, '.githooks', hook));
    chmodSync(join(dir, '.githooks', hook), 0o755);
  }
  run('config', 'core.hooksPath', '.githooks');
  run('add', '-A');
  const first = run('commit', '-q', '-m', 'init');
  assert.equal(first.status, 0, first.stderr);
  return { dir, run };
}

function tryCommit({ dir, run }, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    run('add', '-f', path);
  }
  const r = run('commit', '-q', '-m', 'test');
  if (r.status !== 0) run('reset', '-q', '--hard', 'HEAD');
  return r;
}

test('pre-commit フックが陽性サンプルのコミットを止める', () => {
  const repo = setupRepo();
  try {
    const phone = sample.phone();
    const blocked = tryCommit(repo, { 'notes.md': `# メモ\n連絡先 ${phone}\n` });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /phone/);
    assert.ok(!blocked.stderr.includes(phone), '見つけた文字列そのものを出力している');

    const noSynthetic = tryCommit(repo, { 'fixtures/case.md': '---\ntitle: 例\n---\n本文\n' });
    assert.notEqual(noSynthetic.status, 0);
    assert.match(noSynthetic.stderr, /fixture-not-synthetic/);

    const forbidden = tryCommit(repo, { 'data/cases.json': '{}\n' });
    assert.notEqual(forbidden.status, 0);
    assert.match(forbidden.stderr, /forbidden-path/);

    const large = tryCommit(repo, { 'big.txt': 'a'.repeat(MAX_BYTES + 1) });
    assert.notEqual(large.status, 0);
    assert.match(large.stderr, /too-large/);

    const ok = tryCommit(repo, {
      'fixtures/case.md': '---\nsynthetic: true\n---\n本文\n',
      'notes.md': `# メモ\n${phone} ${ALLOW} 架空の番号\n`,
    });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T054：ファイル単位の抜け道（NUL・UTF-16・バイナリ、改行の種類、Fixtures の大文字、ファイル名、禁止の拡張子、無視対象、
// シンボリックリンク、種類の変更、マージ・メッセージ・push の経路）

const fileRules = (path, buf) => scanFile({ path, size: buf.length, read: () => buf }).map((f) => `${f.level}:${f.rule}`);
const utf16le = (text, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);

test('BOM つきの UTF-16 のテキストを読んで検査する。BOM のない UTF-16 は、読めないバイナリとして止める。UTF-8 の BOM は除く', () => {
  const text = `メモ\n連絡先 ${sample.phone()}\n`;
  assert.deepEqual(fileRules('notes.txt', utf16le(text)), ['error:phone']);
  assert.deepEqual(fileRules('notes.txt', utf16le(text, false)), ['error:binary-file']);
  const be = Buffer.from(text, 'utf16le').swap16();
  assert.deepEqual(fileRules('notes.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), be])), ['error:phone']);
  assert.equal(decodeText(Buffer.from('\ufeffsynthetic: true\n', 'utf8')), 'synthetic: true\n');
});

test('読めないバイナリは置けない（先頭に NUL を1字入れただけのテキストも）。アプリのアイコンだけは置ける', () => {
  const withNul = Buffer.concat([Buffer.from([0]), Buffer.from(`連絡先 ${sample.phone()}`, 'utf8')]);
  assert.deepEqual(fileRules('notes.txt', withNul), ['error:binary-file']);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);
  assert.deepEqual(fileRules('docs/images/screen.png', png), ['error:binary-file']);
  assert.deepEqual(fileRules('apps/web/public/icon-192.png', png), []);
});

test('CR だけ・U+2028 の改行でも行に分ける（最後の行の allow が、前の行に効かない）', () => {
  for (const nl of ['\r', '\u2028', '\u2029']) {
    assert.deepEqual(rules(`連絡先 ${sample.phone()}${nl}${ALLOW} 架空`), ['error:phone'], JSON.stringify(nl));
  }
});

test('Fixtures/・FIXTURES/ も fixtures/ と同じに synthetic: true を確かめる', () => {
  for (const dir of ['Fixtures', 'FIXTURES']) {
    assert.deepEqual(fileRules(`${dir}/case.md`, Buffer.from('本文\n')), ['error:fixture-not-synthetic'], dir);
  }
});

test('禁止の拡張子に、.sqlite3 と -wal・-shm・-journal を足した。ファイル名・ディレクトリ名も文字列の検査に掛ける', () => {
  for (const p of ['x.sqlite3', 'x.db-wal', 'x.sqlite-shm', 'x.db-journal', 'X.SQLITE3']) assert.deepEqual(checkPath(p).map((f) => f.rule), ['forbidden-path'], p);
  assert.deepEqual(checkPath(`notes/${sample.phoneCompact()}.md`).map((f) => f.rule), ['path-phone']);
  assert.deepEqual(checkPath(`${sample.dob()}-memo.md`).map((f) => f.rule), ['path-birth-date']);
  assert.deepEqual(checkPath('packages/core/src/database.ts'), []);
});

test('コミットメッセージを検査する（# の行と、git の署名の行は除く）', () => {
  assert.deepEqual(scanMessage(`修正\n\n連絡先 ${sample.phone()}\n`).map((f) => f.rule), ['phone']);
  assert.deepEqual(scanMessage(`修正\n# ${sample.phone()}\n`), []);
  // 共同作者の行のメールアドレスは止めない。本文のメールアドレスは止める
  assert.deepEqual(scanMessage(`修正\n\nCo-Authored-By: 架空 <${sample.email()}>\n`), []);
  assert.deepEqual(scanMessage(`修正\n\n連絡は ${sample.email()} へ\n`).map((f) => f.rule), ['email']);
});

test('パスを渡す実行：ない道だけなら、使い方の誤り（2）。通ったように見せない', () => {
  const r = spawnSync(process.execPath, [script, join(tmpdir(), 'no-such-file-phi-guard')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('--all は、無視対象のファイルも検査する（.gitignore に頼らない）。シンボリックリンクは、リンク先を読まない', () => {
  const repo = setupRepo();
  try {
    writeFileSync(join(repo.dir, '.gitignore'), 'data/\n*.log\nnode_modules/\n');
    mkdirSync(join(repo.dir, 'data'));
    writeFileSync(join(repo.dir, 'data', 'cases.json'), '{}\n');
    writeFileSync(join(repo.dir, 'run.log'), `連絡先 ${sample.phone()}\n`);
    mkdirSync(join(repo.dir, 'node_modules'));
    writeFileSync(join(repo.dir, 'node_modules', 'x.txt'), `連絡先 ${sample.phone()}\n`);
    const outside = mkdtempSync(join(tmpdir(), 'phi-guard-outside-'));
    writeFileSync(join(outside, 'secret.txt'), `連絡先 ${sample.phone()}\n`);
    symlinkSync(join(outside, 'secret.txt'), join(repo.dir, 'link.txt'));
    const r = spawnSync(process.execPath, [join(repo.dir, 'scripts', 'phi-guard.mjs'), '--all'], { cwd: repo.dir, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /data\/cases\.json\s+error\s+forbidden-path/);
    assert.match(r.stderr, /run\.log:1:\d+\s+error\s+phone/);
    assert.doesNotMatch(r.stderr, /node_modules/);
    assert.doesNotMatch(r.stderr, /link\.txt:1/);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('種類の変わったファイル（シンボリックリンク → 普通のファイル）も、ステージした中身を検査する', () => {
  const repo = setupRepo();
  try {
    symlinkSync('README', join(repo.dir, 'notes.md'));
    repo.run('add', 'notes.md');
    assert.equal(repo.run('commit', '-q', '-m', 'link').status, 0);
    rmSync(join(repo.dir, 'notes.md'));
    const blocked = tryCommit(repo, { 'notes.md': `連絡先 ${sample.phone()}\n` });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /phone/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('commit-msg・pre-merge-commit・pre-push のフックが止める（メッセージ、マージ、途中のコミットの中身）', () => {
  const repo = setupRepo();
  try {
    const phone = sample.phone();
    // コミットメッセージ
    writeFileSync(join(repo.dir, 'a.md'), 'a\n');
    repo.run('add', 'a.md');
    const msg = repo.run('commit', '-q', '-m', `連絡先 ${phone}`);
    assert.notEqual(msg.status, 0);
    assert.ok(!msg.stderr.includes(phone));
    assert.equal(repo.run('commit', '-q', '-m', 'a').status, 0);

    // マージ（--no-ff）：フックのない経路で作った枝のコミットも、マージで止まる
    repo.run('checkout', '-q', '-b', 'side');
    writeFileSync(join(repo.dir, 'side.md'), `連絡先 ${phone}\n`);
    repo.run('add', 'side.md');
    assert.equal(repo.run('commit', '-q', '--no-verify', '-m', 'side').status, 0);
    repo.run('checkout', '-q', '-');
    const merge = repo.run('merge', '--no-ff', '-q', '-m', 'merge', 'side');
    assert.notEqual(merge.status, 0);
    assert.match(merge.stderr, /phone/);
    repo.run('merge', '--abort');

    // push：途中のコミットにだけあった中身も見つける（最後のコミットで消していても）
    const pushed = spawnSync(process.execPath, [join(repo.dir, 'scripts', 'phi-guard.mjs'), '--push'], {
      cwd: repo.dir,
      encoding: 'utf8',
      input: `refs/heads/side ${repo.run('rev-parse', 'side').stdout.trim()} refs/heads/side ${'0'.repeat(40)}\n`,
    });
    assert.notEqual(pushed.status, 0);
    assert.match(pushed.stderr, /side\.md:1:\d+\s+error\s+phone/);
    assert.ok(!pushed.stderr.includes(phone));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

