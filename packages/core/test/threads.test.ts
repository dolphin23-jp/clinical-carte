import { describe, expect, test } from 'vitest';

import {
  liveThreadId,
  linkRequest,
  mentionLine,
  planLinks,
  problemNotes,
  ProblemMove,
  resolveLinks,
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
    expect(v.threads.map((x) => [x.name, x.group, x.status])).toEqual([
      ['#1 市中肺炎', 'current', 'diagnosis'],
      ['#2 低K血症', 'closed', 'problem'],
      ['肺塞栓', 'ruled_out', 'ruled_out'],
    ]);
    const pneu = v.threads[0];
    expect(pneu?.names.map((x) => x.name)).toEqual(['#1 発熱', '#3 咳嗽', '#1 市中肺炎']);
    expect(pneu?.first).toBe('2026-11-17T10:00');
    expect(v.threads[1]?.activity).toBe('resolved');
    expect(v.unlinked.map((x) => x.name)).toEqual(['便秘']);
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
