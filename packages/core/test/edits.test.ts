import { describe, expect, test } from 'vitest';

import { AddFact, checkSpan, FactPatch, patchFits, reorder, segmentEnds, SourcePatch, type ThreadMention, ThreadPatch, threadViews } from '../src/index.ts';

let n = 0;
const m = (p: Partial<ThreadMention>): ThreadMention => {
  n += 1;
  return { id: `m${String(n).padStart(3, '0')}`, sourceId: 's1', threadId: 'A', name: '#1 肺炎', status: 'problem', activity: null, at: `2026-11-${String(10 + n).padStart(2, '0')}`, start: 0, end: 3, ...p };
};

describe('問題の筋の本人の決め（CA-029）', () => {
  const mentions = [m({ threadId: 'A', name: '#1 発熱' }), m({ threadId: 'B', name: '#2 低K血症', activity: 'resolved' }), m({ threadId: 'C', name: '#3 便秘' }), m({ threadId: 'D', name: '咳嗽' })];
  test('確からしさ・状態は、本人の決めが書かれたものより先。並びは本人の番号が先。外した筋は別に', () => {
    const v = threadViews(
      [
        { id: 'A', displayName: null, mergedInto: null, statusOverride: 'diagnosis', ord: 2 },
        { id: 'B', displayName: null, mergedInto: null, activityOverride: 'active', ord: 1 },
        { id: 'C', displayName: null, mergedInto: null, excluded: true },
        { id: 'D', displayName: null, mergedInto: 'A' },
      ],
      mentions,
    );
    expect(v.threads.map((t) => [t.name, t.group, t.status, t.statusBySelf, t.activitySelf])).toEqual([
      ['#2 低K血症', 'current', 'problem', false, 'active'],
      ['#1 発熱', 'current', 'diagnosis', true, null],
    ]);
    expect(v.excluded.map((t) => t.name)).toEqual(['#3 便秘']);
    // 統合は、記載を動かさず、統合先にまとめる。統合を解けるように、統合した筋を返す
    expect(v.threads[1]?.mentions.map((x) => x.name)).toEqual(['#1 発熱', '咳嗽']);
    expect(v.threads[1]?.mergedFrom).toEqual([{ id: 'D', names: ['咳嗽'] }]);
  });

  test('打って直した名前が、選んだ名前・いちばん新しい名前より先', () => {
    const v = threadViews([{ id: 'A', displayName: '#1 発熱', mergedInto: null, typedName: '#1 右下葉肺炎' }], [mentions[0] as ThreadMention]);
    expect(v.threads[0]).toMatchObject({ name: '#1 右下葉肺炎', typedName: true, chosenName: false });
  });

  test('並べ替え：1つ上・下へ。端は動かさない', () => {
    const v = threadViews(
      [
        { id: 'A', displayName: null, mergedInto: null },
        { id: 'B', displayName: null, mergedInto: null },
        { id: 'C', displayName: null, mergedInto: null },
      ],
      mentions.slice(0, 3),
    ).threads;
    // 既定の並びは、いちばん新しい記載の順（C〔11/13〕・B〔11/12〕・A〔11/11〕）
    expect(v.map((t) => t.id)).toEqual(['C', 'B', 'A']);
    expect(reorder(v, 'A', 'up')).toEqual([
      { id: 'C', ord: 0 },
      { id: 'A', ord: 1 },
      { id: 'B', ord: 2 },
    ]);
    expect(reorder(v, 'C', 'up')).toBeNull();
    expect(reorder(v, 'A', 'down')).toBeNull();
  });

  test('操作の形', () => {
    const id = '01JD0000000000000000000000';
    for (const ok of [{ status: 'suspected' }, { status: null }, { activity: 'resolved' }, { move: 'up' }, { excluded: true }, { unmerge: id }, { typedName: '#1 右下葉肺炎' }, { typedName: null }]) expect(ThreadPatch.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    for (const bad of [{ status: 'maybe' }, { move: 'left' }, { typedName: '' }, { typedName: 'あ'.repeat(101) }, { unmerge: 'x' }]) expect(ThreadPatch.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe('なぞって足す（checkSpan）', () => {
  const text = '#1 市中肺炎\nO) CRP 6.8 Na 128\nP) セフトリアキソン 2g 継続';
  const at = (s: string) => text.indexOf(s);
  test('前後の空白を詰める。値は決定論で読めるものだけ', () => {
    expect(checkSpan(text, { type: 'medication', start: at('セフ') - 1, end: at('セフ') + 8, action: null })).toEqual({ ok: true, start: at('セフ'), end: at('セフ') + 8, quote: 'セフトリアキソン' });
    expect(checkSpan(text, { type: 'observation', start: at('CRP'), end: at('CRP') + 7 })).toMatchObject({ ok: true, quote: 'CRP 6.8' });
    expect(checkSpan(text, { type: 'observation', start: at('O)'), end: at('O)') + 2 })).toEqual({ ok: false, problem: 'no_value' });
  });

  test('文の外・空・行をまたぐ・長すぎる・識別情報の形は断る', () => {
    expect(checkSpan(text, { type: 'problem', start: 0, end: text.length + 1, status: 'problem' })).toEqual({ ok: false, problem: 'range' });
    expect(checkSpan(text, { type: 'problem', start: 3, end: 3, status: 'problem' })).toEqual({ ok: false, problem: 'range' });
    expect(checkSpan('a  b', { type: 'problem', start: 1, end: 3, status: 'problem' })).toEqual({ ok: false, problem: 'empty' });
    expect(checkSpan(text, { type: 'problem', start: 0, end: 12, status: 'problem' })).toEqual({ ok: false, problem: 'newline' });
    expect(checkSpan('あ'.repeat(300), { type: 'event', start: 0, end: 250, kind: 'test' })).toEqual({ ok: false, problem: 'too_long' });
    const phone = ['090', '1234', '5678'].join('-');
    expect(checkSpan(`連絡 ${phone}`, { type: 'event', start: 0, end: 16, kind: 'other' })).toEqual({ ok: false, problem: 'shape' });
  });

  test('区切りは場所だけ。区切りの終わりは次の始まり', () => {
    expect(checkSpan(text, { type: 'segment', start: at('P)'), label: 'plan' })).toMatchObject({ ok: true, start: at('P)') });
    expect(segmentEnds([{ start: 10 }, { start: 0 }, { start: 5 }], 20)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 10 },
      { start: 10, end: 20 },
    ]);
  });

  test('形：種類と欄の組み合わせ', () => {
    expect(AddFact.safeParse({ type: 'event', start: 0, end: 2, kind: 'test' }).success).toBe(true);
    expect(AddFact.safeParse({ type: 'event', start: 0, end: 2 }).success).toBe(false);
    expect(AddFact.safeParse({ type: 'segment', start: 0, label: 'plan', end: 3 }).success).toBe(false);
    expect(patchFits('observation', { name: 'カリウム' })).toBe(true);
    expect(patchFits('medication', { name: 'カリウム' })).toBe(false);
    expect(FactPatch.safeParse({ name: '' }).success).toBe(false);
    expect(SourcePatch.safeParse({ kind: 'memo' }).success).toBe(true);
    expect(SourcePatch.safeParse({ kind: 'memo', at: null }).success).toBe(false);
  });
});
