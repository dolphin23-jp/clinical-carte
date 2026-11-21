import { describe, expect, test } from 'vitest';

import {
  liveThreadId,
  problemBlocks,
  relatedFacts,
  linkRequest,
  mentionLine,
  planLinks,
  problemNotes,
  ProblemMove,
  resolveLinks,
  sharedPlanSegments,
  type ThreadMention,
  type ThreadRow,
  ThreadPatch,
  threadViews,
} from '../src/index.ts';

let n = 0;
const m = (patch: Partial<ThreadMention>): ThreadMention => {
  n += 1;
  return { id: `m${String(n).padStart(3, '0')}`, sourceId: 's1', threadId: null, name: '肺炎', status: 'problem', activity: null, at: '2026-11-18T09:00', start: n, end: n + 2, ...patch };
};
const t = (id: string, patch: Partial<ThreadRow> = {}): ThreadRow => ({ id, displayName: null, mergedInto: null, ...patch });

describe('liveThreadId', () => {
  test('統合をたどる。知らない筋・輪は null', () => {
    const rows = new Map([
      ['a', t('a', { mergedInto: 'b' })],
      ['b', t('b')],
      ['x', t('x', { mergedInto: 'y' })],
      ['y', t('y', { mergedInto: 'x' })],
    ]);
    expect(liveThreadId(rows, 'a')).toBe('b');
    expect(liveThreadId(rows, 'zz')).toBeNull();
    expect(liveThreadId(rows, 'x')).toBeNull();
    expect(liveThreadId(rows, null)).toBeNull();
  });
});

