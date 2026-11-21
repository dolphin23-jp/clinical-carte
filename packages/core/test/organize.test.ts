// AI の整理の答えを、確かめて記録の行にする（段2）。文は架空。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { applyOrganization, eventTimeline, problemBlocks, relatedFacts, foldedEventIds, foldedMedicationIds, medicationTimeline, type OrganizeAnswer, type OrganizeContext, problemKey, problemList, reportTotal } from '../src/index.ts';

const NOTE = [
  '#1 市中肺炎',
  'S) 咳嗽は軽減。',
  'O) BT 37.2 SpO2 96%（室内気）。昨日 BT 38.4。',
  'A) 抗菌薬に反応良好。',
  'P) メロペネム 1g 8時間毎 を継続。11/18 22:00 より開始。11/19 胸部X線を撮影。',
  'K 3.5 を目標に補正。',
].join('\n');

const ctx: OrganizeContext = { text: NOTE, kind: 'progress_note', at: '2026-11-20T09:00', encounterStart: '2026-11-18T22:10' };

const empty: OrganizeAnswer = { kind: null, when: null, segments: [], medications: [], events: [], problems: [], measurements: [] };
const answer = (patch: Partial<OrganizeAnswer>): OrganizeAnswer => ({ ...empty, ...patch });

describe('区切り', () => {
  test('始まりの引用で区切る。区切りは、次の区切りの前まで。文は1字も変えない', () => {
    const r = applyOrganization(
      answer({
        segments: [
          { label: 'subjective', start: 'S) 咳嗽は軽減。', when: null },
          { label: 'objective', start: 'O) BT 37.2', when: null },
          { label: 'assessment', start: 'A) 抗菌薬', when: null },
          { label: 'plan', start: 'P) メロペネム', when: null },
        ],
      }),
      ctx,
    );
    expect(r.segments.map((s) => [s.label, NOTE.slice(s.start, s.end).split('\n')[0]])).toEqual([
      ['subjective', 'S) 咳嗽は軽減。'],
      ['objective', 'O) BT 37.2 SpO2 96%（室内気）。昨日 BT 38.4。'],
      ['assessment', 'A) 抗菌薬に反応良好。'],
      ['plan', 'P) メロペネム 1g 8時間毎 を継続。11/18 22:00 より開始。11/19 胸部X線を撮影。'],
    ]);
    expect(r.segments.at(-1)?.end).toBe(NOTE.length);
    expect(r.report).toEqual({});
  });

  test('見つからない・順が逆の区切りは使わず、数える', () => {
    const r = applyOrganization(
      answer({
        segments: [
          { label: 'objective', start: 'O) BT 37.2', when: null },
          { label: 'subjective', start: 'S) 咳嗽は軽減。', when: null },
          { label: 'plan', start: 'Plan:', when: null },
        ],
      }),
      ctx,
    );
    expect(r.segments.map((s) => s.label)).toEqual(['objective']);
    expect(r.report).toEqual({ segment: { not_found: 2 } });
  });
});

