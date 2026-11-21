// AI のプロブレムリスト（CA-057）：結びつけの確かめ・始まりの日・先生の直しの引き継ぎ・直し。架空（synthetic）。
import { describe, expect, test } from 'vitest';

import { applyListPatch, carryListEdits, checkProblemList, type ListItem, listBasis, listMaterial } from '../src/index.ts';

const material = listMaterial({
  patient: { age: 72, sex: '男' },
  threads: [
    { id: 'th1', name: '#1 発熱', status: 'problem', group: 'current', first: '2026-11-20T10:30', last: '2026-11-21T09:00', lastNote: 'A) 肺炎を疑う' },
    { id: 'th2', name: '#2 低Na血症', status: 'problem', group: 'current', first: '2026-11-20T11:00', last: '2026-11-20T11:00', lastNote: '' },
  ],
  course: [{ sourceId: 's1', start: 10, at: '2026-11-17T17:00', atApprox: '夕方ごろ', category: 'onset', summary: '発熱が出現' }],
  events: [],
  medications: [],
  labs: [],
  previous: [],
});

describe('AI のプロブレムリスト', () => {
  test('結びつけが実在する項目だけ。始まりの日は、結びつけた筋・出来事のいちばん早い日時。識別情報の形は伏せる', () => {
    const phone = ['090', '1234', '5678'].join('-');
    const r = checkProblemList(
      {
        items: [
          { name: '#1 市中肺炎疑い', certainty: 'suspected', activity: 'active', threads: ['T1'], course: ['C1'], basis: `発熱と咳嗽 ${phone}` },
          { name: '#2 低Na血症', certainty: 'problem', activity: 'active', threads: ['T2', 'T9'], course: [], basis: '' },
          { name: '#3 根のない問題', certainty: 'problem', activity: 'active', threads: ['T9'], course: [], basis: '' },
          { name: '#1 市中肺炎疑い', certainty: 'suspected', activity: 'active', threads: ['T1'], course: [], basis: '' },
        ],
      },
      material,
    );
    expect(r.items.map((i) => [i.name, i.threadIds, i.since])).toEqual([
      ['#1 市中肺炎疑い', ['th1'], '2026-11-17T17:00'],
      ['#2 低Na血症', ['th2'], '2026-11-20T11:00'],
    ]);
    expect(r.items[0]?.basis).not.toContain(phone);
    expect(r.items[0]?.course).toEqual([{ sourceId: 's1', start: 10 }]);
    expect(r.rejected).toEqual({ ungrounded: 1, duplicate: 1 });
    expect(r.shapes).toBe(1);
  });

  test('組み直しても、同じ筋に結びつく項目の、先生の直し（名前・状態・外した）と key を引き継ぐ', () => {
    const prev: ListItem[] = [
      { key: 'k1', name: '#1 肺炎（先生の名前）', certainty: 'diagnosis', activity: 'active', threadIds: ['th1'], course: [], basis: '', since: null, self: ['name', 'certainty'], hidden: false },
      { key: 'k2', name: '#2 低Na', certainty: 'problem', activity: 'active', threadIds: ['th2'], course: [], basis: '', since: null, self: [], hidden: true },
    ];
    const fresh = checkProblemList(
      {
        items: [
          { name: '#1 市中肺炎疑い', certainty: 'suspected', activity: 'active', threads: ['T1'], course: [], basis: '' },
          { name: '#2 低Na血症', certainty: 'problem', activity: 'resolved', threads: ['T2'], course: [], basis: '' },
        ],
      },
      material,
    ).items;
    let n = 0;
    const out = carryListEdits(fresh, prev, () => `new${String((n += 1))}`);
    expect(out.map((i) => [i.key, i.name, i.certainty, i.activity, i.hidden])).toEqual([
      ['k1', '#1 肺炎（先生の名前）', 'diagnosis', 'active', false],
      ['k2', '#2 低Na血症', 'problem', 'resolved', true],
    ]);
  });

  test('直し：名前・確からしさ・状態は先生の印が付く。外す・並べ替え。知らない key は null', () => {
    const items: ListItem[] = [
      { key: 'a', name: 'A', certainty: 'problem', activity: 'active', threadIds: [], course: [], basis: '', since: null, self: [], hidden: false },
      { key: 'b', name: 'B', certainty: 'problem', activity: 'active', threadIds: [], course: [], basis: '', since: null, self: [], hidden: false },
    ];
    expect(applyListPatch(items, { key: 'a', name: 'A2' })?.[0]).toMatchObject({ name: 'A2', self: ['name'] });
    expect(applyListPatch(items, { key: 'b', activity: 'resolved' })?.[1]).toMatchObject({ activity: 'resolved', self: ['activity'] });
    expect(applyListPatch(items, { key: 'a', hidden: true })?.[0]?.hidden).toBe(true);
    expect(applyListPatch(items, { key: 'b', move: 'up' })?.map((i) => i.key)).toEqual(['b', 'a']);
    expect(applyListPatch(items, { key: 'z', hidden: true })).toBeNull();
  });

  test('元の記録の印：記載が増えた・整理が終わると変わる', () => {
    const a = listBasis([{ id: '01A', organized: null }]);
    const b = listBasis([{ id: '01A', organized: 'done' }]);
    const c = listBasis([{ id: '01A', organized: 'done' }, { id: '01B', organized: null }]);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
