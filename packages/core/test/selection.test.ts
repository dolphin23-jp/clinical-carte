// AI の選別の答えを、決まった語に置き換える（docs/01 の 2。CA-006）。AI は場所を指すだけで、文は書き換えない。
// 氏名の見本は、実行時に組み立てる。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { applySelection, IDENTIFIER_TOKENS, IDENTIFIERS_MAX, QUOTE_MAX, type SelectionAnswer } from '../src/index.ts';

const NAME = ['架空', '太郎'].join('');
const STAFF = ['見本', '花子'].join('');
const HOSPITAL = ['みほん', '総合病院'].join('');
const CLINIC = ['かくう', 'クリニック'].join('');
const ID = ['12', '34', '56', '7'].join('');

const answer = (...identifiers: { kind: SelectionAnswer['identifiers'][number]['kind']; quote: string; facility?: SelectionAnswer['identifiers'][number]['facility'] }[]): SelectionAnswer => ({
  identifiers: identifiers.map((i) => ({ kind: i.kind, quote: i.quote, facility: i.facility ?? null })),
});

describe('置き換え', () => {
  test('指された場所だけを、決まった語にする。ほかの文字は変えない', () => {
    const text = `${NAME}、72歳男性。${CLINIC}より紹介。ID ${ID}。担当は${STAFF}医師。\n肺炎の診断で${HOSPITAL}へ入院。`;
    const r = applySelection(
      text,
      answer(
        { kind: 'person', quote: NAME },
        { kind: 'facility', quote: CLINIC, facility: 'local' },
        { kind: 'patient_id', quote: ID },
        { kind: 'staff', quote: STAFF },
        { kind: 'facility', quote: HOSPITAL, facility: 'own' },
      ),
    );
    expect(r).toEqual({
      ok: true,
      text: '〔氏名〕、72歳男性。近医より紹介。ID 〔ID〕。担当は〔医療者〕医師。\n肺炎の診断で当院へ入院。',
      counts: { person: 1, facility: 2, patient_id: 1, staff: 1 },
    });
  });

  test('同じ引用は、文の中のすべての場所で置き換える', () => {
    const r = applySelection(`${NAME}が来院。${NAME}の家族に説明。`, answer({ kind: 'person', quote: NAME }));
    expect(r).toEqual({ ok: true, text: '〔氏名〕が来院。〔氏名〕の家族に説明。', counts: { person: 2 } });
  });

  test('何も指されなければ、文はそのまま', () => {
    const text = 'WBC 12300、CRP 12.3。パーキンソン病の既往。';
    expect(applySelection(text, answer())).toEqual({ ok: true, text, counts: {} });
  });

  test('施設の置き換え先がなければ、〔施設〕', () => {
    expect(applySelection(`${HOSPITAL}で手術`, answer({ kind: 'facility', quote: HOSPITAL }))).toMatchObject({ text: `${IDENTIFIER_TOKENS.facility}で手術` });
  });

  test('全角・半角の違う引用も、場所を見つける（位置は元の文のもの）', () => {
    const r = applySelection('番号は１２３４５６７です', answer({ kind: 'patient_id', quote: ID }));
    expect(r).toEqual({ ok: true, text: '番号は〔ID〕です', counts: { patient_id: 1 } });
  });

  test('重なる引用は、まとめて1つにする', () => {
    const r = applySelection(`${NAME}様のご家族`, answer({ kind: 'person', quote: NAME }, { kind: 'person', quote: `${NAME}様` }));
    expect(r).toEqual({ ok: true, text: '〔氏名〕のご家族', counts: { person: 1 } });
  });

  test('数字だけの引用は、ほかの数の一部を置き換えない', () => {
    const text = `ID ${ID}、検査値 9${ID} と 0.${ID}、もう一度 ${ID}。`;
    const r = applySelection(text, answer({ kind: 'patient_id', quote: ID }));
    expect(r).toEqual({ ok: true, text: `ID 〔ID〕、検査値 9${ID} と 0.${ID}、もう一度 〔ID〕。`, counts: { patient_id: 2 } });
  });
});

describe('確かめられない答えは、全体を失敗にする（識別情報が残るかもしれない文を、通さない）', () => {
  const text = `${NAME}、72歳。関節痛あり。WBC 72。`;
  test.each([
    ['文にない引用', answer({ kind: 'person', quote: '別の名前' }), 'not_found'],
    ['1字の引用（「関」→「関節」を壊す）', answer({ kind: 'person', quote: '関' }), 'too_short'],
    ['短い数（「72」を、文じゅうで置き換えない）', answer({ kind: 'patient_id', quote: '72' }), 'too_short'],
    ['長すぎる引用', answer({ kind: 'address', quote: 'あ'.repeat(QUOTE_MAX + 1) }), 'too_long'],
    ['前後に空白のある引用', answer({ kind: 'person', quote: ` ${NAME}` }), 'bad_shape'],
    ['改行をまたぐ引用', answer({ kind: 'person', quote: `${NAME}\n72` }), 'bad_shape'],
  ])('%s', (_name, a, problem) => {
    expect(applySelection(text, a)).toEqual({ ok: false, problems: [problem] });
  });

  test('1つでも確かめられなければ、ほかの正しい引用があっても、失敗', () => {
    const r = applySelection(text, answer({ kind: 'person', quote: NAME }, { kind: 'staff', quote: 'いない人' }));
    expect(r).toEqual({ ok: false, problems: ['not_found'] });
  });

  test('指す数が多すぎれば、失敗', () => {
    const many = answer(...Array.from({ length: IDENTIFIERS_MAX + 1 }, () => ({ kind: 'person' as const, quote: NAME })));
    expect(applySelection(text, many)).toEqual({ ok: false, problems: ['too_many'] });
  });
});

describe('性質：AI は文を書き換えられない', () => {
  const letters = fc.constantFrom('a', 'b', 'c', 'あ', 'い', '熱', '痛', '0', '1', ' ', '\n', '、');
  const TOKENS = new Set(Object.values(IDENTIFIER_TOKENS));
  const strip = (s: string): string => {
    let out = s;
    for (const t of TOKENS) out = out.split(t).join('');
    return out;
  };
  const isSubsequence = (small: string, big: string): boolean => {
    let i = 0;
    for (const c of big) if (small[i] === c) i += 1;
    return i === small.length;
  };

  test('成功したとき：語を除いた結果は、元の文から文字を抜いたもの（足した文字・変えた文字がない）。指された引用は、残らない', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: letters, minLength: 4, maxLength: 60 }),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 2, max: 6 })), { maxLength: 4 }),
        (text, picks) => {
          const quotes = picks.map(([at, len]) => text.slice(at % text.length, (at % text.length) + len)).filter((q) => q.length >= 2 && q === q.trim() && !q.includes('\n') && /[^\d\s]/.test(q));
          const r = applySelection(text, answer(...quotes.map((quote) => ({ kind: 'person' as const, quote }))));
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(isSubsequence(strip(r.text), text)).toBe(true);
          for (const q of quotes) expect(r.text.includes(q)).toBe(false);
          if (quotes.length === 0) expect(r.text).toBe(text);
        },
      ),
    );
  });
});
