// 相談の窓口（段M。CA-081）：資料の合成・外の検索に渡す語の確かめ・答えの確かめ（記号・用量と閾値・点数・「（推論）」・※・識別情報の形）・残す文。
// 段M2（CA-082〜CA-085）：途中の答えからの取り出し・文ごとの確かめ・前の受診の範囲・残した答えの印・記載の下書きと指示簿への項目。
// AI の答えは試験の代役。架空（synthetic）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  type AskInput,
  askNoteRefs,
  askNoteText,
  checkConsult,
  checkConsultStatement,
  cleanTerms,
  CONSULT_NOTE_MAX,
  CONSULT_STATEMENTS_MAX,
  CONSULT_TERM_MAX,
  CONSULT_TERMS_MAX,
  type ConsultAnswer,
  consultHasShapes,
  consultMaterial,
  consultMessage,
  consultNoteLabel,
  ConsultNotePatch,
  consultOrderNew,
  consultOrderText,
  consultPick,
  ConsultNoteNew,
  consultNoteRefs,
  consultNoteText,
  ConsultRequest,
  consultTermsMessage,
  OrderNew,
  partialStatements,
  type ListItem,
  type RefSource,
  type SupportInput,
} from '../src/index.ts';

const IN = 'enc-in';
const T1 = '【入院1日目】3日前から発熱。CRP 12.3 と高値。#1 市中肺炎 A) 右下葉の肺炎。P) セフトリアキソン 2g を開始。';
const T2 = '【入院2日目】解熱傾向。CRP 8.1。P) 抗菌薬を継続。';
const item = (over: Partial<ListItem>): ListItem => ({ key: 'k1', name: '市中肺炎', certainty: 'diagnosis', activity: 'active', threadIds: ['th1'], course: [], basis: '', since: '2026-11-20T10:00', self: [], hidden: false, ...over });

const SUPPORT: SupportInput = {
  patient: { age: 72, ageOn: '2026-11-20', sex: 'male' },
  today: '2026-11-21',
  encounter: { kind: 'inpatient', start: '2026-11-20T10:00', end: null },
  asOf: '2026-11-21T09:00',
  list: [item({}), item({ key: 'k2', name: '低Na血症', certainty: 'problem', activity: 'resolved', threadIds: [] })],
  threads: [{ id: 'th1', name: '#1 市中肺炎', status: 'diagnosis', group: 'current', first: '2026-11-20T10:00', last: '2026-11-21T09:00', lastNote: 'P) 抗菌薬を継続' }],
  course: [{ sourceId: 's1', start: 8, at: '2026-11-17', atApprox: null, category: 'onset', summary: '発熱が出現' }],
  observations: [
    { id: 'o1', at: '2026-11-20T10:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', value: 12.3, comparator: null, valueText: '12.3', unit: 'mg/dL' },
    { id: 'o2', at: '2026-11-21T09:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', value: 8.1, comparator: null, valueText: '8.1', unit: 'mg/dL' },
  ],
  medications: [{ id: 'm1', sourceId: 's1', start: 0, name: 'セフトリアキソン', doseText: '2g', action: 'start', at: '2026-11-20T10:00' }],
  events: [],
};
const ASK: AskInput = {
  patient: SUPPORT.patient,
  today: SUPPORT.today,
  encounters: [{ id: IN, kind: 'inpatient', start: '2026-11-20T10:00', end: null }],
  sources: [
    { id: 's1', encounterId: IN, kind: 'admission_note', authorRole: 'self', at: '2026-11-20T10:00', text: T1 },
    { id: 's2', encounterId: IN, kind: 'progress_note', authorRole: 'self', at: '2026-11-21T09:00', text: T2 },
  ],
  segments: [],
  medications: [{ sourceId: 's1', encounterId: IN, name: 'セフトリアキソン', doseText: '2g', action: 'start', at: '2026-11-20T10:00', start: 0, end: 4 }],
  events: [{ sourceId: 's1', encounterId: IN, kind: 'test', title: '血液培養2セット', at: '2026-11-20T10:00', start: 0, end: 4 }],
  observations: [{ sourceId: 's1', encounterId: IN, name: 'CRP', nameRaw: 'CRP', valueText: '12.3', unit: null, at: '2026-11-20T10:00', start: 0, end: 4 }],
  course: [],
};
const material = consultMaterial({ support: SUPPORT, ask: ASK });
const BOOK: RefSource = { id: 'B1', kind: 'book', problem: null, text: '市中肺炎では、臨床の改善を見て静注から経口へ切り替える。治療期間は 5 日以上。', at: null, day: null, label: '架空の内科学 120', ref: { k: 'book', title: '架空の内科学', page: '120', path: null } };
const WEB: RefSource = { id: 'W1', kind: 'web', problem: null, text: '解熱後 48 時間で経口への切り替えを検討する。', at: null, day: null, label: '架空のガイドライン', ref: { k: 'web', title: '架空のガイドライン', url: 'https://example.org/cap' } };
const st = (over: Partial<ConsultAnswer['statements'][number]>): ConsultAnswer['statements'][number] => ({ section: 'assessment', text: '経過は改善している', support: ['V1'], citations: [], ...over });