describe('planLinks（決定論でつなぐ）', () => {
  test('名前が同じ（番号・全角半角・空白を除いて）筋が1つなら、つなぐ', () => {
    const old = m({ threadId: 'T-a', name: '#1 市中肺炎' });
    const add = m({ name: '＃２　市中 肺炎' });
    const plan = planLinks([t('T-a')], [old, add]);
    expect(plan.rule.get(add.id)).toBe('T-a');
    expect(plan.pending).toEqual([]);
    expect(plan.needsAi).toBe(false);
  });

  test('最初の記載で、名前が1種類だけなら、AI に聞かない（新しい筋）', () => {
    const a = m({ name: '#1 発熱' });
    const b = m({ name: '発熱' });
    const plan = planLinks([], [a, b]);
    expect(plan.pending).toHaveLength(1);
    expect(plan.pending[0]?.mentions.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(plan.needsAi).toBe(false);
  });

  test('名前の違うまとまりが2つ以上か、すでに筋があって名前が違えば、AI に聞く', () => {
    expect(planLinks([], [m({ name: '発熱' }), m({ name: '市中肺炎' })]).needsAi).toBe(true);
    expect(planLinks([t('T-a')], [m({ threadId: 'T-a', name: '発熱' }), m({ name: '市中肺炎' })]).needsAi).toBe(true);
  });

  test('同じ名前の筋が2つあれば（本人が分けた）、決めずに AI に回す', () => {
    const plan = planLinks([t('T-a'), t('T-b')], [m({ threadId: 'T-a', name: '肺炎' }), m({ threadId: 'T-b', name: '肺炎' }), m({ name: '肺炎' })]);
    expect(plan.rule.size).toBe(0);
    expect(plan.needsAi).toBe(true);
  });

  test('統合した筋の記載は、統合先の筋として数える', () => {
    const add = m({ name: '低K血症' });
    const plan = planLinks([t('T-a', { mergedInto: 'T-b' }), t('T-b')], [m({ threadId: 'T-a', name: '低K血症' }), add]);
    expect(plan.rule.get(add.id)).toBe('T-b');
  });
});

describe('linkRequest と resolveLinks（AI につながせる）', () => {
  const text = '#1 発熱\nS) 咳あり\nA) 市中肺炎として治療\n#2 低Na血症 補正中';
  const fever = m({ threadId: 'T-a', name: '#1 発熱', start: 0, end: 5, at: '2026-11-17' });
  const pneu = m({ name: '市中肺炎', start: text.indexOf('市中肺炎'), end: text.indexOf('市中肺炎') + 4 });
  const na = m({ name: '#2 低Na血症', start: text.indexOf('#2'), end: text.indexOf('#2') + 8 });
  const threads = [t('T-a')];
  const mentions = [fever, pneu, na];
  const plan = planLinks(threads, mentions);
  const req = linkRequest(threads, mentions, plan.pending, () => text);

  test('AI に見せるのは、問題の名前と、記載の行だけ（記号で）', () => {
    expect(JSON.parse(req.message)).toEqual({
      problems: [{ ref: 'T1', names: ['#1 発熱'] }],
      added: [
        { ref: 'M1', name: '市中肺炎', line: 'A) 市中肺炎として治療' },
        { ref: 'M2', name: '#2 低Na血症', line: '#2 低Na血症 補正中' },
      ],
    });
  });

  test('AI の答えのとおりにつなぐ。答えのないまとまりは、新しい筋', () => {
    const r = resolveLinks(req, plan.pending, { links: [{ added: 'M1', same_as: 'T1' }] });
    expect(r.groups.map((g) => ({ ids: g.mentions.map((x) => x.id), thread: g.threadId }))).toEqual([
      { ids: [pneu.id], thread: 'T-a' },
      { ids: [na.id], thread: null },
    ]);
    expect(r.report).toEqual({});
  });

  test('新しいまとまりどうしを同じにできる。筋とつながったまとまりに、ほかも付く', () => {
    const r = resolveLinks(req, plan.pending, {
      links: [
        { added: 'M2', same_as: 'M1' },
        { added: 'M1', same_as: 'T1' },
      ],
    });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]?.threadId).toBe('T-a');
    expect(r.groups[0]?.mentions.map((x) => x.id).sort()).toEqual([pneu.id, na.id].sort());
  });

  test('知らない記号・自分自身・2つの答え・食い違いは使わず、数える', () => {
    const r = resolveLinks(req, plan.pending, {
      links: [
        { added: 'M9', same_as: 'T1' },
        { added: 'M1', same_as: 'T7' },
        { added: 'M1', same_as: 'M1' },
        { added: 'M2', same_as: 'T1' },
        { added: 'M2', same_as: 'M1' },
      ],
    });
    expect(r.report).toEqual({ unknown_ref: 2, self: 1, twice: 1 });
    expect(r.groups.every((g) => g.threadId === null)).toBe(true);
  });

  test('つながった2つのまとまりが、別々の筋を指したら、どちらにもつながない', () => {
    const two = [t('T-a'), t('T-b')];
    const ms = [m({ threadId: 'T-a', name: 'A病' }), m({ threadId: 'T-b', name: 'B病' }), m({ name: 'C' }), m({ name: 'D' })];
    const p = planLinks(two, ms);
    const rq = linkRequest(two, ms, p.pending, () => '');
    const tRef = (id: string) => [...rq.threadRefs].find(([, v]) => v === id)?.[0] ?? '';
    const r = resolveLinks(rq, p.pending, {
      links: [
        { added: 'M1', same_as: tRef('T-a') },
        { added: 'M2', same_as: tRef('T-b') },
        { added: 'M2', same_as: 'M1' },
      ],
    });
    expect(r.report.twice).toBe(1);
    const r2 = resolveLinks(rq, p.pending, {
      links: [
        { added: 'M1', same_as: tRef('T-a') },
        { added: 'M2', same_as: 'M1' },
      ],
    });
    expect(r2.groups[0]?.threadId).toBe('T-a');
  });

  test('AI を使わないときは、どれも新しい筋', () => {
    expect(resolveLinks(req, plan.pending, null).groups.map((g) => g.threadId)).toEqual([null, null]);
  });
});

describe('mentionLine', () => {
  test('その行だけ。長い行は、記載の前後に縮める', () => {
    expect(mentionLine('一行目\n#1 肺炎 改善\n三行目', 4, 9)).toBe('#1 肺炎 改善');
    const long = `${'あ'.repeat(300)}肺炎${'い'.repeat(300)}`;
    const line = mentionLine(long, 300, 302);
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line).toContain('肺炎');
  });
});

