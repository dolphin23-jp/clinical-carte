// 段K8（CA-070）：受け持ちを横断する検索。決定論。文はすべて架空（synthetic）。
// 電話・メールの形は、ソースに直接書かず、実行時に組み立てる（phi-guard）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { findMatches, SEARCH_HIT_MAX, SEARCH_HITS_PER_PATIENT, SEARCH_QUERY_MAX, type SearchInput, searchKey, searchQueryProblem, searchRecords, SearchRequest, valueNamesOf } from '../src/index.ts';

const P1 = { id: 'p1', age: 78, ageOn: '2026-11-18', sex: 'female' as const };
const P2 = { id: 'p2', age: 64, ageOn: '2026-11-19', sex: 'male' as const };
const T1 = 'S) 発熱あり。\nA) #1 腎盂腎炎：ＣＴＲＸ 2g で開始。\nP) 血培の結果を待つ。';
const T2 = '入院時 Cr 1.8。Cr 2.1 と上昇。セフトリアキソン 開始。';

const base = (): SearchInput => ({
  patients: [P1, P2],
  encounters: [
    { id: 'e1', patientId: 'p1', kind: 'inpatient', start: '2026-11-18T10:00', end: null },
    { id: 'e2', patientId: 'p2', kind: 'inpatient', start: '2026-11-19T10:00', end: null },
  ],
  sources: [
    { id: 's1', patientId: 'p1', encounterId: 'e1', kind: 'progress_note', at: '2026-11-19T09:00', text: T1 },
    { id: 's2', patientId: 'p2', encounterId: 'e2', kind: 'progress_note', at: '2026-11-20T09:00', text: T2 },
  ],
  medications: [{ id: 'm1', sourceId: 's1', start: T1.indexOf('ＣＴＲＸ'), end: T1.indexOf('ＣＴＲＸ') + 4, name: 'ＣＴＲＸ', excluded: false }],
  events: [{ id: 'v1', sourceId: 's1', start: T1.indexOf('血培'), end: T1.indexOf('血培') + 2, title: '血培', excluded: true }],
  course: [{ id: 'c1', sourceId: 's2', start: 0, end: 8, summary: '入院時に腎機能の悪化を指摘' }],
  observations: [
    { id: 'o1', sourceId: 's2', start: T2.indexOf('Cr 1.8'), end: T2.indexOf('Cr 1.8') + 6, name: 'Cr', excluded: false, at: '2026-11-19' },
    { id: 'o2', sourceId: 's2', start: T2.indexOf('Cr 2.1'), end: T2.indexOf('Cr 2.1') + 6, name: 'Cr', excluded: false, at: '2026-11-20' },
  ],
  problems: [{ id: 'q1', sourceId: 's1', start: T1.indexOf('#1'), end: T1.indexOf('#1') + 7, name: '#1 腎盂腎炎' }],
  typedThreads: [],
  listItems: [
    { patientId: 'p1', key: 'k1', name: '閉塞性腎盂腎炎' },
    { patientId: 'p2', key: 'k2', name: '急性腎障害' },
  ],
});

describe('比べ方', () => {
  test('NFKC・英字の小文字・空白を除いた形で比べ、場所は元の字に戻す', () => {
    const text = 'Ａ）ＣＴＲＸ　２ｇ';
    const m = findMatches(text, 'ctrx2g');
    expect(m).toHaveLength(1);
    expect(text.slice(m[0]?.start, m[0]?.end)).toBe('ＣＴＲＸ　２ｇ');
    expect(findMatches('BT 38.2℃', '38.2°c').map((x) => 'BT 38.2℃'.slice(x.start, x.end))).toEqual(['38.2℃']);
    expect(searchKey(' A b　C ')).toBe('abc');
  });
  test('性質：当たりの場所の字をそろえると、問いをそろえた形を含む', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ minLength: 1, maxLength: 4 }), (text, q) => {
        for (const m of findMatches(text, q)) {
          expect(m.start).toBeGreaterThanOrEqual(0);
          expect(m.end).toBeLessThanOrEqual(text.length);
          expect(searchKey(text.slice(m.start, m.end))).toContain(searchKey(q));
        }
      }),
    );
  });
  test('値の項目の名前は、名前の表の正規の名前・別名で引く', () => {
    expect(valueNamesOf('cr')).toEqual(['Cr']);
    expect(valueNamesOf('ＢＷ')).toEqual(['体重']);
    expect(valueNamesOf('腎盂腎炎')).toEqual([]);
  });
});