describe('資料（consultMaterial）', () => {
  test('臨床支援の資料（P・T・C・V・M・D・S）に、記載の全文（R）とできごと（E）を足す。記号は重ならない', () => {
    // S は、記録の値で決まる項目のあるスコア・診断基準（表の計算の結果）
    expect([...material.refs.keys()].filter((k) => !k.startsWith('S')).sort()).toEqual(['C1', 'E1', 'M1', 'P1', 'P2', 'R1', 'R2', 'T1', 'V1']);
    expect([...material.refs.keys()].filter((k) => k.startsWith('S')).length).toBeGreaterThan(0);
    expect(material.refs.get('P1')).toBe('プロブレム #1 市中肺炎');
    expect(material.refs.get('R2')).toContain('記載 ');
    expect(material.refs.get('M1')).toContain('開始から 2 日目'); // 薬は、臨床支援の側（日数つき）。記録に聞くの側の M は使わない
    expect(material.records).toBe(2);
    const message = JSON.parse(consultMessage(material, [BOOK], '全体の方針は？', [{ question: '前の問い', answer: '前の答え' }])) as Record<string, unknown>;
    expect(Object.keys(message)).toEqual(expect.arrayContaining(['problems', 'threads', 'values', 'medications', 'scores', 'records', 'events', 'references', 'conversation', 'question']));
    expect((message['records'] as { text: string }[]).map((r) => r.text)).toEqual([T1, T2]);
    expect(message['question']).toBe('全体の方針は？');
    expect(message['references']).toEqual([{ id: 'B1', kind: '書籍', label: '架空の内科学 120', text: BOOK.text }]);
  });

  test('外の検索に渡す問題の名前は、活動中の項目。リストがなければ、記録に書かれたいまの問題', () => {
    expect(material.problemNames).toEqual(['市中肺炎']);
    expect(consultMaterial({ support: { ...SUPPORT, list: [] }, ask: ASK }).problemNames).toEqual(['#1 市中肺炎']);
  });

  test('外の検索の語を取り出す係に送るのは、問いと問題の名前だけ（記録は送らない）', () => {
    const text = consultTermsMessage('抗菌薬の期間は？', material.problemNames);
    expect(JSON.parse(text)).toEqual({ problems: ['市中肺炎'], question: '抗菌薬の期間は？' });
    expect(text).not.toContain('CRP');
  });
});