describe('投薬・できごと・問題', () => {
  test('名前・用量は、文の字のまま。日時は、引用を決定論で読む（なければ記載の日時）', () => {
    const r = applyOrganization(
      answer({
        medications: [
          { name: 'メロペネム', dose: '1g 8時間毎', action: 'continue', when: null },
          { name: 'メロペネム', dose: null, action: 'start', when: '11/18 22:00' },
        ],
        events: [{ kind: 'test', title: '胸部X線を撮影', when: '11/19' }],
        problems: [{ name: '#1 市中肺炎', status: 'problem', activity: null }],
      }),
      ctx,
    );
    expect(r.medications.map((m) => [m.name, m.doseText, m.action, m.at])).toEqual([
      ['メロペネム', '1g 8時間毎', 'continue', '2026-11-20T09:00'],
      ['メロペネム', null, 'start', '2026-11-18T22:00'],
    ]);
    expect(r.events.map((e) => [e.kind, e.title, e.at])).toEqual([['test', '胸部X線を撮影', '2026-11-19']]);
    expect(r.problems.map((p) => [p.name, p.status, p.at])).toEqual([['#1 市中肺炎', 'problem', '2026-11-20T09:00']]);
    for (const f of [...r.medications, ...r.events, ...r.problems]) expect(NOTE.slice(f.start, f.end)).toBe('name' in f ? f.name : f.title);
    expect(r.report).toEqual({});
  });

  test('同じ字が何度も出る名前は、手がかり（用量・日時）の同じ行、なければ前の項目より後ろの場所に置く', () => {
    const text = ['A) #1 AKI（NSAIDs・ARBの関与あり）', 'P) 乳酸リンゲル 500 mL', 'ARB・NSAIDsは中止', '11:05 セフトリアキソン 2 g', '11:45 セフトリアキソン投与40分後に悪寒'].join('\n');
    const line = (start: number): number => text.slice(0, start).split('\n').length;
    const r = applyOrganization(
      answer({
        medications: [
          { name: '乳酸リンゲル', dose: '500 mL', action: 'start', when: null },
          { name: 'ARB', dose: null, action: 'stop', when: null },
          { name: 'NSAIDs', dose: null, action: 'stop', when: null },
          { name: 'セフトリアキソン', dose: null, action: null, when: '11:45' },
          { name: 'セフトリアキソン', dose: '2 g', action: 'start', when: null },
        ],
        events: [{ kind: 'other', title: 'セフトリアキソン', when: '11:45' }],
      }),
      { ...ctx, text },
    );
    expect(r.medications.map((m) => [m.name, line(m.start)])).toEqual([
      ['乳酸リンゲル', 2],
      ['ARB', 3],
      ['NSAIDs', 3],
      ['セフトリアキソン', 5],
      ['セフトリアキソン', 4],
    ]);
    expect(r.events.map((e) => line(e.start))).toEqual([5]);
    for (const m of r.medications) expect(text.slice(m.start, m.end)).toBe(m.name);
    // 手がかりも順もないときは、これまでどおり最初の場所（推し量らない）
    const alone = applyOrganization(answer({ medications: [{ name: 'ARB', dose: null, action: 'stop', when: null }] }), { ...ctx, text });
    expect(alone.medications.map((m) => line(m.start))).toEqual([1]);
  });

  test('文にない名前・用量・日時の引用は、事実にしない（AI が作った字を、記録に入れない）', () => {
    const r = applyOrganization(
      answer({
        medications: [
          { name: 'バンコマイシン', dose: null, action: 'start', when: null },
          { name: 'メロペネム', dose: '2g 8時間毎', action: 'change', when: null },
        ],
        events: [{ kind: 'surgery', title: '胸腔ドレーン留置', when: null }],
        problems: [{ name: '敗血症', status: 'suspected', activity: null }],
      }),
      ctx,
    );
    expect([r.medications, r.events, r.problems]).toEqual([[], [], []]);
    expect(r.report).toEqual({ medication: { not_found: 2 }, event: { not_found: 1 }, problem: { not_found: 1 } });
    expect(reportTotal(r.report)).toBe(4);
  });

  test('日時の引用が読めないときは、日時なし（記載の日時で埋めない）', () => {
    const r = applyOrganization(answer({ events: [{ kind: 'test', title: '胸部X線を撮影', when: '咳嗽' }] }), ctx);
    expect(r.events.map((e) => e.at)).toEqual([null]);
    expect(r.report).toEqual({ event: { when_unread: 1 } });
  });

  test('形の違う引用（空・前後の空白・改行・長すぎる）は、使わない', () => {
    const r = applyOrganization(
      answer({
        problems: [
          { name: '', status: 'problem', activity: null },
          { name: ' 市中肺炎', status: 'problem', activity: null },
          { name: '市中肺炎\nS)', status: 'problem', activity: null },
          { name: 'あ'.repeat(201), status: 'problem', activity: null },
        ],
      }),
      ctx,
    );
    expect(r.problems).toEqual([]);
    expect(r.report).toEqual({ problem: { bad_quote: 4 } });
  });
});