describe('問いの確かめ', () => {
  test('識別情報の形・空・長すぎる問いは送らない', () => {
    const phone = ['090', '1234', '5678'].join('-');
    expect(searchQueryProblem(phone)).toBe('shape');
    expect(searchQueryProblem(['a', 'example.test'].join('@'))).toBe('shape');
    expect(searchQueryProblem('   ')).toBe('empty');
    expect(searchQueryProblem('x'.repeat(SEARCH_QUERY_MAX + 1))).toBe('long');
    expect(searchQueryProblem('腎盂腎炎')).toBeNull();
    expect(SearchRequest.safeParse({ q: 'x'.repeat(SEARCH_QUERY_MAX + 1) }).success).toBe(false);
    expect(SearchRequest.safeParse({ q: 'a', extra: 1 }).success).toBe(false);
  });
});

describe('受け持ちから探す', () => {
  test('文・問題・AI のプロブレムリストから引き、患者ごとにまとめる（回診リストの順）', () => {
    const r = searchRecords(base(), '腎盂腎炎');
    expect(r.patients.map((p) => p.patientId)).toEqual(['p1']);
    const hits = r.patients[0]?.hits ?? [];
    // 問題の記載の字は「記録に書かれた問題」にまとめ、同じ字の「記載の文」は重ねない
    expect(hits.map((h) => h.kind).sort()).toEqual(['list', 'problem']);
    const problem = hits.find((h) => h.kind === 'problem');
    expect(problem?.match).toBe('腎盂腎炎');
    expect(problem?.anchor).toEqual({ sourceId: 's1', start: T1.indexOf('腎盂腎炎') });
    expect(hits.find((h) => h.kind === 'list')?.anchor).toBeNull();
    expect(r.total).toBe(2);
  });

  test('薬の名前（全角も）。外したできごとは、事実としては引かず、文の当たりにだけ残る', () => {
    const med = searchRecords(base(), 'ctrx');
    expect(med.patients[0]?.hits.map((h) => h.kind)).toEqual(['medication']);
    const ev = searchRecords(base(), '血培');
    expect(ev.patients[0]?.hits.map((h) => h.kind)).toEqual(['source']);
  });

  test('値の項目は、患者・項目ごとに、いちばん新しい値を代表にし数を添える。経過の出来事の要約からも引く', () => {
    const r = searchRecords(base(), 'CR');
    const hits = r.patients.find((p) => p.patientId === 'p2')?.hits ?? [];
    const value = hits.find((h) => h.kind === 'value');
    expect(value?.count).toBe(2);
    expect(value?.match).toBe('Cr 2.1');
    // 値の場所の字は、値の当たりにまとめる（同じ字の「記載の文」を重ねない）
    expect(hits.filter((h) => h.kind === 'source')).toEqual([]);
    const c = searchRecords(base(), '腎機能');
    expect(c.patients[0]?.hits.map((h) => [h.kind, h.match, h.anchor?.sourceId])).toEqual([['course', '腎機能', 's2']]);
    // 短い字は切っていない（画面は「…」を付けない）。長い文の途中は、前後を切ったと返す
    expect(c.patients[0]?.hits[0]).toMatchObject({ clippedBefore: false, clippedAfter: false });
    const long = searchRecords({ ...base(), sources: [{ ...(base().sources[0] as SearchInput['sources'][number]), text: `${'あ'.repeat(40)}目印${'い'.repeat(40)}` }] }, '目印');
    expect(long.patients[0]?.hits[0]).toMatchObject({ clippedBefore: true, clippedAfter: true, match: '目印' });
  });

  test('返す字は、保存した字（文・名前・要約）からだけ切り出す', () => {
    const input = base();
    const r = searchRecords(input, '開始');
    const stored = [...input.sources.map((s) => s.text), ...input.course.map((c) => c.summary), ...input.listItems.map((i) => i.name)];
    for (const p of r.patients) for (const h of p.hits) expect(stored.some((t) => t.includes(`${h.before}${h.match}${h.after}`))).toBe(true);
  });

  test('上限：患者ごとと全体。数は、返さなかった分も数える', () => {
    const many: SearchInput = {
      ...base(),
      patients: Array.from({ length: 8 }, (_, i) => ({ ...P1, id: `q${String(i)}` })),
      encounters: [],
      sources: Array.from({ length: 8 }, (_, i) => ({ id: `t${String(i)}`, patientId: `q${String(i)}`, encounterId: 'e', kind: 'memo' as const, at: null, text: '発熱。'.repeat(20) })),
      medications: [],
      events: [],
      course: [],
      observations: [],
      problems: [],
      listItems: [],
    };
    const r = searchRecords(many, '発熱');
    expect(r.total).toBe(160);
    expect(r.shown).toBe(SEARCH_HIT_MAX);
    expect(r.patients.every((p) => p.hits.length <= SEARCH_HITS_PER_PATIENT && p.total === 20)).toBe(true);
    expect(r.patients.reduce((a, p) => a + p.hits.length, 0)).toBe(SEARCH_HIT_MAX);
  });
});
