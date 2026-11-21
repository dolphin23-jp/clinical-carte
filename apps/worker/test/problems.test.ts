// 問題の筋（段3a。CA-024・CA-025）：整理のあと、記載ごとの問題を筋につなぐ。本人の直す操作と履歴。AI は、試験の代役。
import type { LinkAnswer, OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import type { LinkerResult } from '../src/organizer.ts';
import { EMPTY_ORGANIZE, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

/** 文ごとの整理の答え（文の中身で選ぶ） */
type Answers = Record<string, OrganizeAnswer>;

interface Rec {
  problems: { id: string; name: string; status: string; activity: string | null; threadId: string | null; threadOrigin: string | null; sourceId: string; at: string | null }[];
  problemThreads: { id: string; displayName: string | null; mergedInto: string | null }[];
  history: { action: string; target: string; before: string | null; after: string | null; at: string }[];
  segments: { label: string }[];
}

async function setup(answers: Answers, link: (message: string) => LinkerResult = () => ({ ok: true, answer: { links: [] } }), overrides: Parameters<typeof world>[0] = {}) {
  const organizer = fakeOrganizer((text) => ({ ok: true, answer: answers[text] ?? EMPTY_ORGANIZE }), link);
  const w = world({ selector: fakeSelector(), organizer, ...overrides });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-17T22:10' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const add = async (text: string, at: string) => {
    const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at, text } });
    const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
    const organized = await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
    return { sourceId, organized: (await organized.json()) as { link?: { usedAi: boolean; pendingLeft: number; report: unknown } } };
  };
  // 時計を止めた試験では、文の id（ULID）の順が入れた順にならないので、記載の日時と名前で並べる
  const rec = async (): Promise<Rec> => {
    const r = (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as Rec;
    return { ...r, problems: [...r.problems].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.name.localeCompare(b.name)) };
  };
  return { w, cookie, patientId: created.patient.id, add, rec, organizer };
}

const problem = (name: string, status: OrganizeAnswer['problems'][number]['status'] = 'problem', activity: 'resolved' | 'inactive' | null = null) => ({ name, status, activity });
const answer = (...problems: OrganizeAnswer['problems']): OrganizeAnswer => ({ ...EMPTY_ORGANIZE, problems });

const D1 = '#1 発熱\n#2 低K血症';
const D2 = '#1 市中肺炎 抗菌薬継続\n#2 低K血症 補正中';
const D3 = '#2 低K血症 解決';

