// 段K7（CA-067）：申し送り（I-PASS）。出す・相談はカルテ記載と同じ流れ。残すのは handoffs（重症度は先生が選んだもの。文は選別 C-1 を通す）。
// AI は試験の代役。架空症例だけ。
import type { OrganizeAnswer } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { EMPTY_ORGANIZE, type FakeDocAnswers, fakeOrganizer, fakeSelector, registered, world } from './support.ts';

const NAME = ['架空', '一郎'].join('');
const NOTE = `${NAME}さん。\n#1 市中肺炎\nS) 咳は減った\nA) 抗菌薬に反応\nP) 継続。喀痰培養を提出。SpO2 が下がれば当直へ連絡`;
const ANSWER: OrganizeAnswer = {
  ...EMPTY_ORGANIZE,
  segments: [
    { label: 'problem_heading', start: '#1 市中肺炎', when: null },
    { label: 'subjective', start: 'S) 咳', when: null },
    { label: 'assessment', start: 'A) 抗菌薬', when: null },
    { label: 'plan', start: 'P) 継続', when: null },
  ],
  problems: [{ name: '#1 市中肺炎', status: 'diagnosis', activity: null }],
};

interface Handoff {
  id: string;
  day: string;
  severity: string;
  origin: string;
  sections: { key: string; text: string; refs: unknown[] }[];
}

async function setup(docs: FakeDocAnswers = {}) {
  const organizer = fakeOrganizer(() => ({ ok: true, answer: ANSWER }), undefined, docs);
  const selector = fakeSelector([{ kind: 'person', quote: NAME }]);
  const w = world({ selector, organizer });
  const { cookie } = await registered(w);
  const created = (await (await w.call('POST', '/api/patients', { cookie, body: { age: 72, ageOn: '2026-11-20', sex: 'male', encounter: { kind: 'inpatient', start: '2026-11-17T22:10' } } })).json()) as {
    patient: { id: string };
    encounter: { id: string };
  };
  const saved = await w.call('POST', `/api/encounters/${created.encounter.id}/sources`, { cookie, body: { kind: 'progress_note', authorRole: 'self', at: '2026-11-19T09:00', text: NOTE } });
  const sourceId = ((await saved.json()) as { source: { id: string } }).source.id;
  await w.call('POST', `/api/sources/${sourceId}/organize`, { cookie, body: {} });
  const record = async () => (await (await w.call('GET', `/api/patients/${created.patient.id}`, { cookie })).json()) as { handoffs: Handoff[]; documents: unknown[] };
  return { w, cookie, organizer, selector, encounterId: created.encounter.id, patientId: created.patient.id, record };
}

const count = (s: Awaited<ReturnType<typeof setup>>, table: string): unknown => s.w.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();