describe('測定値：数は、AI に写させない', () => {
  test('経過の文：AI が指した場所だけを、決定論で読む。「K 3.5 を目標に」は、指されなければ測定値にならない', () => {
    const r = applyOrganization(
      answer({
        measurements: [
          { quote: 'BT 37.2 SpO2 96%', when: null, specimen: null },
          { quote: 'BT 38.4', when: '昨日', specimen: null },
        ],
      }),
      ctx,
    );
    expect(r.observations.map((o) => [o.row.name, o.row.value, o.at, o.origin])).toEqual([
      ['体温', 37.2, '2026-11-20T09:00', 'ai'],
      ['SpO2', 96, '2026-11-20T09:00', 'ai'],
      ['体温', 38.4, '2026-11-19', 'ai'],
    ]);
    for (const o of r.observations) expect(NOTE.slice(o.row.start, o.row.end)).toContain(o.row.valueText);
  });

  test('同じ引用が2回あれば、2つめの場所を使う', () => {
    const text = 'BT 37.5 にて経過観察。夜間 BT 37.5 で変わらず。';
    const r = applyOrganization(
      answer({
        measurements: [
          { quote: 'BT 37.5', when: null, specimen: null },
          { quote: 'BT 37.5', when: '昨夜', specimen: null },
        ],
      }),
      { ...ctx, text },
    );
    expect(r.observations.map((o) => o.row.start)).toEqual([0, text.lastIndexOf('BT 37.5')]);
  });

  test('AI が、値でない所（測定でない数）を指しても、読めなければ事実にならない', () => {
    const r = applyOrganization(answer({ measurements: [{ quote: 'を目標に補正', when: null, specimen: null }] }), ctx);
    expect(r.observations).toEqual([]);
    expect(r.report).toEqual({ measurement: { unread: 1 } });
  });

  test('「値として読めない部分」に数えるのは、値を読めなかった引用だけ（項目でない語の残りは数えない）', () => {
    const text = 'SpO2 96%（室内気） BT 38.4℃ HR はやい CRT 3秒';
    const r = applyOrganization(
      answer({
        measurements: [
          { quote: 'SpO2 96%（室内気）', when: null, specimen: null },
          { quote: 'BT 38.4℃', when: null, specimen: null },
          { quote: 'HR はやい', when: null, specimen: null },
          { quote: 'CRT 3秒', when: null, specimen: null },
        ],
      }),
      { ...ctx, text },
    );
    expect(r.observations.map((o) => o.row.name)).toEqual(['SpO2', '体温']);
    expect(r.report).toEqual({ measurement: { unread: 2 } });
  });

  test('尿の検査と指された引用（specimen = urine）は、尿の項目の名前で読む。経過の文でも、検査結果の文でも（CD-023）', () => {
    const text = '【血ガス】pH 7.31 Lac 3.6\n【尿】\n比重 1.012、pH 5.5、白血球 1+\n【血算】WBC 18,200';
    const answer1 = answer({
      measurements: [
        { quote: 'pH 7.31 Lac 3.6', when: null, specimen: null },
        { quote: '比重 1.012、pH 5.5、白血球 1+', when: null, specimen: 'urine' },
        { quote: 'WBC 18,200', when: null, specimen: null },
      ],
    });
    const er = applyOrganization(answer1, { ...ctx, text, kind: 'er_note' });
    expect(er.observations.map((o) => o.row.name)).toEqual(['pH', 'Lac', '尿比重', '尿pH', '尿白血球反応', 'WBC']);
    const lab = applyOrganization(answer1, { ...ctx, text, kind: 'lab' });
    expect(lab.observations.map((o) => [o.row.name, o.origin])).toEqual([
      ['pH', 'parser'],
      ['Lac', 'parser'],
      ['尿比重', 'parser'],
      ['尿pH', 'parser'],
      ['尿白血球反応', 'parser'],
      ['WBC', 'parser'],
    ]);
    // 尿と指されなければ、これまでどおり（血液の項目として読む）
    const plain = applyOrganization(answer({}), { ...ctx, text, kind: 'lab' });
    expect(plain.observations.filter((o) => o.row.name === 'pH')).toHaveLength(2);
  });

  test('検査結果・バイタルの文：文全体を決定論で読む（AI の指した場所は使わない）', () => {
    const text = 'WBC 12.3 CRP 8.5';
    const r = applyOrganization(answer({ measurements: [{ quote: 'WBC 12.3', when: null, specimen: null }] }), { ...ctx, text, kind: 'lab' });
    expect(r.observations.map((o) => [o.row.name, o.origin])).toEqual([
      ['WBC', 'parser'],
      ['CRP', 'parser'],
    ]);
  });
});

