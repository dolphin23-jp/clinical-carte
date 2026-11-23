// Casebook へ送る（段K10。CA-073）：記録から項目を作る・病日（入院N日前を含む）・止める網（識別情報・暦日・長い数字。分ける前の文の全体にも掛ける）・
// 500 字で分ける・100 項目まで・項目の ID（種・鍵・改訂の SHA-256）・AI の印・パケットを作って、写した Casebook の読み方で読み戻す。
// CASEBOOK_DIR に clinical-casebook の作業ツリーを渡すと、Casebook 自身の decodePacket と匿名化リンタにも通す。文はすべて架空（synthetic）。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  addTaken,
  buildPacket,
  type CasebookCandidate,
  casebookAfterMin,
  casebookCandidates,
  casebookDay,
  casebookDayLabel,
  casebookDefaultKeys,
  type CasebookInput,
  type CasebookLink,
  casebookLint,
  casebookPatientDefaults,
  casebookPieces,
  casebookScope,
  casebookState,
  decodePacket,
  itemIdFromDigest,
  itemIdInput,
  MAX_ITEMS,
  newCasebookSeed,
  type PacketChoice,
  planPacket,
  readCaseCode,
  sourceFields,
} from '../src/index.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const sha = (text: string): Uint8Array => new Uint8Array(createHash('sha256').update(text, 'utf8').digest());
// 架空の ULID（26 字）
const id = (n: number): string => `01KAZZ${String(n).padStart(4, '0').replace(/\d/gu, (d) => 'ABCDEFGHJK'.charAt(Number(d)))}${'M'.repeat(16)}`;
// 陽性の見本は、実行時に組み立てる（ソースに直接書くと phi-guard に止められる）
const PHONE = ['0', '9', '0', '-', '1', '2', '3', '4', '-', '5', '6', '7', '8'].join('');
const DIGITS = Array.from({ length: 13 }, (_, i) => String((i * 7) % 10)).join('');

const ADMIT = { id: id(1), kind: 'inpatient' as const, start: '2026-11-20T14:00', end: '2026-11-28T10:00' };
const ER = { id: id(2), kind: 'er' as const, start: '2026-11-19T22:00', end: null };
const LINK: CasebookLink = { seed: 'abcdefghij', code: null, sent: {}, packets: 0 };
const NOTE_A = '【架空】#1 腎盂腎炎\nA: 発熱は持続。\nP: 抗菌薬を継続。\n#2 低Na血症\nA: Na 128。';
const NOTE_DATED = ['【架空】', '11', '/', '18', ' 採血の結果を確認。'].join('');

