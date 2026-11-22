import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  backingWith,
  checkDocument,
  DOC_MATERIAL_MAX,
  DOC_SECTIONS,
  DOC_TYPES,
  DOC_TYPES_FOR,
  defaultDocDay,
  type DocumentInput,
  documentMaterial,
  documentMessage,
  documentText,
  DocumentNew,
  markNumbers,
  type RefSource,
  sectionsFit,
  type ThreadMention,
  threadViews,
} from '../src/index.ts';

// 架空症例（synthetic）
const ER = '【主訴】発熱\n【現病歴】3日前から発熱\nBT 38.9 SpO2 93%\n【評価】肺炎疑い\n【方針】入院';
const ADM = '#1 市中肺炎\nA) 右下葉の肺炎\nP) セフトリアキソン 2g 開始';
const D2 = '#1 市中肺炎\nS) 咳は軽減\nO) CRP 6.8\nA) 抗菌薬に反応\nP) 継続';
const D3 = '#1 市中肺炎\nS) 解熱\nA) 改善\nP) 内服へ';
const seg = (sourceId: string, text: string, labels: [string, string][]) =>
  labels.map(([label, start], i) => {
    const next = labels[i + 1];
    return { sourceId, label: label as never, start: text.indexOf(start), end: next === undefined ? text.length : text.indexOf(next[1]) };
  });
const mention = (id: string, sourceId: string, text: string, when: string): ThreadMention => ({ id, sourceId, threadId: 'TA', name: '#1 市中肺炎', status: 'problem', activity: null, at: when, start: text.indexOf('#1'), end: text.indexOf('#1') + 7 });

function input(type: DocumentInput['type'], day: string): DocumentInput {
  const mentions = [mention('a', 's1', ADM, '2026-11-17T23:00'), mention('b', 's2', D2, '2026-11-18T09:00'), mention('c', 's3', D3, '2026-11-19T09:00')];
  return {
    type,
    day,
    patient: { age: 72, ageOn: '2026-11-17', sex: 'male' },
    encounter: { id: 'e1', kind: 'inpatient', start: '2026-11-17T22:00', end: null },
    encounters: [
      { id: 'e0', kind: 'er', start: '2026-11-17T20:00', end: '2026-11-17T22:00' },
      { id: 'e1', kind: 'inpatient', start: '2026-11-17T22:00', end: null },
    ],
    sources: [
      { id: 's0', encounterId: 'e0', kind: 'er_note', authorRole: 'self', at: '2026-11-17T20:30', text: ER },
      { id: 's1', encounterId: 'e1', kind: 'admission_note', authorRole: 'self', at: '2026-11-17T23:00', text: ADM },
      { id: 's2', encounterId: 'e1', kind: 'progress_note', authorRole: 'self', at: '2026-11-18T09:00', text: D2 },
      { id: 's3', encounterId: 'e1', kind: 'progress_note', authorRole: 'self', at: '2026-11-19T09:00', text: D3 },
    ],
    segments: [
      ...seg('s1', ADM, [
        ['problem_heading', '#1'],
        ['assessment', 'A)'],
        ['plan', 'P)'],
      ]),
      ...seg('s2', D2, [
        ['problem_heading', '#1'],
        ['subjective', 'S)'],
        ['objective', 'O)'],
        ['assessment', 'A)'],
        ['plan', 'P)'],
      ]),
    ],
    threads: threadViews([{ id: 'TA', displayName: null, mergedInto: null }], mentions).threads,
    observations: [
      { encounterId: 'e0', at: '2026-11-17T20:30', name: '体温', nameRaw: 'BT', kind: 'vital', valueText: '38.9', unit: '℃' },
      { encounterId: 'e1', at: '2026-11-18T09:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', valueText: '6.8', unit: 'mg/dL' },
    ],
    medications: [{ id: 'm1', sourceId: 's1', encounterId: 'e1', name: 'セフトリアキソン', doseText: '2g', action: 'start', at: '2026-11-17T23:00', start: ADM.indexOf('セフ') }],
    events: [{ encounterId: 'e1', kind: 'procedure', title: '血液培養', at: '2026-11-17T23:10' }],
    apNotes: [],
  };
}