describe('記載の種類と日時', () => {
  test('種類は、未分類の文だけ、AI の答えを使う', () => {
    expect(applyOrganization(answer({ kind: 'progress_note' }), { ...ctx, kind: 'unsorted' }).kind).toBe('progress_note');
    expect(applyOrganization(answer({ kind: 'nursing' }), ctx).kind).toBe('progress_note');
    expect(applyOrganization(answer({ kind: 'unsorted' }), { ...ctx, kind: 'unsorted' }).kind).toBe('unsorted');
  });

  test('未分類の文が「検査結果」になれば、文全体を決定論で読む', () => {
    const r = applyOrganization(answer({ kind: 'lab' }), { ...ctx, text: 'Na 128 K 3.1', kind: 'unsorted' });
    expect(r.observations.map((o) => [o.row.name, o.origin])).toEqual([
      ['Na', 'parser'],
      ['K', 'parser'],
    ]);
  });

  test('日時は、入れたときに分からなかったときだけ、文から読む（年のある日付だけ）', () => {
    const text = '2026/11/19 記載。解熱。';
    expect(applyOrganization(answer({ when: '2026/11/19' }), { ...ctx, text, at: null }).at).toBe('2026-11-19');
    expect(applyOrganization(answer({ when: '2026/11/19' }), { ...ctx, text }).at).toBe(ctx.at);
    const noYear = applyOrganization(answer({ when: '11/19' }), { ...ctx, text: '11/19 記載。', at: null });
    expect(noYear.at).toBeNull();
    expect(noYear.report).toEqual({ when: { when_unread: 1 } });
  });
});

