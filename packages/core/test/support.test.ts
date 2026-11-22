// AI の臨床支援（段K5。CA-059・CA-064）：資料・確かめ・組み直しの印。AI の答えは試験の代役。架空（synthetic）。
import { describe, expect, test } from 'vitest';

import { checkSupport, type ListItem, listBasis, newDoseNumbers, type RefSource, type SupportAnswer, type SupportInput, supportBasis, supportMaterial, supportMessage } from '../src/index.ts';

const item = (over: Partial<ListItem>): ListItem => ({
  key: 'k1',
  name: '発熱',
  certainty: 'problem',
  activity: 'active',
  threadIds: ['th1'],
  course: [],
  basis: '3日前からの発熱',
  since: '2026-11-17T17:00',
  self: [],
  hidden: false,
  ...over,
});

const INPUT: SupportInput = {
  patient: { age: 72, ageOn: '2026-11-20', sex: 'male' },
  today: '2026-11-21',
  encounter: { kind: 'inpatient', start: '2026-11-20T10:00', end: null },
  asOf: '2026-11-21T09:00',
  list: [
    item({ key: 'k1', name: '発熱', certainty: 'problem', course: [{ sourceId: 's1', start: 10 }] }),
    item({ key: 'k2', name: '外した問題', hidden: true }),
    item({ key: 'k3', name: '2型糖尿病（既往）', certainty: 'diagnosis', activity: 'inactive', threadIds: [] }),
    item({ key: 'k4', name: '市中肺炎', certainty: 'diagnosis', threadIds: ['th2'] }),
  ],
  threads: [
    { id: 'th1', name: '#1 発熱', status: 'problem', group: 'current', first: '2026-11-20T10:30', last: '2026-11-21T09:00', lastNote: 'A) 肺炎を疑う' },
    { id: 'th2', name: '#2 市中肺炎', status: 'diagnosis', group: 'current', first: '2026-11-21T09:00', last: '2026-11-21T09:00', lastNote: 'P) セフトリアキソン 2g 継続' },
  ],
  course: [{ sourceId: 's1', start: 10, at: '2026-11-17T17:00', atApprox: '夕方ごろ', category: 'onset', summary: '悪寒・発熱が出現' }],
  observations: [
    { id: 'o1', at: '2026-11-20T11:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', value: 12.3, comparator: null, valueText: '12.3', unit: 'mg/dL' },
    { id: 'o2', at: '2026-11-21T06:00', name: 'CRP', nameRaw: 'CRP', kind: 'lab', value: 8.1, comparator: null, valueText: '8.1', unit: 'mg/dL' },
    { id: 'o3', at: '2026-11-21T06:00', name: 'Na', nameRaw: 'Na', kind: 'lab', value: 140, comparator: null, valueText: '140', unit: 'mmol/L', unseen: true },
  ],
  medications: [{ id: 'm1', sourceId: 's2', start: 0, name: 'セフトリアキソン', doseText: '2g', action: 'start', at: '2026-11-20T12:00' }],
  events: [{ id: 'e1', kind: 'procedure', title: '末梢静脈ライン確保', at: '2026-11-20T10:40' }],
};

const material = supportMaterial(INPUT);
const BOOK: RefSource = { id: 'B1', kind: 'book', problem: null, text: '市中肺炎では、臨床の改善を見て、静注から経口へ切り替える。', at: null, day: null, label: '架空の内科学 120', ref: { k: 'book', title: '架空の内科学', page: '120', path: null } };

const empty = (problem: string): SupportAnswer['problems'][number] => ({ problem, differentials: [], tests: [], guideline: [], criteria: [], notes: '' });