describe('申し送りを出す（保存しない）', () => {
  test('資料に、いまの状態の行（1行の要約・問題ごとの最後の A/P）を入れる。AI が重症度を書いても出さない', async () => {
    const s = await setup({
      document: () => ({
        ok: true,
        answer: {
          sections: [
            { key: 'severity', text: '不安定', refs: [] },
            { key: 'summary', text: '重症度：要注意\n72歳 男性。#1 市中肺炎 抗菌薬に反応', refs: ['R1'] },
            { key: 'actions', text: '・喀痰培養の結果を確認', refs: ['R1'] },
            { key: 'contingency', text: '・SpO2 が下がれば当直へ連絡', refs: ['R1'] },
          ],
        },
      }),
    });
    const r = await s.w.call('POST', `/api/encounters/${s.encounterId}/documents/generate`, { cookie: s.cookie, body: { type: 'handoff', day: '2026-11-19', web: false } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { document: { sections: { key: string; heading: string; text: string }[]; notes: { severityLines: number; unknownSections: number } } };
    expect(body.document.sections.map((x) => [x.key, x.heading])).toEqual([
      ['summary', '患者の要約'],
      ['actions', 'やること'],
      ['contingency', '起こりうることと対応'],
    ]);
    expect(body.document.sections[0]?.text).toBe('72歳 男性。#1 市中肺炎 抗菌薬に反応');
    expect(body.document.notes.severityLines).toBe(1);
    expect(body.document.notes.unknownSections).toBe(1);
    const sent = JSON.parse(s.organizer.documented[0] ?? '{}') as { document: { name: string; sections: { key: string }[] }; handoff: { oneLiner: string; problems: { name: string; note: string }[] } };
    expect(sent.document.name).toBe('申し送り');
    expect(sent.document.sections.map((x) => x.key)).toEqual(['summary', 'actions', 'contingency']);
    expect(sent.handoff.oneLiner).toContain('72歳 男性');
    expect(sent.handoff.problems[0]?.note).toContain('喀痰培養を提出');
    expect(JSON.stringify(sent)).not.toContain(NAME);
    expect(JSON.stringify(sent)).not.toMatch(/"severity"/u);
    expect(count(s, 'handoffs')).toEqual({ n: 0 });
  });
});

describe('申し送りを残す・直す・消す', () => {
  const sections = [
    { key: 'summary', text: `${NAME}さん 72歳 男性。#1 市中肺炎`, refs: [] },
    { key: 'actions', text: '喀痰培養の結果を確認', refs: [] },
    { key: 'contingency', text: '', refs: [] },
  ];

  test('重症度は先生が選んだもの（ないと残せない）。文は選別を通す（名前は置き換わる）。カルテ記載（documents）には入らない', async () => {
    const s = await setup();
    const post = (body: unknown) => s.w.call('POST', `/api/encounters/${s.encounterId}/handoffs`, { cookie: s.cookie, body });
    expect((await post({ day: '2026-11-19', sections, origin: 'ai', edited: false })).status).toBe(400);
    expect((await post({ day: '2026-11-19', severity: 'critical', sections, origin: 'ai', edited: false })).status).toBe(400);
    expect((await post({ day: '2026-11-19', severity: 'watcher', sections: [{ key: 'severity', text: '安定', refs: [] }], origin: 'ai', edited: false })).status).toBe(400);
    expect((await s.w.call('POST', `/api/encounters/${s.encounterId}/documents`, { cookie: s.cookie, body: { type: 'handoff', day: '2026-11-19', sections, origin: 'ai', edited: false } })).status).toBe(400);
    expect(count(s, 'handoffs')).toEqual({ n: 0 });

    const r = await post({ day: '2026-11-19', severity: 'watcher', sections, origin: 'ai', edited: false });
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    const rec = await s.record();
    expect(rec.documents).toHaveLength(0);
    expect(rec.handoffs).toHaveLength(1);
    expect(rec.handoffs[0]).toMatchObject({ id, day: '2026-11-19', severity: 'watcher', origin: 'ai' });
    expect(rec.handoffs[0]?.sections[0]?.text).toBe('〔氏名〕さん 72歳 男性。#1 市中肺炎');
    expect(JSON.stringify(s.w.db.raw.prepare('SELECT * FROM handoffs').all())).not.toContain(NAME);
    expect(s.selector.seen.some((t) => t.includes(NAME))).toBe(true);

    // 重症度だけを選び直す：誰の文かは変わらない。文を直すと「AI が書いて先生が直した」
    const kept = rec.handoffs[0]?.sections ?? [];
    expect((await s.w.call('PATCH', `/api/handoffs/${id}`, { cookie: s.cookie, body: { severity: 'unstable', sections: kept } })).status).toBe(200);
    expect((await s.record()).handoffs[0]).toMatchObject({ severity: 'unstable', origin: 'ai' });
    expect((await s.w.call('PATCH', `/api/handoffs/${id}`, { cookie: s.cookie, body: { severity: 'stable', sections: [{ key: 'summary', text: '直した', refs: [] }] } })).status).toBe(200);
    expect((await s.record()).handoffs[0]).toMatchObject({ severity: 'stable', origin: 'ai_edited' });
    expect((await s.w.call('PATCH', `/api/handoffs/${id}`, { cookie: s.cookie, body: { sections: kept } })).status).toBe(400);

    const history = (s.w.db.raw.prepare('SELECT action, origin FROM document_history').all() as { action: string; origin: string | null }[]).map((h) => `${h.action}:${String(h.origin)}`).sort();
    expect(history).toEqual(['add:ai', 'edit:ai', 'edit:ai_edited']);
    expect(JSON.stringify(s.w.db.raw.prepare('SELECT * FROM document_history').all())).not.toContain('喀痰');

    expect((await s.w.call('DELETE', `/api/handoffs/${id}`, { cookie: s.cookie })).status).toBe(200);
    expect(count(s, 'handoffs')).toEqual({ n: 0 });
    expect((await s.w.call('DELETE', `/api/handoffs/${id}`, { cookie: s.cookie })).status).toBe(404);
  });

  test('回診リストには日と重症度だけ（文は入らない）。受け持ち全員の申し送りは、いちばん新しい受診の、いちばん新しいもの。患者を消すと消える', async () => {
    const s = await setup();
    const post = (day: string, severity: string) => s.w.call('POST', `/api/encounters/${s.encounterId}/handoffs`, { cookie: s.cookie, body: { day, severity, sections, origin: 'ai', edited: false } });
    await post('2026-11-18', 'unstable');
    const latest = (await (await post('2026-11-19', 'watcher')).json()) as { id: string };
    const list = (await (await s.w.call('GET', '/api/patients', { cookie: s.cookie })).json()) as { patients: { handoff: unknown }[] };
    expect(list.patients[0]?.handoff).toEqual({ id: latest.id, day: '2026-11-19', severity: 'watcher' });
    expect(JSON.stringify(list)).not.toContain('喀痰');
    const all = (await (await s.w.call('GET', '/api/handoffs', { cookie: s.cookie })).json()) as { handoffs: { patientId: string; handoff: Handoff }[] };
    expect(all.handoffs).toHaveLength(1);
    expect(all.handoffs[0]?.patientId).toBe(s.patientId);
    expect(all.handoffs[0]?.handoff).toMatchObject({ id: latest.id, severity: 'watcher' });
    // 読むだけ：AI は呼ばない
    expect(s.organizer.documented).toHaveLength(0);

    await s.w.call('DELETE', `/api/patients/${s.patientId}`, { cookie: s.cookie });
    expect(count(s, 'handoffs')).toEqual({ n: 0 });
    expect(((await (await s.w.call('GET', '/api/handoffs', { cookie: s.cookie })).json()) as { handoffs: unknown[] }).handoffs).toEqual([]);
  });
});