describe('種類と見出し', () => {
  test('どの種類にも見出しがあり、見出しの key は重ならない。受診の種類ごとに、出せる種類がある', () => {
    for (const t of DOC_TYPES) {
      const keys = DOC_SECTIONS[t].map((d) => d.key);
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect([...new Set([...DOC_TYPES_FOR.er, ...DOC_TYPES_FOR.outpatient, ...DOC_TYPES_FOR.inpatient])].sort()).toEqual([...DOC_TYPES].sort());
  });
  test('既定の日：入院時記録は入院の日、退院サマリーは終わりの日、選んだ日があればその日', () => {
    const e = { id: 'e1', kind: 'inpatient' as const, start: '2026-11-17T22:00', end: '2026-11-25T10:00' };
    expect(defaultDocDay('admission', e, '2026-11-20', null)).toBe('2026-11-17');
    expect(defaultDocDay('discharge_summary', e, '2026-11-20', null)).toBe('2026-11-25');
    expect(defaultDocDay('progress', e, '2026-11-20', null)).toBe('2026-11-20');
    expect(defaultDocDay('progress', e, '2026-11-20', '2026-11-18')).toBe('2026-11-18');
  });
});

describe('資料（documentMaterial）', () => {
  test('入院時記録：入院の日までの記載と、直前の救急の受診の記載。後の日の記載は入れない', () => {
    const m = documentMaterial(input('admission', '2026-11-17'));
    expect(m.records.map((r) => r.sourceId)).toEqual(['s0', 's1']);
    expect(JSON.stringify(m.payload)).toContain('3日前から発熱');
    expect(JSON.stringify(m.payload)).not.toContain('咳は軽減');
  });
  test('プログレスノート：その日と前の日の記載だけ。バイタルはその日だけ', () => {
    const m = documentMaterial(input('progress', '2026-11-19'));
    expect(m.records.map((r) => r.sourceId)).toEqual(['s2', 's3']);
    expect((m.payload['vitals'] as unknown[]).length).toBe(0);
  });
  test('退院サマリー：入院の全体（救急の受診を含む）と、投薬・できごと。問題の名前を、検索語として持つ', () => {
    const m = documentMaterial(input('discharge_summary', '2026-11-19'));
    expect(m.records.map((r) => r.sourceId)).toEqual(['s0', 's1', 's2', 's3']);
    const text = JSON.stringify(m.payload);
    expect(text).toContain('セフトリアキソン');
    expect(text).toContain('血液培養');
    expect(m.problemNames).toEqual(['#1 市中肺炎']);
  });
  test('長い資料は、古い経過の記載を評価と方針の部分だけにし、それでも長ければ古いものから落とす（数を返す）', () => {
    const base = input('discharge_summary', '2026-11-19');
    const long = `${D2}\n${'メモ'.repeat(DOC_MATERIAL_MAX)}`;
    const m = documentMaterial({ ...base, sources: base.sources.map((x) => (x.id === 's2' ? { ...x, text: long } : x)), segments: [...base.segments.filter((g) => g.sourceId !== 's2'), ...seg('s2', long, [['problem_heading', '#1'], ['subjective', 'S)'], ['objective', 'O)'], ['assessment', 'A)'], ['plan', 'P)']]).map((g, i, all) => (i === all.length - 1 ? { ...g, end: long.indexOf('メモ') } : g))] });
    expect(m.shortened).toBe(1);
    const r2 = m.records.find((r) => r.sourceId === 's2');
    expect(r2?.text).toContain('A) 抗菌薬に反応');
    expect(r2?.text).not.toContain('メモメモ');
  });
  test('照らし合わせの数：記録・値・薬の数と、日時・病日の数', () => {
    const m = documentMaterial(input('discharge_summary', '2026-11-19'));
    expect(m.backing.body).toContain('38.9');
    expect(m.backing.body).toContain('6.8');
    expect(m.backing.body).toContain('2');
    expect(m.backing.when).toContain('3');
    const withRefs = backingWith(m.backing, [{ text: '通常 7日間' }]);
    expect(withRefs.body).toContain('7');
  });
  test('送る文：資料・出典・相談のときは、いまの記載とやりとりと問い', () => {
    const m = documentMaterial(input('progress', '2026-11-19'));
    const ref: RefSource = { id: 'B1', kind: 'book', problem: null, text: '肺炎の治療', at: null, day: null, label: '内科学 p.10', ref: { k: 'book', title: '内科学', page: 'p.10', path: null } };
    const msg = JSON.parse(documentMessage(m, [ref], { sections: [{ key: 's', text: '解熱' }], history: [], instruction: '短くして' })) as Record<string, unknown>;
    expect(msg['instruction']).toBe('短くして');
    expect((msg['references'] as { id: string }[])[0]?.id).toBe('B1');
    expect((msg['current'] as { heading: string }[])[0]?.heading).toBe('S');
  });
});

describe('答えの整え（checkDocument）', () => {
  test('見出しは決めた順。答えにない見出しは空のまま。知らない見出しは数える。識別情報の形は伏せる。根拠は実在するものだけ', () => {
    const m = documentMaterial(input('progress', '2026-11-19'));
    const phone = ['0', '3', '-', '1234', '-', '5678'].join('');
    const checked = checkDocument(
      {
        sections: [
          { key: 'ap', text: '#1 市中肺炎\nA) 改善\nP) 内服へ', refs: ['R2', 'X9'] },
          { key: 's', text: `解熱 ${phone}`, refs: [] },
          { key: 'zzz', text: '何か', refs: [] },
        ],
      },
      m,
      [],
    );
    expect(checked.sections.map((x) => x.key)).toEqual(['s', 'o', 'ap']);
    expect(checked.sections[1]?.text).toBe('');
    expect(checked.sections[0]?.text).not.toContain(phone);
    expect(checked.notes.shapes.phone).toBe(1);
    expect(checked.notes.unknownSections).toBe(1);
    expect(checked.notes.unknownRefs).toBe(1);
    expect(checked.sections[2]?.refs).toEqual([{ k: 'record', sourceId: 's3', start: 0, end: D3.length }]);
    expect(documentText('progress', checked.sections)).toContain('【A/P】\n#1 市中肺炎');
  });
});

describe('数の印（markNumbers）', () => {
  const backing = { body: ['38.9', '6.8', '2', '72'], when: ['2026', '11', '17', '18', '1', '3'] };
  const marked = (text: string) => markNumbers(text, backing).map((x) => text.slice(x.start, x.end));
  test('資料にない数に印を付ける。資料にある数・日付と病日・#番号・行頭の番号・名前の中の1桁には付けない', () => {
    expect(marked('BT 38.9℃、CRP 6.8、セフトリアキソン 2g')).toEqual([]);
    expect(marked('セフトリアキソン 4g を 7日間')).toEqual(['4', '7']);
    expect(marked('11/17 入院、第3病日に解熱')).toEqual([]);
    expect(marked('#1 市中肺炎\n1) 抗菌薬\nSpO2 は保たれた')).toEqual([]);
    expect(marked('CRP 6.80')).toEqual([]);
    expect(marked('CRP ６.８')).toEqual([]);
    expect(marked('Cr 1.4')).toEqual(['1.4']);
  });
  test('性質：資料の本文の数だけでできた文には、印が付かない', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('38.9', '6.8', '2', '72'), { maxLength: 8 }), (nums) => {
        expect(markNumbers(nums.map((n) => `値 ${n}`).join('、'), backing)).toEqual([]);
      }),
    );
  });
});