describe('資料（supportMaterial）', () => {
  test('活動中の問題だけが支援の対象（番号はリストの番号。外したものを飛ばす）。診断がついたものは照合、ほかは疑う疾患と検査', () => {
    expect([...material.targets].map(([ref, t]) => [ref, t.name, t.focus])).toEqual([
      ['P1', '発熱', 'differential'],
      ['P3', '市中肺炎', 'guideline'],
    ]);
    expect(material.problemNames).toEqual(['発熱', '市中肺炎']);
  });

  test('値は H・L の印つき（比べられるときだけ）。字に見つからない AI の数は入れない。薬の日数・デバイスの日数', () => {
    const text = supportMessage(material, []);
    expect(text).toContain('"value":"8.1 mg/dL"');
    expect(text).toContain('H（基準範囲');
    expect(text).not.toContain('"Na"');
    expect(text).toContain('開始から 2 日目');
    expect(text).toContain('末梢静脈ライン');
    expect([...material.refs.keys()]).toEqual(expect.arrayContaining(['T1', 'T2', 'C1', 'V1', 'M1', 'D1']));
    expect(material.refs.get('V1')).toContain('【H】');
  });

  test('長いときは古い経過の出来事から落とし、数を返す', () => {
    const course = Array.from({ length: 400 }, (_, i) => ({ sourceId: `s${String(i)}`, start: 0, at: `2026-11-${String(10 + (i % 10)).padStart(2, '0')}T10:00`, atApprox: null, category: 'other' as const, summary: '架空の出来事'.repeat(10) }));
    const big = supportMaterial({ ...INPUT, course });
    expect(big.dropped.course).toBeGreaterThan(0);
    expect(JSON.stringify(big.payload).length).toBeLessThanOrEqual(50_000);
  });
});