function base(over: Partial<CasebookInput> = {}): CasebookInput {
  return {
    patient: { age: 78, ageOn: '2026-11-20', sex: 'female' },
    encounters: [ER, ADMIT],
    encounterId: ADMIT.id,
    today: '2026-11-30',
    sources: [
      { id: id(10), encounterId: ER.id, kind: 'er_note', authorRole: 'self', at: '2026-11-19T23:00', text: '【架空】前日からの発熱と左背部痛で来院。' },
      { id: id(11), encounterId: ADMIT.id, kind: 'progress_note', authorRole: 'self', at: '2026-11-21T09:30', text: NOTE_A },
      { id: id(12), encounterId: ADMIT.id, kind: 'progress_note', authorRole: 'senior', at: '2026-11-22T10:00', text: NOTE_DATED },
      { id: id(13), encounterId: ADMIT.id, kind: 'memo', authorRole: 'self', at: null, text: '【架空】日時のないメモ。' },
      { id: id(14), encounterId: ADMIT.id, kind: 'nursing', authorRole: 'nurse', at: '2026-11-23T08:00', text: `【架空】連絡先 ${PHONE} を控えた。` },
      { id: id(15), encounterId: ADMIT.id, kind: 'lab', authorRole: 'self', at: '2026-11-23T06:00', text: `【架空】番号 ${DIGITS}` },
    ],
    segments: [
      { sourceId: id(11), label: 'problem_heading', start: 0, end: 13 },
      { sourceId: id(11), label: 'problem_heading', start: NOTE_A.indexOf('#2'), end: NOTE_A.indexOf('#2') + 7 },
    ],
    threads: [
      { id: id(20), displayName: null, mergedInto: null, statusOverride: 'diagnosis' },
      { id: id(21), displayName: null, mergedInto: null },
      { id: id(22), displayName: null, mergedInto: null },
    ],
    problems: [
      { id: id(30), sourceId: id(11), threadId: id(20), name: '腎盂腎炎', status: 'suspected', activity: null, at: '2026-11-21T09:30', start: 3, end: 7 },
      { id: id(31), sourceId: id(11), threadId: id(21), name: '低Na血症', status: 'problem', activity: null, at: '2026-11-21T09:30', start: 40, end: 45 },
      { id: id(32), sourceId: id(11), threadId: id(22), name: '尿路結石', status: 'ruled_out', activity: null, at: '2026-11-21T09:30', start: 50, end: 54 },
    ],
    list: [
      { key: id(40), name: '閉塞性腎盂腎炎', certainty: 'diagnosis', activity: 'active', since: '2026-11-19T23:00', self: [], hidden: false },
      { key: id(41), name: '隠した項目', certainty: 'problem', activity: 'active', since: null, self: [], hidden: true },
    ],
    medications: [
      { id: id(50), sourceId: id(11), encounterId: ADMIT.id, name: 'セフトリアキソン', doseText: '点滴', action: 'start', at: '2026-11-20T15:00', excluded: false, edited: false },
      { id: id(51), sourceId: id(11), encounterId: ADMIT.id, name: '整腸剤', doseText: null, action: 'continue', at: '2026-11-21T09:30', excluded: false, edited: false },
      { id: id(52), sourceId: id(11), encounterId: ADMIT.id, name: 'セフトリアキソン', doseText: null, action: 'stop', at: '2026-11-26T09:00', excluded: false, edited: true },
    ],
    events: [
      { id: id(60), encounterId: ADMIT.id, kind: 'procedure', title: '尿道カテーテル留置', at: '2026-11-20T16:00', excluded: false, edited: false },
      { id: id(61), encounterId: ADMIT.id, kind: 'procedure', title: '尿道カテーテル抜去', at: '2026-11-24T10:00', excluded: false, edited: false },
    ],
    documents: [
      { id: id(70), encounterId: ADMIT.id, type: 'discharge_summary', day: '2026-11-28', sections: [{ key: 'course', text: '【架空】抗菌薬で解熱し、第7病日に退院。' }, { key: 'diagnosis', text: '' }], origin: 'ai_edited' },
      { id: id(71), encounterId: ADMIT.id, type: 'handoff', day: '2026-11-25', sections: [{ key: 'summary', text: '申し送りは送らない' }], origin: 'self' },
    ],
    link: LINK,
    ...over,
  };
}

const byTag = (cs: readonly CasebookCandidate[], part: string) => cs.filter((c) => c.tag.includes(part));
const ids = (plan: ReturnType<typeof planPacket>) => new Map(plan.ids.map((x) => [x.key, itemIdFromDigest(sha(x.input))]));
const choiceNew = (keys: readonly string[], synthetic: boolean | null = true): PacketChoice => ({
  mode: 'new',
  patient: { ageYears: 78, sex: 'F', setting: 'inpatient' },
  synthetic,
  keys,
  resend: [],
  packetId: '01KAZZAAAAMMMMMMMMMMMMMMMM',
});

describe('写した契約', () => {
  test('写した decodePacket は、Casebook の固定のテスト用パケット（写し）を、形の違う項目なしで読む', () => {
    const dir = join(ROOT, 'fixtures', 'casebook-handoff');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const fixture = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { synthetic: boolean; packet: string };
      expect(fixture.synthetic).toBe(true);
      const r = decodePacket(fixture.packet);
      expect(r.ok, f).toBe(true);
      if (r.ok) expect([r.value.invalid.length, r.value.unknownKind.length], f).toEqual([0, 0]);
    }
  });
});