describe('外の検索に渡す語（cleanTerms。CA-035 の改訂）', () => {
  test('一般的な語だけを残す：数字・年齢や病日の字・文・識別情報の形・長すぎる語は渡さない。同じ語は1つ', () => {
    expect(cleanTerms(['市中肺炎', 'セフトリアキソン', '抗菌薬 治療期間', 'community acquired pneumonia'])).toEqual(['市中肺炎', 'セフトリアキソン', '抗菌薬 治療期間', 'community acquired pneumonia']);
    expect(cleanTerms(['72歳', 'CRP 12.3', '入院2日目', '３日前から発熱', '七十二歳', '昨日の発熱'])).toEqual([]);
    expect(cleanTerms(['抗菌薬をいつまで続けるか。', '期間は？', 'a', 'あ'.repeat(CONSULT_TERM_MAX + 1)])).toEqual([]);
    expect(cleanTerms(['市中肺炎', ' 市中肺炎 ', 'ＣＡＰ', 'cap'])).toEqual(['市中肺炎', 'CAP']);
  });

  test('どんな字が来ても、数字と識別情報の形は外へ出ない。数は上限まで', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 60 }), { maxLength: 20 }), (raw) => {
        const out = cleanTerms(raw);
        expect(out.length).toBeLessThanOrEqual(CONSULT_TERMS_MAX);
        for (const term of out) {
          expect(term).not.toMatch(/[0-9０-９]/u);
          expect(term.length).toBeLessThanOrEqual(CONSULT_TERM_MAX);
          expect(term).not.toMatch(/[\n。？?@＠]/u);
        }
      }),
    );
  });
});

describe('確かめ（checkConsult）', () => {
  test('出典の引用のない文には「（推論）」。出典のある文は、題・頁・URL を付ける。見出しの順に並ぶ', () => {
    const r = checkConsult(
      { statements: [st({ section: 'treatment', text: '臨床の改善を見て、経口への切り替えを検討する', support: ['M1'], citations: ['B1', 'W1'] }), st({ section: 'summary', text: '肺炎は改善傾向', support: ['P1', 'R2'] })], unknown: '' },
      material,
      [BOOK, WEB],
    );
    expect(r.statements.map((s) => [s.section, s.text, s.inferred])).toEqual([
      ['summary', '肺炎は改善傾向（推論）', true],
      ['treatment', '臨床の改善を見て、経口への切り替えを検討する', false],
    ]);
    expect(r.statements[1]?.citations).toEqual([BOOK.ref, WEB.ref]);
    expect(r.statements[0]?.support).toEqual([{ id: 'P1', label: 'プロブレム #1 市中肺炎', sourceId: null }, { id: 'R2', label: expect.stringContaining('記載 ') as string, sourceId: 's2' }]);
    expect(r.rejected).toEqual({});
  });

  test('資料・出典にない記号は、根拠から外して数える（文は残す）', () => {
    const r = checkConsult({ statements: [st({ support: ['V1', 'V99'], citations: ['B9'] })], unknown: '' }, material, [BOOK]);
    expect(r.statements[0]?.support.map((s) => s.id)).toEqual(['V1']);
    expect(r.statements[0]?.inferred).toBe(true);
    expect(r.rejected).toEqual({ unknown_ref: 2 });
  });

  test('資料にない用量・閾値・目標値のある文は、出典の引用がなければ出さない。出典があれば出し、出典にも見つからない数には※', () => {
    const answer: ConsultAnswer = {
      statements: [
        st({ section: 'treatment', text: 'レボフロキサシン 500mg へ変更する', citations: [] }),
        st({ section: 'treatment', text: 'SpO2 は 94 以上を目標にする', citations: [] }),
        st({ section: 'treatment', text: '治療期間は 5 日以上とされる', citations: ['B1'] }),
        st({ section: 'treatment', text: '治療期間は 7 日以上とされる', citations: ['B1'] }),
        st({ section: 'assessment', text: 'CRP は 12.3 から 8.1 へ下がっている', support: ['V1'] }),
      ],
      unknown: '',
    };
    const r = checkConsult(answer, material, [BOOK]);
    expect(r.rejected).toEqual({ dose: 2 });
    expect(r.statements.map((s) => [s.text, s.marks.length])).toEqual([
      ['CRP は 12.3 から 8.1 へ下がっている（推論）', 0],
      ['治療期間は 5 日以上とされる', 0],
      ['治療期間は 7 日以上とされる', 1],
    ]);
  });

  test('表の計算にない点数のある文は出さない（AI に点数を計算させない）', () => {
    const r = checkConsult({ statements: [st({ text: 'A-DROP は 2点で中等症', support: ['P1'] })], unknown: '' }, material, []);
    expect(r.statements).toEqual([]);
    expect(r.rejected).toEqual({ score: 1 });
  });

  test('識別情報の形は伏せて数える。空の文・多すぎる文は出さない', () => {
    const many = Array.from({ length: CONSULT_STATEMENTS_MAX + 2 }, (_, i) => st({ text: `架空の文${'あ'.repeat(i + 1)}` }));
    const r = checkConsult({ statements: [st({ text: '連絡は 090-1234-5678 へ' }), st({ text: '  ' }), ...many], unknown: ' 腎機能の値が資料にない ' }, material, []); // phi-guard: allow 架空の電話番号（形の検査の試験）
    expect(r.shapes).toBe(1);
    expect(r.statements[0]?.text).not.toContain('090');
    expect(r.statements).toHaveLength(CONSULT_STATEMENTS_MAX);
    expect(r.rejected).toEqual({ empty: 1, too_many: 3 });
    expect(r.unknown).toBe('腎機能の値が資料にない');
  });
});