describe('threadViews', () => {
  test('名前の移り変わり、いちばん新しい記載の確からしさ・状態、まとまり', () => {
    const rows = [t('T-a'), t('T-b'), t('T-c'), t('T-d', { mergedInto: 'T-a' })];
    const ms = [
      m({ threadId: 'T-a', name: '#1 発熱', at: '2026-11-17T10:00', status: 'problem' }),
      m({ threadId: 'T-d', name: '#3 咳嗽', at: '2026-11-17T11:00' }),
      m({ threadId: 'T-a', name: '#1 市中肺炎', at: '2026-11-18T09:00', status: 'diagnosis' }),
      m({ threadId: 'T-b', name: '#2 低K血症', at: '2026-11-18T09:00' }),
      m({ threadId: 'T-b', name: '#2 低K血症', at: '2026-11-19T09:00', activity: 'resolved' }),
      m({ threadId: 'T-c', name: '肺塞栓', at: '2026-11-18T09:00', status: 'ruled_out' }),
      m({ threadId: null, name: '便秘', at: '2026-11-19' }),
    ];
    const v = threadViews(rows, ms);
    // 並びは、いちばん新しい記載の順（低K血症〔11/19〕が先。同じ日時の記載は、書かれた順）
    expect(v.threads.map((x) => [x.name, x.group, x.status])).toEqual([
      ['#2 低K血症', 'closed', 'problem'],
      ['#1 市中肺炎', 'current', 'diagnosis'],
      ['肺塞栓', 'ruled_out', 'ruled_out'],
    ]);
    const pneu = v.threads[1];
    expect(pneu?.names.map((x) => x.name)).toEqual(['#1 発熱', '#3 咳嗽', '#1 市中肺炎']);
    expect(pneu?.first).toBe('2026-11-17T10:00');
    expect(v.threads[0]?.activity).toBe('resolved');
    expect(v.unlinked.map((x) => x.name)).toEqual(['便秘']);
  });

  test('既定の並び：いちばん新しい記載が新しい筋ほど前。同じ記載の中は、書かれた順。日時のない記載は後ろ', () => {
    const v = threadViews(
      [t('T-er'), t('T-1'), t('T-3'), t('T-x')],
      [
        // 救急の記録の評価から拾った名前（最初の記載）
        m({ threadId: 'T-er', name: '閉塞性腎盂腎炎', at: '2026-11-16', sourceId: 's0', start: 5 }),
        m({ threadId: 'T-1', name: '#1 菌血症', at: '2026-11-16T17:30', sourceId: 's1', start: 10 }),
        m({ threadId: 'T-3', name: '#3 2型糖尿病', at: '2026-11-16T17:30', sourceId: 's1', start: 40 }),
        // いまの記載：#3 が #1 より後ろに書かれている
        m({ threadId: 'T-1', name: '#1 菌血症', at: '2026-11-21', sourceId: 's9', start: 10 }),
        m({ threadId: 'T-3', name: '#3 2型糖尿病', at: '2026-11-21', sourceId: 's9', start: 80 }),
        m({ threadId: 'T-x', name: '不明の記載', at: null, sourceId: 's5', start: 0 }),
      ],
    );
    expect(v.threads.map((x) => x.id)).toEqual(['T-1', 'T-3', 'T-er', 'T-x']);
  });

  test('解決と書かれた後に、また書かれたら「いまの問題」。前の解決は earlierActivity に残る', () => {
    const v = threadViews([t('T-a')], [m({ threadId: 'T-a', name: 'せん妄', at: '2026-11-18', activity: 'resolved' }), m({ threadId: 'T-a', name: 'せん妄', at: '2026-11-20' })]);
    expect(v.threads[0]?.group).toBe('current');
    expect(v.threads[0]?.activity).toBeNull();
    expect(v.threads[0]?.earlierActivity).toEqual({ activity: 'resolved', at: '2026-11-18' });
  });

  test('表示の名前は、書かれた名前のうち本人が選んだもの。書かれていない名前は使わない', () => {
    const ms = [m({ threadId: 'T-a', name: '#1 発熱', at: '2026-11-17' }), m({ threadId: 'T-a', name: '#1 市中肺炎', at: '2026-11-18' })];
    expect(threadViews([t('T-a', { displayName: '#1 発熱' })], ms).threads[0]).toMatchObject({ name: '#1 発熱', chosenName: true });
    expect(threadViews([t('T-a', { displayName: '別の名前' })], ms).threads[0]).toMatchObject({ name: '#1 市中肺炎', chosenName: false });
  });
});

