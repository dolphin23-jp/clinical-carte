import { readLabText } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { composeValues, insertAt, LAB_SETS, TEMPLATES, VITAL_FIELDS } from '../src/templates.ts';

describe('入力の欄から作る文', () => {
  test('バイタル：空の欄は書かない。血圧は上下そろえば「BP 上/下」。作った文は、値の読み取りでそのまま読める', () => {
    const r = composeValues(VITAL_FIELDS, { BT: '37.2', HR: '88', SBP: '120', DBP: '80', SpO2: '97' });
    expect(r).toEqual({ text: 'BT 37.2 HR 88 BP 120/80 SpO2 97%' });
    if (!('text' in r)) return;
    expect(readLabText(r.text).rows.map((x) => [x.name, x.valueText])).toEqual([
      ['体温', '37.2'],
      ['心拍数', '88'],
      ['収縮期血圧', '120'],
      ['拡張期血圧', '80'],
      ['SpO2', '97'],
    ]);
    expect(readLabText(r.text).unread).toEqual([]);
  });

  test('血圧が片方だけなら、その片方だけ（もう片方を補わない）', () => {
    expect(composeValues(VITAL_FIELDS, { SBP: '98' })).toEqual({ text: 'SBP 98' });
    const r = composeValues(VITAL_FIELDS, { DBP: '40' });
    expect(r).toEqual({ text: 'DBP 40' });
  });

  test('全角の数・不等号つきの値は受け付ける。形の違う値は、文を作らずに、欄の名前を返す', () => {
    expect(composeValues(['CRP', 'Na'], { CRP: '＜０．１', Na: '１２８' })).toEqual({ text: 'CRP <0.1 Na 128' });
    expect(composeValues(VITAL_FIELDS, { BT: '37,2', HR: 'abc' })).toEqual({ bad: ['体温', '心拍数'] });
  });

  test('検査の組の、すべての項目名が、値の読み取りでその項目として読める', () => {
    for (const set of LAB_SETS) {
      const values = Object.fromEntries(set.items.map((name) => [name, '1']));
      const r = composeValues(set.items, values);
      expect('text' in r, set.label).toBe(true);
      if (!('text' in r)) continue;
      const read = readLabText(r.text);
      expect(read.unread, set.label).toEqual([]);
      expect(read.rows.length, set.label).toBe(set.items.length);
      expect(read.rows.every((row) => row.name !== null), set.label).toBe(true);
    }
  });
});

describe('ひな形', () => {
  test('ひな形は、見出しだけ（数を持たない）', () => {
    for (const list of Object.values(TEMPLATES)) for (const t of list) expect(t.text, t.label).not.toMatch(/\d{2,}|\d\.\d/);
  });

  test('カーソルの位置に差し込む。前の文に続けるときは、改行か空白をはさむ', () => {
    expect(insertAt('', 0, 0, 'S) \nO) \n')).toEqual({ text: 'S) \nO) \n', cursor: 8 });
    expect(insertAt('解熱。', 3, 3, 'S) \n')).toEqual({ text: '解熱。\nS) \n', cursor: 8 });
    expect(insertAt('WBC 12', 6, 6, 'CRP ')).toEqual({ text: 'WBC 12 CRP ', cursor: 11 });
    expect(insertAt('ab', 1, 1, 'X')).toEqual({ text: 'a Xb', cursor: 3 });
  });
});