describe('残す形', () => {
  test('見出しは決めたものだけ・重ならない・空だけは残さない', () => {
    expect(sectionsFit('progress', [{ key: 's', text: 'a' }])).toBe(true);
    expect(sectionsFit('progress', [{ key: 'zzz', text: 'a' }])).toBe(false);
    expect(sectionsFit('progress', [{ key: 's', text: 'a' }, { key: 's', text: 'b' }])).toBe(false);
    expect(sectionsFit('progress', [{ key: 's', text: ' ' }])).toBe(false);
    expect(DocumentNew.safeParse({ type: 'progress', day: '2026-11-19', sections: [{ key: 's', text: 'a', refs: [] }], origin: 'ai', edited: false }).success).toBe(true);
    expect(DocumentNew.safeParse({ type: 'progress', day: '2026-11-19', sections: [{ key: 's', text: 'a', refs: [] }], origin: 'ai_edited', edited: false }).success).toBe(false);
  });
});

describe('AI のプロブレムリストは、いまの記載にだけ渡す（CA-057）', () => {
  test('その日より後の記録があるとき（過去の日の記載）は渡さない', () => {
    const list = [{ name: '市中肺炎', certainty: 'diagnosis', activity: 'active', since: null }];
    const past = documentMaterial({ ...input('admission', '2026-11-17'), problemList: list });
    expect(past.payload['problemList']).toEqual([]);
    const now = documentMaterial({ ...input('discharge_summary', '2026-11-19'), problemList: list });
    expect(now.payload['problemList']).toEqual([{ name: '市中肺炎', certainty: 'diagnosis', activity: 'active', since: null }]);
  });
});