describe('病日', () => {
  test('入院の日が第1病日。前の日は 0（入院1日前）、さらに前は 1 − N', () => {
    expect(casebookDay(ADMIT.start, '2026-11-20T23:59')).toBe(1);
    expect(casebookDay(ADMIT.start, '2026-11-22')).toBe(3);
    expect(casebookDay(ADMIT.start, '2026-11-19T22:00')).toBe(0);
    expect(casebookDay(ADMIT.start, '2026-11-17')).toBe(-2);
    expect([1, 3, 0, -2].map(casebookDayLabel)).toEqual(['第1病日', '第3病日', '入院1日前', '入院3日前']);
  });

  test('経過分：第1病日は来院の時刻から、第2病日以降は日の始まりから。時刻のないもの・入院前・来院より前には付けない', () => {
    expect(casebookAfterMin(ADMIT.start, '2026-11-20T15:30', 1)).toBe(90);
    expect(casebookAfterMin(ADMIT.start, '2026-11-20T13:00', 1)).toBeNull();
    expect(casebookAfterMin(ADMIT.start, '2026-11-21T09:30', 2)).toBe(570);
    expect(casebookAfterMin(ADMIT.start, '2026-11-21', 2)).toBeNull();
    expect(casebookAfterMin(ADMIT.start, '2026-11-19T23:00', 0)).toBeNull();
  });

  test('範囲：入院と、その直前（前の日から）の救急の受診。外来は送れない', () => {
    expect(casebookScope(base().encounters, ADMIT.id).map((e) => e.id)).toEqual([ER.id, ADMIT.id]);
    const old = { ...ER, id: id(3), start: '2026-11-10T10:00' };
    expect(casebookScope([old, ADMIT], ADMIT.id).map((e) => e.id)).toEqual([ADMIT.id]);
    const out = { id: id(4), kind: 'outpatient' as const, start: '2026-12-01T10:00', end: null };
    expect(casebookPatientDefaults({ ...base(), encounters: [out], encounterId: out.id })).toBeNull();
    expect(casebookPatientDefaults(base())).toEqual({ ageYears: 78, sex: 'F', setting: 'inpatient' });
  });
});