describe('problemNotes', () => {
  const seg = (label: string, start: number, end: number, sourceId = 's1') => ({ sourceId, label: label as never, start, end });
  test('#問題の見出しの下の A・P を、その問題の記載にする。見出しだけなら見出しの区切り', () => {
    const segments = [seg('problem_heading', 0, 10), seg('subjective', 10, 20), seg('assessment', 20, 30), seg('plan', 30, 40), seg('problem_heading', 40, 60), seg('other', 60, 70)];
    const a = m({ sourceId: 's1', start: 0, end: 6 });
    const b = m({ sourceId: 's1', start: 41, end: 45 });
    expect(problemNotes([a], segments).map((x) => [x.label, x.start])).toEqual([
      ['assessment', 20],
      ['plan', 30],
    ]);
    expect(problemNotes([b], segments).map((x) => [x.label, x.start])).toEqual([['problem_heading', 40]]);
  });

  test('A・P の中に書かれた問題は、その区切り。S・O の中なら、出さない', () => {
    const segments = [seg('subjective', 0, 10), seg('assessment_plan', 10, 30)];
    expect(problemNotes([m({ start: 12, end: 14 }), m({ start: 2, end: 4 })], segments).map((x) => x.label)).toEqual(['assessment_plan']);
  });
});

describe('記載全体の P（sharedPlanSegments）', () => {
  const seg = (label: string, start: number, end: number, sourceId = 's1') => ({ sourceId, label: label as never, start, end });
  // 「A) → #1 の段落 → #2 の段落 → #3 の段落 → P) → 申し送り」の形
  const segments = [seg('assessment', 0, 5), seg('problem_heading', 5, 30), seg('problem_heading', 30, 50), seg('problem_heading', 50, 70), seg('plan', 70, 100), seg('handover', 100, 120)];

  test('見出しが2つ以上あり、A・P が最後の見出しのあとにだけあれば、その P は記載全体のもの', () => {
    expect(sharedPlanSegments(segments).map((g) => [g.label, g.start])).toEqual([['plan', 70]]);
  });

  test('最後の問題の範囲と A・P は、記載全体の P を含まない（最後の問題のものにしない）', () => {
    const last = m({ start: 51, end: 55 });
    expect(problemBlocks([last], segments)).toEqual([{ sourceId: 's1', start: 50, end: 70 }]);
    expect(problemNotes([last], segments).map((x) => [x.label, x.start])).toEqual([['problem_heading', 50]]);
    const first = m({ start: 6, end: 9 });
    expect(problemNotes([first], segments).map((x) => [x.label, x.start])).toEqual([['problem_heading', 5]]);
  });

  test('問題ごとに A・P が書かれた記載（前の見出しにも A・P が続く）は、これまでどおり、その問題の P', () => {
    const own = [seg('problem_heading', 0, 10), seg('plan', 10, 20), seg('problem_heading', 20, 30), seg('plan', 30, 40)];
    expect(sharedPlanSegments(own)).toEqual([]);
    expect(problemNotes([m({ start: 21, end: 24 })], own).map((x) => [x.label, x.start])).toEqual([['plan', 30]]);
  });

  test('見出しが1つの記載・ほかの記載の区切りは、記載全体の P にしない', () => {
    expect(sharedPlanSegments([seg('problem_heading', 0, 10), seg('plan', 10, 20)])).toEqual([]);
    expect(sharedPlanSegments([...segments.map((g) => ({ ...g, sourceId: 's2' })), seg('plan', 0, 10, 's3')]).map((g) => g.sourceId)).toEqual(['s2']);
  });
});