describe('つなぐ', () => {
  test('最初の記載で名前が違えば、AI に聞く。答えのない記載は、それぞれ新しい筋', async () => {
    const s = await setup({ [D1]: answer(problem('#1 発熱'), problem('#2 低K血症')) });
    const { organized } = await s.add(D1, '2026-11-17T23:00');
    expect(organized.link).toMatchObject({ usedAi: true, pendingLeft: 0 });
    const r = await s.rec();
    expect(r.problemThreads).toHaveLength(2);
    expect(new Set(r.problems.map((p) => p.threadId)).size).toBe(2);
    expect(r.problems.every((p) => p.threadOrigin === 'ai')).toBe(true);
  });

  test('名前が同じ記載は、決定論でつなぐ（AI に聞かない）。名前が変わった記載は、AI の答えでつなぐ', async () => {
    let call = 0;
    const s = await setup(
      { [D1]: answer(problem('#1 発熱'), problem('#2 低K血症')), [D2]: answer(problem('#1 市中肺炎', 'diagnosis'), problem('#2 低K血症')) },
      (message) => {
        call += 1;
        if (call === 1) return { ok: true, answer: { links: [] } };
        // 2回目：「市中肺炎」は、「発熱」の筋（資料の記号で）
        const data = JSON.parse(message) as { problems: { ref: string; names: string[] }[]; added: { ref: string; name: string }[] };
        const fever = data.problems.find((p) => p.names.includes('#1 発熱'))?.ref ?? '';
        const pneu = data.added.find((a) => a.name === '#1 市中肺炎')?.ref ?? '';
        const links: LinkAnswer['links'] = [{ added: pneu, same_as: fever }];
        return { ok: true, answer: { links } };
      },
    );
    await s.add(D1, '2026-11-17T23:00');
    const { organized } = await s.add(D2, '2026-11-18T09:00');
    expect(organized.link?.usedAi).toBe(true);
    // AI に見せたのは、低K血症を除いた（決定論でつないだ）記載だけ
    const sent = JSON.parse(s.organizer.linked[1] ?? '{}') as { added: { name: string; line: string }[] };
    expect(sent.added).toEqual([{ ref: 'M1', name: '#1 市中肺炎', line: '#1 市中肺炎 抗菌薬継続' }]);
    const r = await s.rec();
    expect(r.problemThreads).toHaveLength(2);
    const byName = new Map(r.problems.map((p) => [p.name, p]));
    expect(byName.get('#1 市中肺炎')?.threadId).toBe(byName.get('#1 発熱')?.threadId);
    expect(byName.get('#1 市中肺炎')?.threadOrigin).toBe('ai');
    const lowK = r.problems.filter((p) => p.name === '#2 低K血症');
    expect(new Set(lowK.map((p) => p.threadId)).size).toBe(1);
    expect(lowK.map((p) => p.threadOrigin)).toEqual(['ai', 'rule']);
  });

  test('解決と書かれたものは、activity に残る（書かれたときだけ）', async () => {
    const s = await setup({ [D1]: answer(problem('#1 発熱'), problem('#2 低K血症')), [D3]: answer(problem('#2 低K血症', 'problem', 'resolved')) });
    await s.add(D1, '2026-11-17T23:00');
    await s.add(D3, '2026-11-19T09:00');
    const r = await s.rec();
    expect(r.problems.map((p) => [p.name, p.activity])).toEqual([
      ['#1 発熱', null],
      ['#2 低K血症', null],
      ['#2 低K血症', 'resolved'],
    ]);
  });

  test('AI が失敗したら、決定論でつなげない記載は、つながないまま残る。あとで、つなぎ直せる', async () => {
    let fail = true;
    const s = await setup({ [D1]: answer(problem('#1 発熱'), problem('#2 低K血症')) }, () => (fail ? { ok: false, reason: 'unavailable' } : { ok: true, answer: { links: [] } }));
    const { organized } = await s.add(D1, '2026-11-17T23:00');
    expect(organized.link).toMatchObject({ usedAi: true, pendingLeft: 2 });
    expect((await s.rec()).problems.every((p) => p.threadId === null)).toBe(true);
    fail = false;
    const again = await s.w.call('POST', `/api/patients/${s.patientId}/problems/link`, { cookie: s.cookie, body: {} });
    expect(again.status).toBe(200);
    expect((await s.rec()).problems.every((p) => p.threadId !== null)).toBe(true);
  });

  test('1日の上限に達していたら、AI に聞かず、つながないまま残す（整理はできている）', async () => {
    const s = await setup({ [D1]: answer(problem('#1 発熱'), problem('#2 低K血症')) }, undefined, { dailyAiLimit: 2 });
    // 上限 2：入れる（選別）1回・整理 1回で、つなぎの分が残っていない
    const { organized } = await s.add(D1, '2026-11-17T23:00');
    expect(organized.link).toMatchObject({ usedAi: false, pendingLeft: 2 });
    expect(s.organizer.linked).toHaveLength(0);
    const again = await s.w.call('POST', `/api/patients/${s.patientId}/problems/link`, { cookie: s.cookie, body: {} });
    expect(again.status).toBe(429);
  });

  test('AI に送るのは、保存した問題の名前と、保存した文の行だけ（ほかの行は送らない）', async () => {
    const text = '経過は落ち着いている。\n#1 発熱 解熱傾向\n家族へ説明した。\n#2 低K血症';
    const s = await setup({ [text]: answer(problem('#1 発熱'), problem('#2 低K血症')) });
    await s.add(text, '2026-11-17T23:00');
    const sent = s.organizer.linked[0] ?? '';
    expect(sent).toContain('#1 発熱 解熱傾向');
    expect(sent).not.toContain('経過は落ち着いている');
    expect(sent).not.toContain('家族へ説明した');
  });

  test('整理し直しても、同じ記載は同じ筋のまま（本人がつなぎ直したものも）', async () => {
    const s = await setup({ [D1]: answer(problem('#1 発熱'), problem('#2 低K血症')) });
    const { sourceId } = await s.add(D1, '2026-11-17T23:00');
    let r = await s.rec();
    const fever = r.problems.find((p) => p.name === '#1 発熱');
    const lowK = r.problems.find((p) => p.name === '#2 低K血症');
    // 本人が、発熱を低K血症の筋へ移す（試しに）
    expect((await s.w.call('PATCH', `/api/problems/${fever?.id ?? ''}`, { cookie: s.cookie, body: { thread: lowK?.threadId, expected: fever?.threadId } })).status).toBe(200);
    await s.w.call('POST', `/api/sources/${sourceId}/organize`, { cookie: s.cookie, body: {} });
    r = await s.rec();
    const again = r.problems.find((p) => p.name === '#1 発熱');
    expect(again?.threadId).toBe(lowK?.threadId);
    expect(again?.threadOrigin).toBe('self');
  });
});