describe('項目の候補', () => {
  const cs = casebookCandidates(base());

  test('救急の記載は、入院の病日で「入院1日前」（day 0）。記録の文は字のまま、#問題の見出しで分ける', () => {
    const er = cs.find((c) => c.key === `s.${id(10)}.0.c1`);
    expect(er?.day).toBe(0);
    expect(er?.afterMin).toBeNull();
    expect(er?.text).toBe('救急記録（自分）: 【架空】前日からの発熱と左背部痛で来院。');
    const parts = cs.filter((c) => c.key.startsWith(`s.${id(11)}.`));
    expect(parts.map((c) => c.text)).toEqual(['経過（プログレスノート）（自分）: 【架空】#1 腎盂腎炎\nA: 発熱は持続。\nP: 抗菌薬を継続。', '経過（プログレスノート）（自分）: #2 低Na血症\nA: Na 128。']);
    expect(parts.every((c) => c.day === 2 && c.afterMin === 570 && c.kind === 'course' && c.source === 'user')).toBe(true);
  });

  test('区切りは文のすべての字を欄に入れる（黙って落とさない）', () => {
    const fields = sourceFields(NOTE_A, base().segments);
    expect(fields.map((f) => NOTE_A.slice(f.start, f.end)).join('')).toBe(NOTE_A);
  });

  test('暦日・電話・12桁以上の数字のある文は送れない（理由の種類だけ。字は繰り返さない）。日時のない記載も送れない', () => {
    const dated = cs.find((c) => c.key.startsWith(`s.${id(12)}.`));
    expect(dated?.blockers.join()).toContain('暦日');
    const phone = cs.find((c) => c.key.startsWith(`s.${id(14)}.`));
    expect(phone?.blockers.join()).toContain('電話番号の形');
    expect(phone?.blockers.join()).not.toContain(PHONE);
    const digits = cs.find((c) => c.key.startsWith(`s.${id(15)}.`));
    expect(digits?.blockers.join()).toContain('12桁以上の数字');
    const memo = cs.find((c) => c.key.startsWith(`s.${id(13)}.`));
    expect(memo?.blockers.join()).toContain('日時のない記載');
    expect(memo?.kind).toBe('note');
  });

  test('問題と診断：否定的と書かれた問題は送れない。確からしさを先生が選んだ診断だけ初めから選ぶ。AI のリストは AI の印で、初めは選ばない', () => {
    const ruled = cs.find((c) => c.key === `t.${id(22)}.c1`);
    expect(ruled?.blockers.join()).toContain('除外');
    const dx = cs.find((c) => c.key === `t.${id(20)}.dx.c1`);
    expect(dx).toMatchObject({ kind: 'diagnosis', status: 'confirmed', source: 'user', unticked: false, text: '腎盂腎炎', day: 2 });
    const ai = cs.find((c) => c.key === `l.${id(40)}.c1`);
    expect(ai).toMatchObject({ kind: 'problem', source: 'ai', day: 0 });
    const aiDx = cs.find((c) => c.key === `l.${id(40)}.dx.c1`);
    expect(aiDx).toMatchObject({ kind: 'diagnosis', source: 'ai', unticked: true });
    expect(cs.some((c) => c.text.includes('隠した項目'))).toBe(false);
    const keys = casebookDefaultKeys(LINK, cs);
    expect(keys).toContain(`t.${id(20)}.dx.c1`);
    expect(keys).not.toContain(`l.${id(40)}.c1`);
    expect(keys).not.toContain(`t.${id(22)}.c1`);
  });

  test('投薬は開始・変更・中止だけ（継続は送らない）。先生が直したものは先生の印。デバイスは入れた日〜抜いた日を病日で。カルテ記載は見出しごと（申し送りは送らない）', () => {
    const meds = byTag(cs, '投薬');
    expect(meds.map((c) => [c.text, c.source, c.day])).toEqual([
      ['投薬（開始）: セフトリアキソン 点滴', 'ai', 1],
      ['投薬（中止）: セフトリアキソン', 'user', 7],
    ]);
    expect(byTag(cs, 'デバイス').map((c) => c.text)).toEqual(['デバイス: 尿道カテーテル（第1病日〜第5病日）']);
    const docs = cs.filter((c) => c.group === 'documents');
    expect(docs.map((c) => [c.text, c.source, c.day, c.kind])).toEqual([['退院サマリー・入院後経過: 【架空】抗菌薬で解熱し、第7病日に退院。', 'ai', 9, 'note']]);
  });

  test('長い文は 500 字以内の断片に分け、合わせると元の文のすべて。分ける境にまたがる暦日も止める（分ける前の文の全体に掛ける）', () => {
    const filler = 'あ'.repeat(480);
    const pieces = casebookPieces('経過', `${filler}。${'い'.repeat(300)}。`);
    expect(pieces.length).toBe(2);
    expect(pieces.every((p) => p.length <= 500)).toBe(true);
    expect(pieces.map((p) => p.replace(/^経過（\d\/\d）: /u, '')).join('')).toBe(`${filler}。${'い'.repeat(300)}。`);
    // 暦日が、ちょうど分ける境にまたがる文
    const long = `【架空】${'う'.repeat(470)}${['11', '/', '18'].join('')}${'え'.repeat(100)}`;
    const input = base({ sources: [{ id: id(16), encounterId: ADMIT.id, kind: 'progress_note', authorRole: 'self', at: '2026-11-21T09:00', text: long }], segments: [] });
    const got = casebookCandidates(input).filter((c) => c.key.startsWith(`s.${id(16)}.`));
    expect(got.length).toBeGreaterThan(1);
    expect(got.every((c) => c.blockers.join().includes('暦日'))).toBe(true);
  });

  test('リンタは、Casebook の規則の名前で、止めるものと知らせるものを分ける', () => {
    expect(casebookLint('【架空】発熱あり', '2026-11-30')).toEqual({ errors: [], warns: [] });
    expect(casebookLint(['2026', '-', '11', '-', '18'].join(''), '2026-11-30').errors).toEqual(['暦日（年月日・月日）']);
    // 「月/日」は carte の側の網（Casebook のリンタより広い）。比・単位つきの分数・ありえない月日は止めない
    expect(casebookLint(['11', '/', '18', ' 10:00'].join(''), '2026-11-30').errors).toEqual(['暦日（月/日）']);
    expect(casebookLint(['１１', '／', '１８'].join(''), '2026-11-30').errors).toEqual(['暦日（月/日）']);
    expect(casebookLint(['1', '\u200b', '1/', '\u00ad', '18'].join(''), '2026-11-30').errors).toEqual(['暦日（月/日）']);
    for (const ok of ['BP 128/76', 'BT 36.5/37.2', '1/2 錠', '3/3 mm', 'E3V4M6']) expect(casebookLint(ok, '2026-11-30').errors, ok).toEqual([]);
  });
});