describe('性質', () => {
  const letters = fc.constantFrom('a', 'あ', '熱', ' ', '\n', '1', '2', '.', '/', ':', 'K', 'B', 'T', '3', '8');
  const quote = fc.string({ unit: letters, maxLength: 12 });

  test('どんな答えでも、事実の文字は、保存した文の、その場所の字そのもの', () => {
    fc.assert(
      fc.property(fc.string({ unit: letters, minLength: 1, maxLength: 80 }), fc.array(quote, { maxLength: 6 }), (text, quotes) => {
        const r = applyOrganization(
          {
            ...empty,
            medications: quotes.map((q) => ({ name: q, dose: q, action: null, when: q })),
            events: quotes.map((q) => ({ kind: 'other' as const, title: q, when: null })),
            problems: quotes.map((q) => ({ name: q, status: 'problem' as const, activity: null })),
            measurements: quotes.map((q) => ({ quote: q, when: null, specimen: null })),
            segments: quotes.map((q) => ({ label: 'other' as const, start: q, when: q })),
          },
          { ...ctx, text },
        );
        const folded = (s: string) => s.normalize('NFKC');
        for (const m of r.medications) expect(folded(text.slice(m.start, m.end))).toBe(folded(m.name));
        for (const e of r.events) expect(folded(text.slice(e.start, e.end))).toBe(folded(e.title));
        for (const p of r.problems) expect(folded(text.slice(p.start, p.end))).toBe(folded(p.name));
        for (const o of r.observations) expect(text.slice(o.row.start, o.row.end)).toContain(o.row.valueText);
        let last = -1;
        for (const s of r.segments) {
          expect(s.start).toBeGreaterThan(last);
          expect(s.end).toBeLessThanOrEqual(text.length);
          last = s.start;
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('見方（保存しない）', () => {
  test('投薬の時間軸：同じ名前（全角半角・大小）をまとめ、日時の順', () => {
    const lines = medicationTimeline([
      { id: '3', sourceId: 's2', name: 'ＭＥＰＭ', doseText: null, action: 'stop', at: '2026-11-25' },
      { id: '1', sourceId: 's1', name: 'MEPM', doseText: '1g×3', action: 'start', at: '2026-11-18' },
      { id: '2', sourceId: 's1', name: 'アセトアミノフェン', doseText: null, action: null, at: null },
    ]);
    expect(lines.map((l) => [l.name, l.entries.map((e) => e.action)])).toEqual([
      ['MEPM', ['start', 'stop']],
      ['アセトアミノフェン', [null]],
    ]);
  });

  test('問題の一覧：番号を除いてまとめ、最初と最後の日時、いちばん新しい書かれ方', () => {
    expect(problemKey('#1 市中肺炎')).toBe(problemKey('＃２．市中肺炎'));
    const lines = problemList([
      { id: '1', sourceId: 's1', name: '#1 市中肺炎疑い', status: 'suspected', at: '2026-11-18' },
      { id: '2', sourceId: 's2', name: '#1 市中肺炎疑い', status: 'diagnosis', at: '2026-11-20' },
      { id: '3', sourceId: 's2', name: '#2 低Na血症', status: 'problem', at: '2026-11-20' },
    ]);
    expect(lines).toEqual([
      { name: '#1 市中肺炎疑い', mentions: 2, first: '2026-11-18', last: '2026-11-20', latestStatus: 'diagnosis' },
      { name: '#2 低Na血症', mentions: 1, first: '2026-11-20', last: '2026-11-20', latestStatus: 'problem' },
    ]);
  });

  test('できごと：日時の順。日時のないものは最後', () => {
    const list = eventTimeline([
      { id: '1', sourceId: 's', kind: 'test', title: 'b', at: null },
      { id: '2', sourceId: 's', kind: 'test', title: 'c', at: '2026-11-20' },
      { id: '3', sourceId: 's', kind: 'test', title: 'a', at: '2026-11-19T08:00' },
    ]);
    expect(list.map((e) => e.title)).toEqual(['a', 'c', 'b']);
  });
});

describe('同じ日の二重をたたむ（見せ方だけ）', () => {
  test('時刻のない投薬で、同じ日の時刻つきの同じ薬・同じ動きがあれば、たたむ。動きが違う・日が違う・時刻つきは、たたまない', () => {
    const med = (id: string, name: string, action: 'start' | 'continue' | 'stop' | null, at: string | null) => ({ id, sourceId: 's', name, doseText: null, action, at });
    const facts = [
      med('a', 'セフトリアキソン', 'start', '2026-11-21'),
      med('b', 'セフトリアキソン', 'start', '2026-11-21T11:05'),
      med('c', 'NE', 'continue', '2026-11-21'),
      med('d', 'NE', 'start', '2026-11-21T11:10'),
      med('e', 'ミノサイクリン', 'start', '2026-11-22'),
      med('f', 'ミノサイクリン', 'start', '2026-11-21T11:20'),
      med('g', 'ＡＲＢ', 'stop', null),
    ];
    expect([...foldedMedicationIds(facts)]).toEqual(['a']);
  });

  test('時刻のないできごとで、同じ日の時刻つきの、同じ種類・題の頭の字が同じものがあれば、たたむ', () => {
    const ev = (id: string, kind: 'test' | 'procedure', title: string, at: string | null) => ({ id, sourceId: 's', kind, title, at });
    const facts = [
      ev('a', 'test', '血液培養2セット：提出済み', '2026-11-21'),
      ev('b', 'test', '血液培養2セット・尿培養（提出済み、10:45）', '2026-11-21T10:45'),
      ev('c', 'test', '胸部X線', '2026-11-21'),
      ev('d', 'procedure', '血液培養2セットを採取', '2026-11-21T10:40'),
    ];
    expect([...foldedEventIds(facts)]).toEqual(['a']);
  });
});

describe('文に書かれた時刻を、自動で記録の時刻にする（2026-11-21 の本人の決定）', () => {
  const text = ['初期評価（10:44）', 'BP 76/40、HR 36', '静脈血ガス（10:50）', 'K 7.8 mEq/L、pH 7.19', '10:55 アトロピン 0.5 mg を静注', 'A) 高K血症'].join('\n');
  const day = { ...ctx, text, kind: 'er_note' as const, at: '2026-11-21', encounterStart: '2026-11-21T10:42' };
  const ans = answer({
    when: '10:44',
    segments: [
      { label: 'objective', start: '初期評価（10:44）', when: '10:44' },
      { label: 'labs', start: '静脈血ガス（10:50）', when: '10:50' },
      { label: 'assessment', start: 'A) 高K血症', when: null },
    ],
    measurements: [
      { quote: 'BP 76/40、HR 36', when: null, specimen: null },
      { quote: 'K 7.8 mEq/L、pH 7.19', when: null, specimen: null },
    ],
    medications: [{ name: 'アトロピン', dose: '0.5 mg', action: 'start', when: '10:55' }],
  });

  test('区切りの時刻：区切りの中の、自分の日時のない事実は、その時刻。自分の日時があれば、そちら', () => {
    const r = applyOrganization(ans, day);
    expect(r.observations.map((o) => [o.row.name, o.at])).toEqual([
      ['収縮期血圧', '2026-11-21T10:44'],
      ['拡張期血圧', '2026-11-21T10:44'],
      ['心拍数', '2026-11-21T10:44'],
      ['K', '2026-11-21T10:50'],
      ['pH', '2026-11-21T10:50'],
    ]);
    expect(r.medications.map((m) => m.at)).toEqual(['2026-11-21T10:55']);
  });

  test('日だけで入れた記載は、文の同じ日の時刻を足す。違う日・時刻のある記載・読めない時刻は変えない', () => {
    expect(applyOrganization(ans, day).at).toBe('2026-11-21T10:44');
    expect(applyOrganization(ans, { ...day, at: '2026-11-21T09:00' }).at).toBe('2026-11-21T09:00');
    const otherDay = applyOrganization(answer({ when: '11/20 23:00' }), { ...day, text: '11/20 23:00 来院' });
    expect(otherDay.at).toBe('2026-11-21');
    const unread = applyOrganization(answer({ when: '初期評価' }), day);
    expect(unread.at).toBe('2026-11-21');
    expect(unread.report).toEqual({ when: { when_unread: 1 } });
  });

  test('検査結果の文（文全体を読む）でも、区切りの時刻を使う', () => {
    const r = applyOrganization(answer({ segments: [{ label: 'labs', start: '静脈血ガス（10:50）', when: '10:50' }] }), { ...day, kind: 'lab' });
    expect(r.observations.filter((o) => o.row.name === 'K').map((o) => o.at)).toEqual(['2026-11-21T10:50']);
    expect(r.observations.filter((o) => o.row.name === '心拍数').map((o) => o.at)).toEqual(['2026-11-21']);
  });
});

// 入院時記載の標準の形：問題の一覧（#1〜#3）のあとに、問題ごとの見出しと A・P が続く。見出しの字は、一覧の字と同じ
describe('問題の一覧と、同じ字の「#問題」の見出し', () => {
  const ADM = [
    '【プロブレムリスト】',
    '#1 尿路感染症',
    '#2 脱水',
    '#3 高血圧症',
    '',
    '#1 尿路感染症',
    'A）発熱と膿尿。',
    'P）抗菌薬Xを開始。',
    '#2 脱水',
    'A）経口摂取の低下。',
    'P）補液。',
    '#3 高血圧症',
    'A）血圧は低め。',
    'P）降圧薬Yは中止。',
  ].join('\n');
  const admCtx: OrganizeContext = { text: ADM, kind: 'admission_note', at: '2026-11-16T17:30', encounterStart: '2026-11-16' };
  const admAnswer = (segments: OrganizeAnswer['segments']): OrganizeAnswer =>
    answer({
      segments,
      medications: [
        { name: '抗菌薬X', dose: null, action: 'start', when: null },
        { name: '降圧薬Y', dose: null, action: 'stop', when: null },
      ],
      problems: [
        { name: '#1 尿路感染症', status: 'problem', activity: null },
        { name: '#2 脱水', status: 'problem', activity: null },
        { name: '#3 高血圧症', status: 'problem', activity: null },
      ],
    });
  const heading = (n: string) => ADM.lastIndexOf(n);

  const check = (r: ReturnType<typeof applyOrganization>) => {
    // 見出しの区切りは、一覧ではなく、見出しの行から
    const headings = r.segments.filter((g) => g.label === 'problem_heading');
    expect(headings.map((g) => g.start)).toEqual([heading('#1 尿路感染症'), heading('#2 脱水'), heading('#3 高血圧症')]);
    // 問題の場所も、見出しの行
    expect(r.problems.map((p) => p.start)).toEqual([heading('#1 尿路感染症'), heading('#2 脱水'), heading('#3 高血圧症')]);
    // 問題ごとの範囲には、その問題の A・P の薬だけが入る（別の問題の薬を結びつけない）
    const segs = r.segments.map((g) => ({ ...g, sourceId: 's' }));
    const meds = r.medications.map((m, i) => ({ ...m, id: String(i), sourceId: 's' }));
    const mention = (i: number) => {
      const p = r.problems[i];
      if (p === undefined) throw new Error('問題がない');
      return { id: String(i), sourceId: 's', threadId: null, name: p.name, status: p.status, activity: p.activity, at: p.at, start: p.start, end: p.end };
    };
    expect(relatedFacts([mention(0)], segs, { observations: [], medications: meds, events: [] }).medicationNames).toEqual(['抗菌薬X']);
    expect(relatedFacts([mention(1)], segs, { observations: [], medications: meds, events: [] }).medicationNames).toEqual([]);
    expect(relatedFacts([mention(2)], segs, { observations: [], medications: meds, events: [] }).medicationNames).toEqual(['降圧薬Y']);
    // 一覧は、見出しの区切りに入らない
    expect(problemBlocks([mention(0)], segs)).toEqual([{ sourceId: 's', start: heading('#1 尿路感染症'), end: heading('#2 脱水') }]);
  };

  test('見出しと A・P の区切りがあるとき', () => {
    check(
      applyOrganization(
        admAnswer([
          { label: 'other', start: '【プロブレムリスト】', when: null },
          { label: 'problem_heading', start: '#1 尿路感染症', when: null },
          { label: 'assessment', start: 'A）発熱', when: null },
          { label: 'plan', start: 'P）抗菌薬X', when: null },
          { label: 'problem_heading', start: '#2 脱水', when: null },
          { label: 'assessment', start: 'A）経口', when: null },
          { label: 'plan', start: 'P）補液', when: null },
          { label: 'problem_heading', start: '#3 高血圧症', when: null },
          { label: 'assessment', start: 'A）血圧', when: null },
          { label: 'plan', start: 'P）降圧薬Y', when: null },
        ]),
        admCtx,
      ),
    );
  });

  test('見出しだけが続くとき（A・P の区切りがない）も、後ろから置き直す', () => {
    const r = applyOrganization(
      admAnswer([
        { label: 'other', start: '【プロブレムリスト】', when: null },
        { label: 'problem_heading', start: '#1 尿路感染症', when: null },
        { label: 'problem_heading', start: '#2 脱水', when: null },
        { label: 'problem_heading', start: '#3 高血圧症', when: null },
      ]),
      admCtx,
    );
    expect(r.segments.filter((g) => g.label === 'problem_heading').map((g) => g.start)).toEqual([heading('#1 尿路感染症'), heading('#2 脱水'), heading('#3 高血圧症')]);
    expect(r.problems.map((p) => p.start)).toEqual([heading('#1 尿路感染症'), heading('#2 脱水'), heading('#3 高血圧症')]);
  });

  test('一覧だけで見出しのない文は、これまでどおり一覧の場所', () => {
    const LIST = ['#1 尿路感染症', '#2 脱水', 'A/P）補液と抗菌薬X。'].join('\n');
    const r = applyOrganization(
      answer({ segments: [{ label: 'assessment_plan', start: 'A/P）', when: null }], problems: [{ name: '#1 尿路感染症', status: 'problem', activity: null }] }),
      { ...admCtx, text: LIST },
    );
    expect(r.problems.map((p) => p.start)).toEqual([0]);
  });
});

describe('行頭の時刻と、日をまたいだ記載', () => {
  test('バイタルの文：行頭の時刻が、その行の値の時刻（区切りの時刻・記載の日時より先）', () => {
    const VITAL = ['16:00 BT 39.0 HR 112', '18:00 BT 38.6 HR 104', '尿量 420mL'].join('\n');
    const r = applyOrganization(answer({ when: '16:00' }), { text: VITAL, kind: 'vital', at: '2026-11-16', encounterStart: '2026-11-16' });
    expect(r.at).toBe('2026-11-16T16:00');
    expect(r.observations.map((o) => [o.row.nameRaw, o.at])).toEqual([
      ['BT', '2026-11-16T16:00'],
      ['HR', '2026-11-16T16:00'],
      ['BT', '2026-11-16T18:00'],
      ['HR', '2026-11-16T18:00'],
      ['尿量', '2026-11-16T16:00'],
    ]);
  });

  test('AI が日時を返さなかった値・できごとも、行頭の時刻にする。行頭が日だけで同じ日なら、時刻のある日時のまま', () => {
    const NOTE2 = ['11/17（入院2日目）9:30 回診', 'O) BT 37.6', '8:00 細菌検査室より連絡'].join('\n');
    const r = applyOrganization(
      answer({ measurements: [{ quote: 'BT 37.6', when: null, specimen: null }], events: [{ kind: 'other', title: '細菌検査室より連絡', when: null }] }),
      { text: NOTE2, kind: 'progress_note', at: '2026-11-17T09:30', encounterStart: '2026-11-16' },
    );
    expect(r.observations.map((o) => o.at)).toEqual(['2026-11-17T09:30']);
    expect(r.events.map((e) => e.at)).toEqual(['2026-11-17T08:00']);
  });

  test('日をまたいだ場所（本人が確かめた）より後ろの時刻だけの言い方は、翌日', () => {
    const NURSE = ['夜勤帯の記録', '23:30 不穏あり。センサーマットを設置。', '0:15 報告。', '3:00 BT 37.4 HR 88'].join('\n');
    const base = { text: NURSE, kind: 'nursing' as const, at: '2026-11-16', encounterStart: '2026-11-16' };
    const ans = answer({
      when: '23:30',
      events: [{ kind: 'other', title: 'センサーマットを設置', when: '23:30' }],
      measurements: [{ quote: 'BT 37.4 HR 88', when: '3:00', specimen: null }],
    });
    const same = applyOrganization(ans, base);
    expect(same.observations.map((o) => o.at)).toEqual(['2026-11-16T03:00', '2026-11-16T03:00']);
    const next = applyOrganization(ans, { ...base, nextDayFrom: NURSE.indexOf('0:15') });
    expect(next.at).toBe('2026-11-16T23:30');
    expect(next.events.map((e) => e.at)).toEqual(['2026-11-16T23:30']);
    expect(next.observations.map((o) => o.at)).toEqual(['2026-11-17T03:00', '2026-11-17T03:00']);
  });
});

describe('同じ日時の事実の並び', () => {
  test('同じ記載の中では、書かれた順（id の順ではない）。「薬ごとの最後の記載」は、あとに書かれた中止', () => {
    const at = '2026-11-16T17:30';
    // id は、同じミリ秒の中では乱数の順：書かれた順と逆になりうる
    const lines = medicationTimeline([
      { id: 'B', sourceId: 's1', name: 'アジルサルタン', doseText: null, action: 'stop', at, start: 900 },
      { id: 'A', sourceId: 's1', name: 'アジルサルタン', doseText: '20mg 1錠分1', action: 'continue', at, start: 300 },
    ]);
    expect(lines[0]?.entries.map((e) => e.action)).toEqual(['continue', 'stop']);
  });
  test('別の記載どうしは、入れた順', () => {
    const at = '2026-11-16';
    const lines = medicationTimeline([
      { id: 'X2', sourceId: 's2', name: '薬A', doseText: null, action: 'stop', at, start: 0 },
      { id: 'X1', sourceId: 's1', name: '薬A', doseText: null, action: 'start', at, start: 50 },
    ]);
    expect(lines[0]?.entries.map((e) => e.action)).toEqual(['start', 'stop']);
  });
});