describe('本人の直す操作と履歴', () => {
  async function two() {
    const s = await setup({ [D1]: answer(problem('#1 発熱'), problem('#2 低K血症')), [D2]: answer(problem('#1 市中肺炎', 'diagnosis'), problem('#2 低K血症')) });
    await s.add(D1, '2026-11-17T23:00');
    await s.add(D2, '2026-11-18T09:00');
    return s;
  }

  test('分ける（新しい筋）・移す。いまの筋が違えば 409（ほかの端末が先に直した）', async () => {
    const s = await two();
    let r = await s.rec();
    const pneu = r.problems.find((p) => p.name === '#1 市中肺炎');
    const fever = r.problems.find((p) => p.name === '#1 発熱');
    // 市中肺炎は、AI がつながなかったので、別の筋。発熱の筋へ移す
    const move = await s.w.call('PATCH', `/api/problems/${pneu?.id ?? ''}`, { cookie: s.cookie, body: { thread: fever?.threadId, expected: pneu?.threadId } });
    expect(move.status).toBe(200);
    const stale = await s.w.call('PATCH', `/api/problems/${pneu?.id ?? ''}`, { cookie: s.cookie, body: { thread: 'new', expected: pneu?.threadId } });
    expect(stale.status).toBe(409);
    const split = await s.w.call('PATCH', `/api/problems/${pneu?.id ?? ''}`, { cookie: s.cookie, body: { thread: 'new', expected: fever?.threadId } });
    expect(split.status).toBe(200);
    r = await s.rec();
    const moved = r.problems.find((p) => p.name === '#1 市中肺炎');
    expect(moved?.threadId).not.toBe(fever?.threadId);
    expect(moved?.threadOrigin).toBe('self');
    expect(r.history.map((h) => h.action)).toEqual(['move', 'move']);
    expect(r.history[1]).toMatchObject({ target: pneu?.id, before: pneu?.threadId, after: fever?.threadId });
    expect(r.history[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  test('統合：記載は統合先へ。統合した筋には、もう統合・名前の操作ができない。輪は作れない', async () => {
    const s = await two();
    let r = await s.rec();
    const pneu = r.problems.find((p) => p.name === '#1 市中肺炎');
    const fever = r.problems.find((p) => p.name === '#1 発熱');
    const merge = await s.w.call('PATCH', `/api/threads/${pneu?.threadId ?? ''}`, { cookie: s.cookie, body: { mergeInto: fever?.threadId } });
    expect(merge.status).toBe(200);
    r = await s.rec();
    expect(r.problems.find((p) => p.name === '#1 市中肺炎')?.threadId).toBe(fever?.threadId);
    expect(r.problemThreads.find((t) => t.id === pneu?.threadId)?.mergedInto).toBe(fever?.threadId);
    expect((await s.w.call('PATCH', `/api/threads/${pneu?.threadId ?? ''}`, { cookie: s.cookie, body: { displayName: null } })).status).toBe(400);
    expect((await s.w.call('PATCH', `/api/threads/${fever?.threadId ?? ''}`, { cookie: s.cookie, body: { mergeInto: pneu?.threadId } })).status).toBe(400);
    expect((await s.w.call('PATCH', `/api/threads/${fever?.threadId ?? ''}`, { cookie: s.cookie, body: { mergeInto: fever?.threadId } })).status).toBe(400);
    expect(r.history[0]).toMatchObject({ action: 'merge', target: pneu?.threadId, after: fever?.threadId });
  });

  test('表示の名前は、その筋に書かれた名前からだけ選べる（打った名前は使えない）', async () => {
    const s = await two();
    const r = await s.rec();
    const fever = r.problems.find((p) => p.name === '#1 発熱');
    const ok = await s.w.call('PATCH', `/api/threads/${fever?.threadId ?? ''}`, { cookie: s.cookie, body: { displayName: '#1 発熱' } });
    expect(ok.status).toBe(200);
    const typed = await s.w.call('PATCH', `/api/threads/${fever?.threadId ?? ''}`, { cookie: s.cookie, body: { displayName: '打った名前' } });
    expect(typed.status).toBe(400);
    const after = await s.rec();
    expect(after.problemThreads.find((t) => t.id === fever?.threadId)?.displayName).toBe('#1 発熱');
    expect(after.history[0]).toMatchObject({ action: 'name', before: null, after: '#1 発熱' });
  });

  test('別の患者の筋へは移せない・統合できない', async () => {
    const s = await two();
    const other = (await (await s.w.call('POST', '/api/patients', { cookie: s.cookie, body: { age: 50, ageOn: '2026-11-20', sex: 'female', encounter: { kind: 'er', start: '2026-11-20' } } })).json()) as {
      encounter: { id: string };
    };
    const saved = await s.w.call('POST', `/api/encounters/${other.encounter.id}/sources`, { cookie: s.cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-20T09:00', text: D1 } });
    const otherSource = ((await saved.json()) as { source: { id: string; patientId: string } }).source;
    await s.w.call('POST', `/api/sources/${otherSource.id}/organize`, { cookie: s.cookie, body: {} });
    const theirs = ((await (await s.w.call('GET', `/api/patients/${otherSource.patientId}`, { cookie: s.cookie })).json()) as Rec).problems[0];
    const mine = (await s.rec()).problems[0];
    expect((await s.w.call('PATCH', `/api/problems/${mine?.id ?? ''}`, { cookie: s.cookie, body: { thread: theirs?.threadId, expected: mine?.threadId } })).status).toBe(404);
    expect((await s.w.call('PATCH', `/api/threads/${mine?.threadId ?? ''}`, { cookie: s.cookie, body: { mergeInto: theirs?.threadId } })).status).toBe(404);
  });

  test('患者を消すと、筋と履歴も消える', async () => {
    const s = await two();
    const r = await s.rec();
    await s.w.call('PATCH', `/api/threads/${r.problems[0]?.threadId ?? ''}`, { cookie: s.cookie, body: { displayName: r.problems[0]?.name } });
    expect((await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie })).status).toBe(200);
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM problem_threads').get()).toEqual({ n: 0 });
    expect(s.w.db.raw.prepare('SELECT COUNT(*) AS n FROM history').get()).toEqual({ n: 0 });
  });

  test('履歴に入るのは、id・操作・日時と、選んだ名前（書かれた名前）だけ。文は入らない', async () => {
    const s = await two();
    const r = await s.rec();
    const fever = r.problems.find((p) => p.name === '#1 発熱');
    await s.w.call('PATCH', `/api/threads/${fever?.threadId ?? ''}`, { cookie: s.cookie, body: { displayName: '#1 発熱' } });
    const rows = s.w.db.raw.prepare('SELECT * FROM history').all() as Record<string, unknown>[];
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['action', 'after', 'at', 'before', 'id', 'patient_id', 'target']);
    expect(JSON.stringify(rows)).not.toContain('抗菌薬継続');
  });
});
