// 保存の前の、形の検査（docs/01 の 2）。陽性の見本は、実行時に組み立てる（ソースに書くと phi-guard に止められる）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { cleanText, findShapes, foldSameLength, replaceShapes, SHAPE_TOKENS } from '../src/index.ts';

const phone = ['090', '1234', '5678'].join('-');
const phoneWide = ['０９０', '１２３４', '５６７８'].join('－');
const landline = ['03', '1234', '5678'].join('-');
const phonePlain = ['0', '9', '0', '1234', '5678'].join('');
const email = ['taro', '@', 'example', '.jp'].join('');
const postal = ['〒', '123', '-', '4567'].join('');
const long12 = '1234'.repeat(3);
const long16 = '1234'.repeat(4);

describe('見つけるもの', () => {
  test.each([
    ['電話（区切りつき）', phone, 'phone'],
    ['電話（全角）', phoneWide, 'phone'],
    ['電話（固定）', landline, 'phone'],
    ['電話（区切りなし）', phonePlain, 'phone'],
    ['メール', email, 'email'],
    ['郵便番号（〒つき）', postal, 'postal'],
    ['12桁の数字', long12, 'digits'],
    ['16桁の数字', long16, 'digits'],
  ])('%s', (_name, sample, kind) => {
    const text = `連絡先は ${sample} です。`;
    const found = findShapes(text);
    expect(found.map((f) => f.kind)).toEqual([kind]);
    expect(text.slice(found[0]?.start, found[0]?.end)).toBe(sample);
    const replaced = replaceShapes(text);
    expect(replaced.text).toBe(`連絡先は ${SHAPE_TOKENS[kind as keyof typeof SHAPE_TOKENS]} です。`);
    expect(replaced.counts).toEqual({ [kind]: 1 });
  });

  test('置き換えた後の文には、もう見つからない', () => {
    const text = `${phone} ${email} ${postal} ${long12}`;
    const once = replaceShapes(text);
    expect(findShapes(once.text)).toEqual([]);
    expect(replaceShapes(once.text).text).toBe(once.text);
  });
});

describe('見つけないもの（臨床の文を、誤って置き換えない）', () => {
  test.each([
    ['暦日（CA-004）', '2026-11-20 入院。2026/11/21 08:30 採血。11月22日 解熱。'],
    ['検査値の並び', 'WBC 12300 Hb 8.2 Plt 8.5 CRP 12.34 Na 128 K 3.1 Cr 1.82'],
    ['範囲の書き方（〒のない 3桁-4桁）', '尿量 800-1200 mL/日。目標 100-1500。'], // phi-guard: allow 臨床の数値の見本（郵便番号ではない）
    ['4桁の値の並び', '尿量 1200 1500 1800 と増加。'], // phi-guard: allow 臨床の数値の見本（番号ではない）
    ['時刻の並び', '0930 1200 1530 に測定。'], // phi-guard: allow 時刻の見本（番号ではない）
    ['血圧・心拍', 'BP 120/80 HR 72 SpO2 98% BT 36.5'],
    ['用量', 'メロペネム 1g 8時間ごと、ヘパリン 10000 単位/日'],
    ['小数の長い数', '0.123456789012 と 123456789012.5'],
  ])('%s', (_name, text) => {
    expect(findShapes(text)).toEqual([]);
    expect(replaceShapes(text)).toEqual({ text, counts: {} });
  });
});

describe('置き換えの性質', () => {
  test('形のない文は、1字も変えない', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('a', 'あ', '熱', ' ', '\n', '1', '2', '.', '/', ':', 'K', '-') }), (s) => {
        const short = s.replace(/\d{10,}/g, '');
        if (findShapes(short).length === 0) expect(replaceShapes(short).text).toBe(short);
      }),
    );
  });

  test('どんな文でも、見つけた場所は、重ならず、前から順', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('0', '1', '9', '-', ' ', '@', 'a', '.', '〒', '+', '8') , maxLength: 80 }), (s) => {
        let last = 0;
        for (const f of findShapes(s)) {
          expect(f.start).toBeGreaterThanOrEqual(last);
          expect(f.end).toBeGreaterThan(f.start);
          last = f.end;
        }
      }),
    );
  });
});

describe('文字のそろえ', () => {
  test('そろえても、長さは変わらない', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (s) => foldSameLength(s).length === s.length));
    expect(foldSameLength('ＷＢＣ　１２．３－４')).toBe('WBC 12.3-4');
  });

  test('保存の前の整え：見えない書式の文字を除き、改行を LF にし、前後の空白を落とす。ほかは変えない', () => {
    const zw = String.fromCharCode(0x200b);
    const soft = String.fromCharCode(0x00ad);
    expect(cleanText(`  発熱${zw}あり\r\nＷＢＣ １２${soft}３\r `)).toBe('発熱あり\nＷＢＣ １２３');
    expect(cleanText('①全角ＡＢＣ　そのまま')).toBe('①全角ＡＢＣ　そのまま');
  });
});