describe('ID とパケット', () => {
  test('項目の ID は、種・鍵・改訂で決まる（同じなら同じ。ULID の形）', () => {
    const a = itemIdFromDigest(sha(itemIdInput('abcdefghij', 's.X.0.c1', 0)));
    expect(a).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(itemIdFromDigest(sha(itemIdInput('abcdefghij', 's.X.0.c1', 0)))).toBe(a);
    expect(itemIdFromDigest(sha(itemIdInput('abcdefghij', 's.X.0.c1', 1)))).not.toBe(a);
    expect(itemIdFromDigest(sha(itemIdInput('bbcdefghij', 's.X.0.c1', 0)))).not.toBe(a);
    expect(newCasebookSeed(new Uint8Array([0, 1, 2, 25, 26, 255, 3, 4, 5, 6]))).toMatch(/^[a-z]{10}$/u);
    expect(readCaseCode(' ab c234 ')).toBe('ABC234');
    expect(readCaseCode('ABC10I')).toBeNull();
  });

  test('新しい症例：実症例か架空症例かを選ぶまで作れない。作ったパケットは CBH1: で始まり、写した読み方で読み戻せて、暦日を持たない', () => {
    const input = base();
    const cs = casebookCandidates(input);
    const keys = casebookDefaultKeys(input.link, cs);
    expect(planPacket(input, cs, choiceNew(keys, null)).errors).toContain('実症例か架空症例かを選んでください');
    for (const synthetic of [true, false]) {
      const choice = choiceNew(keys, synthetic);
      const built = buildPacket(input, cs, choice, ids(planPacket(input, cs, choice)));
      expect(built.errors).toEqual([]);
      expect(built.text.startsWith('CBH1:')).toBe(true);
      const r = decodePacket(built.text);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect([r.value.invalid.length, r.value.unknownKind.length]).toEqual([0, 0]);
      const p = r.value.packet;
      expect(p.synthetic).toBe(synthetic ? true : undefined);
      expect(p.patient).toEqual({ ageYears: 78, sex: 'F', setting: 'inpatient' });
      expect(p.hospitalDay).toBe(11);
      expect(p.items[0]?.body.kind).toBe('problem');
      expect(p.items.some((i) => i.body.kind === 'diagnosis')).toBe(true);
      expect(JSON.stringify(p)).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
      expect(p.items.every((i) => i.source !== 'ai')).toBe(true);
      expect(built.entries.map((e) => e.key).sort()).toEqual([...keys].sort());
    }
  });

  test('100 項目まで。既定の選びも 100 で止まる', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: id(100 + i), encounterId: ADMIT.id, kind: 'progress_note' as const, authorRole: 'self' as const, at: '2026-11-21T09:00', text: `【架空】経過 その${String(i + 1)}。` }));
    const input = base({ sources: many, segments: [] });
    const cs = casebookCandidates(input);
    expect(casebookDefaultKeys(input.link, cs)).toHaveLength(MAX_ITEMS);
    const all = cs.filter((c) => c.blockers.length === 0).map((c) => c.key);
    expect(planPacket(input, cs, choiceNew(all)).errors.join()).toContain(`1回に送れるのは ${String(MAX_ITEMS)} 項目まで`);
  });

  test('取り込みの印：送信済みは選べない。送った後に直した項目は、新しい項目（次の改訂・別の ID）としてだけ送れる。症例コードがあれば追加（架空の印は付けない）', () => {
    const input = base();
    const cs = casebookCandidates(input);
    const key = `s.${id(10)}.0.c1`;
    const first = choiceNew([key]);
    const p1 = planPacket(input, cs, first);
    const b1 = buildPacket(input, cs, first, ids(p1));
    const link = addTaken({ ...LINK, code: 'ABC234' }, b1.entries);
    expect(link?.packets).toBe(1);
    if (link === null) return;
    const after = { ...input, link };
    const c = cs.find((x) => x.key === key);
    if (c === undefined) throw new Error('候補がない');
    expect(casebookState(link, c)).toBe('sent');
    const append: PacketChoice = { mode: 'append', patient: null, synthetic: null, keys: [key], resend: [], packetId: '01KAZZAAABMMMMMMMMMMMMMMMM' };
    expect(planPacket(after, cs, append).errors).toContain('送信済みの項目が選ばれています');
    // 先生が記録の文を直した
    const edited = { ...after, sources: after.sources.map((s) => (s.id === id(10) ? { ...s, text: `${s.text}追記。` } : s)) };
    const cs2 = casebookCandidates(edited);
    const c2 = cs2.find((x) => x.key === key);
    if (c2 === undefined) throw new Error('候補がない');
    expect(casebookState(link, c2)).toBe('changed');
    expect(planPacket(edited, cs2, append).ok).toBe(false);
    const again = { ...append, resend: [key] };
    const p2 = planPacket(edited, cs2, again);
    expect(p2.ids[0]?.rev).toBe(1);
    const b2 = buildPacket(edited, cs2, again, ids(p2));
    const r = decodePacket(b2.text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.packet.target).toEqual({ mode: 'append', caseCode: 'ABC234' });
    expect(r.value.packet.synthetic).toBeUndefined();
    expect(r.value.packet.patient).toBeUndefined();
    expect(r.value.packet.items[0]?.itemId).not.toBe(ids(p1).get(key));
  });
});