describe('頼みの形と、残す文', () => {
  test('問いは空・長すぎを受けない。前のやりとりは 6 つまで。問い・やりとりに識別情報の形があれば送らない', () => {
    expect(ConsultRequest.safeParse({ question: ' ', turns: [], web: false, past: false }).success).toBe(false);
    expect(ConsultRequest.safeParse({ question: 'あ'.repeat(801), turns: [], web: false, past: false }).success).toBe(false);
    expect(ConsultRequest.safeParse({ question: '方針は？', turns: Array.from({ length: 7 }, () => ({ question: 'q', answer: 'a' })), web: false, past: false }).success).toBe(false);
    expect(ConsultRequest.safeParse({ question: '方針は？', turns: [], web: true, past: false, extra: 1 }).success).toBe(false);
    expect(consultHasShapes({ question: '方針は？', turns: [] })).toBe(false);
    expect(consultHasShapes({ question: '方針は？', turns: [{ question: 'q', answer: 'test@example.com に連絡' }] })).toBe(true); // phi-guard: allow 架空のメール（形の検査の試験）
  });

  test('相談の答えを残す文：見出しごと。※と「（推論）」は字のまま。参照は出典だけ（同じものは1つ）', () => {
    const r = checkConsult(
      { statements: [st({ section: 'treatment', text: '治療期間は 7 日以上とされる', citations: ['B1'] }), st({ section: 'treatment', text: '経口への切り替えを検討する', citations: ['B1'] }), st({ section: 'assessment', text: '改善傾向' })], unknown: '腎機能の値がない' },
      material,
      [BOOK],
    );
    expect(consultNoteText(r)).toBe('【アセスメント】\n・改善傾向（推論）\n【治療・方針】\n・治療期間は 7※ 日以上とされる\n・経口への切り替えを検討する\n【答えられなかったこと】\n腎機能の値がない');
    expect(consultNoteRefs(r)).toEqual([BOOK.ref]);
    expect(consultNoteText({ statements: Array.from({ length: 40 }, () => ({ ...(r.statements[0] ?? ({} as never)), text: 'あ'.repeat(600), marks: [] })), unknown: '' }).length).toBeLessThanOrEqual(CONSULT_NOTE_MAX);
  });

  test('記録だけからの答えを残す文：参照は記録の場所', () => {
    const reply = { answer: [{ text: 'CRP は 12.3', marks: [], refs: [{ id: 'V1', kind: 'value' as const, sourceId: '01JD8Q4X2M5N7P9R3T6V8W0Y1Z', start: 3, end: 11, label: '値', at: null, quoted: false }] }], notFound: '記録に見つかりませんでした：培養の結果' }; // phi-guard: allow 架空の ULID（患者の番号ではない）
    expect(askNoteText(reply)).toBe('・CRP は 12.3\n記録に見つかりませんでした：培養の結果');
    expect(askNoteRefs(reply)).toEqual([{ k: 'record', sourceId: '01JD8Q4X2M5N7P9R3T6V8W0Y1Z', start: 3, end: 11 }]); // phi-guard: allow 架空の ULID（患者の番号ではない）
    expect(ConsultNoteNew.safeParse({ mode: 'record', text: askNoteText(reply), refs: askNoteRefs(reply) }).success).toBe(true);
    expect(ConsultNoteNew.safeParse({ mode: 'consult', text: '', refs: [] }).success).toBe(false);
  });
});