describe('一覧の形の A（1つの区切りに別の問題が並ぶ）', () => {
  const seg = (label: string, start: number, end: number, sourceId = 's1') => ({ sourceId, label: label as never, start, end });
  // 「A)\n#1 ショック\n#2 急性腎障害\n#3 低K血症」の1つの A の区切り（0〜60）
  const segments = [seg('assessment', 0, 60), seg('other', 60, 80)];
  const a1 = m({ threadId: 'T1', start: 3, end: 10 });
  const a2 = m({ threadId: 'T2', start: 20, end: 26 });
  const a3 = m({ threadId: 'T3', start: 40, end: 45 });
  test('ほかの問題の記載を渡すと、その問題の名前から、次の別の問題の名前の手前まで', () => {
    const all = [a1, a2, a3];
    expect(problemNotes([a1], segments, all).map((x) => [x.start, x.end])).toEqual([[3, 20]]);
    expect(problemNotes([a2], segments, all).map((x) => [x.start, x.end])).toEqual([[20, 40]]);
    expect(problemNotes([a3], segments, all).map((x) => [x.start, x.end])).toEqual([[40, 60]]);
  });
  test('渡さなければ・ほかの問題がなければ、これまでどおり区切り全体', () => {
    expect(problemNotes([a1], segments).map((x) => [x.start, x.end])).toEqual([[0, 60]]);
    expect(problemNotes([a1], segments, [a1]).map((x) => [x.start, x.end])).toEqual([[0, 60]]);
  });
});

describe('本人の操作の形', () => {
  const id = '01JD0000000000000000000000';
  test('移す・分ける・統合・表示の名前', () => {
    expect(ProblemMove.safeParse({ thread: 'new', expected: null }).success).toBe(true);
    expect(ProblemMove.safeParse({ thread: id, expected: id }).success).toBe(true);
    expect(ProblemMove.safeParse({ thread: 'x', expected: null }).success).toBe(false);
    expect(ThreadPatch.safeParse({ mergeInto: id }).success).toBe(true);
    expect(ThreadPatch.safeParse({ displayName: '#1 市中肺炎' }).success).toBe(true);
    expect(ThreadPatch.safeParse({ displayName: null }).success).toBe(true);
    expect(ThreadPatch.safeParse({ displayName: '' }).success).toBe(false);
    expect(ThreadPatch.safeParse({ mergeInto: id, displayName: 'x' }).success).toBe(false);
  });
});

describe('問題の記載の中に書かれた事実（段3c）', () => {
  const seg = (label: string, start: number, end: number, sourceId = 's1') => ({ sourceId, label: label as never, start, end });
  const segments = [seg('problem_heading', 0, 10), seg('subjective', 10, 20), seg('objective', 20, 40), seg('plan', 40, 60), seg('problem_heading', 60, 80), seg('assessment', 80, 100), seg('other', 100, 120)];
  test('#問題の見出しから、続く S・O・A・P の終わりまで。ほかの問題の範囲・その他の区切りは入れない', () => {
    const a = m({ start: 0, end: 5 });
    expect(problemBlocks([a], segments)).toEqual([{ sourceId: 's1', start: 0, end: 60 }]);
    const obs = [
      { id: 'o1', sourceId: 's1', start: 22, end: 30, name: 'CRP', nameRaw: 'CRP' },
      { id: 'o2', sourceId: 's1', start: 25, end: 32, name: 'CRP', nameRaw: 'CRP' },
      { id: 'o3', sourceId: 's1', start: 85, end: 90, name: 'カリウム', nameRaw: 'K' },
      { id: 'o4', sourceId: 's1', start: 105, end: 110, name: null, nameRaw: 'X' },
      { id: 'o5', sourceId: 's2', start: 22, end: 30, name: 'WBC', nameRaw: 'WBC' },
    ];
    const meds = [
      { id: 'd1', sourceId: 's1', start: 42, end: 50, name: 'セフトリアキソン' },
      { id: 'd2', sourceId: 's1', start: 52, end: 59, name: 'ｾﾌﾄﾘｱｷｿﾝ' },
    ];
    const r = relatedFacts([a], segments, { observations: obs, medications: meds, events: [] });
    expect(r.valueNames).toEqual(['CRP']);
    expect(r.observations.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(r.medicationNames).toEqual(['セフトリアキソン']);
    const b = m({ start: 61, end: 65 });
    expect(relatedFacts([b], segments, { observations: obs, medications: meds, events: [] }).valueNames).toEqual(['カリウム']);
  });

  test('A・P の中の記載は、その区切りだけ。区切りの外の記載は、範囲を持たない', () => {
    expect(problemBlocks([m({ start: 82, end: 85 })], segments)).toEqual([{ sourceId: 's1', start: 80, end: 100 }]);
    expect(problemBlocks([m({ start: 102, end: 105 })], segments)).toEqual([]);
    expect(problemBlocks([m({ sourceId: 's9', start: 0, end: 3 })], segments)).toEqual([]);
  });
});