// Casebook 自身の関数で確かめる（CASEBOOK_DIR に clinical-casebook の作業ツリーを渡したときだけ）
const CASEBOOK = process.env['CASEBOOK_DIR'];
const hasCasebook = CASEBOOK !== undefined && existsSync(join(CASEBOOK, 'packages/core/src/handoff/packet.ts'));

describe.skipIf(!hasCasebook)('Casebook 自身の読み方と匿名化リンタ（CASEBOOK_DIR）', () => {
  test('carte が作ったパケットを、Casebook の decodePacket が形の違う項目なしで読み、どの文も Casebook のリンタで error がない', async () => {
    const dec = (await import(join(CASEBOOK ?? '', 'packages/core/src/handoff/packet.ts'))) as typeof import('../src/casebook/handoff/packet.ts');
    const lint = (await import(join(CASEBOOK ?? '', 'packages/core/src/lint/anonymize.ts'))) as typeof import('../src/casebook/lint/anonymize.ts');
    const input = base();
    const cs = casebookCandidates(input);
    // AI の印の項目も含めて、送れるものをすべて
    const keys = cs.filter((c) => c.blockers.length === 0).map((c) => c.key);
    for (const synthetic of [true, false]) {
      const choice = choiceNew(keys, synthetic);
      const built = buildPacket(input, cs, choice, ids(planPacket(input, cs, choice)));
      const r = dec.decodePacket(built.text);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect([r.value.invalid.length, r.value.unknownKind.length]).toEqual([0, 0]);
      expect(r.value.packet.items).toHaveLength(keys.length);
      expect(r.value.packet.synthetic).toBe(synthetic ? true : undefined);
      for (const it of r.value.packet.items) {
        const text = 'text' in it.body ? it.body.text : '';
        expect(lint.lintAnonymization(text, { dobMaxYear: 2011 }).filter((f) => f.level === 'error')).toEqual([]);
      }
    }
  });

  test('carte が止めた文は、Casebook のリンタでも error（止めた理由が同じ関数から来ている）', async () => {
    const lint = (await import(join(CASEBOOK ?? '', 'packages/core/src/lint/anonymize.ts'))) as typeof import('../src/casebook/lint/anonymize.ts');
    for (const text of [['11', '月', '18', '日に採血'].join(''), ['2026', '/', '11', '/', '18'].join(''), `連絡先 ${PHONE}`, `番号 ${DIGITS}`]) {
      expect(casebookLint(text, '2026-11-30').errors.length).toBeGreaterThan(0);
      expect(lint.hasAnonymizationErrors(lint.lintAnonymization(text, { dobMaxYear: 2011 }))).toBe(true);
    }
    // 「月/日」の形は、Casebook のリンタは止めない（比・分数と見分けないため）が、carte は止める（広くなる分は許す）
    expect(lint.hasAnonymizationErrors(lint.lintAnonymization(NOTE_DATED, { dobMaxYear: 2011 }))).toBe(false);
    expect(casebookLint(NOTE_DATED, '2026-11-30').errors).toEqual(['暦日（月/日）']);
  });

  test('写しは、Casebook の作業ツリーのいまのファイルと同じ（違えば scripts/sync-casebook-contract.mjs で写し直す）', async () => {
    const sync = (await import(join(ROOT, 'scripts', 'sync-casebook-contract.mjs'))) as { compareWithCasebook: (dir: string) => string[] };
    expect(sync.compareWithCasebook(CASEBOOK ?? '')).toEqual([]);
  });
});