describe('前の受診の記録も資料にする（CA-084）', () => {
  const ER = 'enc-er-old';
  const PAST: AskInput = {
    ...ASK,
    encounters: [{ id: ER, kind: 'outpatient', start: '2026-10-01T09:00', end: '2026-10-01T10:00' }, ...ASK.encounters],
    sources: [{ id: 's0', encounterId: ER, kind: 'outpatient_first', authorRole: 'self', at: '2026-10-01T09:30', text: '【外来】健診で胸部異常影を指摘。喫煙 40 本×30 年。' }, ...ASK.sources],
    events: [{ sourceId: 's0', encounterId: ER, kind: 'test', title: '胸部X線', at: '2026-10-01T09:30', start: 0, end: 4 }, ...ASK.events],
  };

  test('選ばなければ、いまの受診（と直前の救急）だけ。選ぶと、すべての受診の記載とできごとが入り、記載に、どの受診かを添える', () => {
    const now = consultMaterial({ support: SUPPORT, ask: PAST });
    expect(now.records).toBe(2);
    expect(now.encounters).toBe(1);
    expect(JSON.stringify(now.payload)).not.toContain('胸部異常影');

    const all = consultMaterial({ support: SUPPORT, ask: PAST }, { past: true });
    expect(all.records).toBe(3);
    expect(all.encounters).toBe(2);
    const records = all.payload['records'] as { ref: string; text: string; encounter: string }[];
    expect(records.map((r) => r.ref)).toEqual(['R1', 'R2', 'R3']);
    expect(records[0]?.text).toContain('胸部異常影');
    expect(records[0]?.encounter).toBe('外来 2026-10-01 09:00〜');
    expect(records[2]?.encounter).toContain('入院');
    expect((all.payload['events'] as unknown[]).length).toBe(2);
    expect(all.recordSources.get('R1')).toBe('s0');
    // 前の受診の記載の数も、照らし合わせの数に入る（※が付かない）
    const r = checkConsult({ statements: [st({ text: '喫煙は 40 本を 30 年と書かれている', support: ['R1'] })], unknown: '' }, all, []);
    expect(r.statements[0]?.marks).toEqual([]);
    expect(checkConsult({ statements: [st({ text: '喫煙は 40 本を 30 年と書かれている', support: ['R1'] })], unknown: '' }, now, []).statements[0]?.marks.length).toBeGreaterThan(0);
  });
});

describe('少しずつ出す（CA-085）：書き終えた文だけを取り出し、同じ確かめを通す', () => {
  const answer: ConsultAnswer = {
    statements: [
      st({ section: 'summary', text: '発熱と CRP 12.3 の高値。"引用符" や { かっこ } ] \\ も字として読む', support: ['V1', 'R1'] }),
      st({ section: 'treatment', text: 'セフトリアキソン 4 g/日 に増やす', support: ['M1'] }),
      st({ section: 'workup', text: '臨床の改善を見て、経口へ切り替える', citations: ['B1'] }),
    ],
    unknown: '培養の結果は、記載がない',
  };
  const json = JSON.stringify(answer);

  test('途中までの字からは、閉じた文だけ。最後まで届けば、全部。順は書かれたまま', () => {
    expect(partialStatements('')).toEqual([]);
    expect(partialStatements('{"statements":[')).toEqual([]);
    const first = json.indexOf('},{') + 1;
    expect(partialStatements(json.slice(0, first - 1))).toEqual([]);
    expect(partialStatements(json.slice(0, first))).toEqual([answer.statements[0]]);
    expect(partialStatements(json)).toEqual(answer.statements);
    // 形の合わない文があれば、そこで止める（順を飛ばさない）
    expect(partialStatements('{"statements":[{"section":"summary","text":"a","support":[],"citations":[]},{"section":"x"},{"section":"summary","text":"b","support":[],"citations":[]}]}')).toHaveLength(1);
  });

  test('どこで切っても、取り出した文は、答えの文の先頭からの並び（途中の字・あとの字が混ざらない）', () => {
    const text = fc.string({ maxLength: 40 });
    const ids = fc.array(fc.constantFrom('V1', 'R1', 'B1', 'X9'), { maxLength: 3 });
    const statement = fc.record({ section: fc.constantFrom('summary', 'assessment', 'workup', 'treatment', 'caution', 'other'), text, support: ids, citations: ids });
    fc.assert(
      fc.property(fc.array(statement, { maxLength: 5 }), text, fc.nat(), fc.boolean(), (statements, unknown, cut, pretty) => {
        const whole = JSON.stringify({ statements, unknown }, null, pretty ? 2 : 0);
        const got = partialStatements(whole.slice(0, cut % (whole.length + 1)));
        expect(got).toEqual(statements.slice(0, got.length));
        expect(partialStatements(whole)).toEqual(statements);
      }),
      { numRuns: 300 },
    );
  });

  test('文ごとの確かめは、まとめての確かめと同じ結果（用量のある出典なしの文は出さない・「（推論）」・※）', () => {
    const whole = checkConsult(answer, material, [BOOK]);
    const each = answer.statements.map((x) => checkConsultStatement(x, material, [BOOK]));
    expect(each.map((c) => c.statement === null)).toEqual([false, true, false]);
    expect(each[1]?.reasons).toEqual(['dose']);
    expect(each[0]?.statement?.text.endsWith('（推論）')).toBe(true);
    expect(each[2]?.statement?.inferred).toBe(false);
    // まとめての確かめは、通った文を見出しの順に並べたもの
    expect(whole.statements).toEqual([each[0]?.statement, each[2]?.statement]);
    expect(whole.rejected).toEqual({ dose: 1 });
  });
});