describe('確かめ（checkSupport）', () => {
  test('資料にない記号の項目・記録に結びつかない疑う疾患は出さない。数を返す。記録だけからの推し量りは「（推論）」', () => {
    const r = checkSupport(
      {
        problems: [
          {
            ...empty('P1'),
            differentials: [
              { name: '市中肺炎', reasoning: '発熱と CRP 12.3 の上昇', support: ['C1', 'V1'], against: [], missing: '胸部画像の記載がない', citations: [], inference: false },
              { name: '尿路感染症', reasoning: '架空の根拠', support: ['V9'], against: [], missing: '', citations: [], inference: false },
              { name: '根のない病名', reasoning: '', support: [], against: [], missing: '', citations: [], inference: true },
            ],
            tests: [{ name: '胸部X線', why: '肺炎の確認', support: [], citations: ['B1'], inference: false }],
          },
          empty('P9'),
        ],
      },
      material,
      [BOOK],
    );
    expect(r.rejected).toEqual({ unknown_ref: 1, ungrounded: 1, unknown_problem: 1 });
    const p = r.problems[0];
    expect(p?.differentials.map((d) => d.name)).toEqual(['市中肺炎']);
    expect(p?.differentials[0]?.reasoning.text).toBe('発熱と CRP 12.3 の上昇（推論）');
    expect(p?.differentials[0]?.support.map((s) => s.label)).toEqual([material.refs.get('C1'), material.refs.get('V1')]);
    // 出典の引用がある文は、推論の印を付けない。出典は題と頁だけ（本文は残さない）
    expect(p?.tests[0]?.why.text).toBe('肺炎の確認');
    expect(p?.tests[0]?.citations).toEqual([{ k: 'book', title: '架空の内科学', page: '120', path: null }]);
  });

  test('識別情報の形は伏せる。資料・出典にない数に印（※の場所）', () => {
    const phone = ['090', '1234', '5678'].join('-');
    const r = checkSupport({ problems: [{ ...empty('P1'), tests: [{ name: '血液培養', why: `${phone} に連絡。発熱は 39.9 まで`, support: ['V1'], citations: [], inference: true }] }] }, material, []);
    expect(r.shapes).toBe(1);
    const why = r.problems[0]?.tests[0]?.why;
    expect(why?.text).not.toContain(phone);
    expect(why?.marks.map((m) => why.text.slice(m.start, m.end))).toEqual(['39.9']);
  });

  test('資料にない用量・閾値・目標値は、出典の引用がなければ出さない（数える）。資料にある数・出典つきは出す', () => {
    expect(newDoseNumbers('バンコマイシン 15 mg/kg を投与', material.backing)).toEqual(['15']);
    expect(newDoseNumbers('CRP 12.3 mg/dL と高値', material.backing)).toEqual([]);
    expect(newDoseNumbers('SpO2 92% 以上を保つ', material.backing)).toEqual(['92']);
    expect(newDoseNumbers('セフトリアキソン 2g を継続', material.backing)).toEqual([]);
    const r = checkSupport(
      {
        problems: [
          {
            ...empty('P3'),
            guideline: [
              { statement: 'セフトリアキソン 2g は標準的な選択に沿っている', status: 'consistent', support: ['M1', 'T2'], citations: [], inference: false },
              { statement: 'アジスロマイシン 500 mg の併用を考える', status: 'gap', support: ['T2'], citations: [], inference: false },
              { statement: '改善を見て 48 時間後に経口へ切り替える', status: 'unclear', support: ['T2'], citations: ['B1'], inference: false },
            ],
          },
        ],
      },
      material,
      [BOOK],
    );
    expect(r.rejected).toEqual({ dose: 1 });
    const g = r.problems[0]?.guideline ?? [];
    expect(g.map((x) => x.status)).toEqual(['consistent', 'unclear']);
    expect(g[0]?.statement.text).toContain('（推論）');
    // 出典つきでも、資料・出典にない数には印
    expect(g[1]?.statement.marks.length).toBe(1);
  });

  test('点数を計算させない：資料（表の計算）にない点数は出さない。表にない基準の補いは出典の引用があるときだけ。診断のついた問題の疑う疾患は出さない', () => {
    const r = checkSupport(
      {
        problems: [
          {
            ...empty('P3'),
            differentials: [{ name: '肺結核', reasoning: '', support: ['T2'], against: [], missing: '', citations: [], inference: true }],
            criteria: [
              { name: 'A-DROP', statement: '年齢の項目が当てはまり 1点', citations: ['B1'] },
              { name: '架空の基準', statement: '記録にある項目で確かめられる', citations: [] },
              { name: '肺炎の重症度', statement: '書籍の項目に沿って、意識と呼吸数を確かめる', citations: ['B1'] },
            ],
          },
        ],
      },
      material,
      [BOOK],
    );
    expect(r.rejected).toEqual({ focus: 1, score: 1, no_citation: 1 });
    expect(r.problems[0]?.criteria.map((c) => c.name)).toEqual(['肺炎の重症度']);
  });

  test('活動中でない・外した問題は指せない。同じ問題が2回なら後を出さない', () => {
    const r = checkSupport({ problems: [{ ...empty('P2'), notes: 'x' }, { ...empty('P1'), notes: '補足' }, { ...empty('P1'), notes: '重ね' }, empty('P7')] }, material, []);
    expect(material.listed.has('P2')).toBe(true);
    expect(r.rejected).toEqual({ not_active: 1, duplicate: 1, unknown_problem: 1 });
    expect(r.problems.map((p) => p.notes.text)).toEqual(['補足']);
  });
});

describe('組み直しの印（supportBasis）', () => {
  test('記録の印とプロブレムリストを組んだ日時で変わる', () => {
    const sources = [{ id: 'a', organized: 'done' }];
    expect(supportBasis(sources, '2026-11-21T09:00')).toBe(`${listBasis(sources)}|2026-11-21T09:00`);
    expect(supportBasis(sources, '2026-11-21T09:00')).not.toBe(supportBasis(sources, '2026-11-21T10:00'));
    expect(supportBasis([...sources, { id: 'b', organized: null }], '2026-11-21T09:00')).not.toBe(supportBasis(sources, '2026-11-21T09:00'));
  });
});