describe('残した答えを直す（CA-083）と、記載の下書き・指示簿へ入れる（CA-082）', () => {
  test('直した答えには「（先生が直した）」。直す字は、空・長すぎを受けない', () => {
    expect(consultNoteLabel({ mode: 'consult', edited: false })).toBe('AI の相談');
    expect(consultNoteLabel({ mode: 'consult', edited: true })).toBe('AI の相談（先生が直した）');
    expect(consultNoteLabel({ mode: 'record', edited: true })).toBe('AI が記録から答えた（先生が直した）');
    expect(ConsultNotePatch.safeParse({ text: ' ' }).success).toBe(false);
    expect(ConsultNotePatch.safeParse({ text: 'あ'.repeat(CONSULT_NOTE_MAX + 1) }).success).toBe(false);
    expect(ConsultNotePatch.safeParse({ text: '直した字', mode: 'record' }).success).toBe(false);
    expect(ConsultNotePatch.safeParse({ text: '直した字' }).success).toBe(true);
  });

  test('記載の下書きの候補：※は字に入れ、出典の参照を付ける。指示簿の項目：「AI の案」・根拠の名前・字に残っている※の数だけ', () => {
    const checked = checkConsult({ statements: [st({ section: 'caution', text: '呼吸数が 30 回を超えたら再評価する', support: ['V1', 'R2'], citations: ['W1'] }), st({ text: '抗菌薬の継続を検討する', support: ['T1'] })] , unknown: '' }, material, [WEB]);
    const [cited, inferred] = [checked.statements.find((x) => !x.inferred), checked.statements.find((x) => x.inferred)];
    if (cited === undefined || inferred === undefined) throw new Error('確かめに通らなかった');
    const pick = consultPick('1-0', cited);
    expect(pick.text).toBe('呼吸数が 30※ 回を超えたら再評価する');
    expect(pick.refs).toEqual([WEB.ref]);

    // 指示簿へ：「（推論）」は外す。先生が欄を選び、字を確かめる
    expect(consultOrderText(inferred)).toBe('抗菌薬の継続を検討する');
    const order = consultOrderNew(cited, 'call', '呼吸数 30 回/分 以上で医師コール');
    expect(OrderNew.safeParse(order).success).toBe(true);
    expect(order).toMatchObject({ category: 'call', text: '呼吸数 30 回/分 以上で医師コール', origin: 'ai', from: null, action: 'none', scale: null, dose: '', unseen: ['30'] });
    expect(order.basis.map((b) => b.id)).toEqual(['V1', 'R2']);
    // 字から数を消したら、その印は渡さない
    expect(consultOrderNew(cited, 'call', '頻呼吸で医師コール').unseen).toEqual([]);
  });
});
