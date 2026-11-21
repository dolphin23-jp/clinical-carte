// 表の用意（schema.ts）：サーバーが、まだ適用していない migrations を、自分で適用する。
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import type { Db } from '../src/db.ts';
import { MIGRATIONS } from '../src/migrations.gen.ts';
import { ensureSchema, schemaGate } from '../src/schema.ts';
import { openDb, TEST_KEY, world } from './support.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const tables = (db: ReturnType<typeof openDb>): string[] => (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe('migrations の写し', () => {
  test('migrations.gen.ts は、migrations/*.sql と同じ（古くない）', () => {
    expect(() => execFileSync('node', ['scripts/build_migrations.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' })).not.toThrow();
  });

  test('番号の順に並び、最初は、適用の控えの表', () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(['0000_schema', '0001_entrance', '0002_records', '0003_organize', '0004_threads', '0005_fact_edits', '0006_user_edits', '0007_ap_notes', '0008_next_day']);
    for (const m of MIGRATIONS) expect(m.statements.length, m.name).toBeGreaterThan(0);
  });

  test('表を消す・中身を消す文がない（配り直しで、記録が消えない）', () => {
    // 「ON DELETE CASCADE」（参照の決まり）は、消す文ではない
    for (const m of MIGRATIONS) for (const sql of m.statements) expect(sql, m.name).not.toMatch(/^(DROP|DELETE|TRUNCATE)\b|\bDROP\s+(TABLE|INDEX|COLUMN)\b/i);
  });
});

describe('表の用意', () => {
  test('空の保存先に、すべての表を作り、適用した名前を控える', async () => {
    const db = openDb({ empty: true });
    expect(tables(db)).toEqual([]);
    expect(await ensureSchema(db)).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual(['ap_history', 'ap_notes', 'devices', 'encounters', 'entrance_daily', 'events', 'fact_edits', 'history', 'medications', 'observations', 'patients', 'problem_threads', 'problems', 'schema_migrations', 'segments', 'sources', 'usage_daily', 'user_edits']);
    expect(db.raw.prepare('SELECT name FROM schema_migrations ORDER BY name').all()).toEqual(MIGRATIONS.map((m) => ({ name: m.name })));
  });

  test('段1 の表に記録が入った保存先に、段2 の migration を足しても、記録はそのまま。新しい列は空（まだ整理していない）', async () => {
    const db = openDb({ empty: true });
    await ensureSchema(db, MIGRATIONS.slice(0, 3));
    db.raw.exec("INSERT INTO patients (id, age, age_on, sex, created_on) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 72, '2026-11-20', 'male', '2026-11-20')");
    db.raw.exec("INSERT INTO encounters (id, patient_id, kind, started) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'inpatient', '2026-11-20')");
    db.raw.exec("INSERT INTO sources (id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAX', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', 'progress_note', 'self', NULL, '2026-11-20T09:00', '解熱。', '{}')");
    expect(await ensureSchema(db, MIGRATIONS.slice(0, 4))).toBe(1);
    expect(db.raw.prepare('SELECT text, organized, organized_version, organize_report FROM sources').all()).toEqual([{ text: '解熱。', organized: null, organized_version: null, organize_report: null }]);
  });

  test('段2 で整理した問題の入った保存先に、段3a の migration を足しても、問題はそのまま。筋・活動の状態は空（あとで、つなぐ）', async () => {
    const db = openDb({ empty: true });
    await ensureSchema(db, MIGRATIONS.slice(0, 4));
    db.raw.exec("INSERT INTO patients (id, age, age_on, sex, created_on) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 72, '2026-11-20', 'male', '2026-11-20')");
    db.raw.exec("INSERT INTO encounters (id, patient_id, kind, started) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'inpatient', '2026-11-20')");
    db.raw.exec("INSERT INTO sources (id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAX', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', 'progress_note', 'self', NULL, '2026-11-20T09:00', '#1 肺炎', '{}')");
    db.raw.exec("INSERT INTO problems (id, patient_id, encounter_id, source_id, name, status, at, span_start, span_end, origin) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAY', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAX', '#1 肺炎', 'problem', NULL, 0, 5, 'ai')");
    expect(await ensureSchema(db, MIGRATIONS.slice(0, 5))).toBe(1);
    expect(db.raw.prepare('SELECT name, thread_id, thread_origin, activity FROM problems').all()).toEqual([{ name: '#1 肺炎', thread_id: null, thread_origin: null, activity: null }]);
  });

  test('段3a までの保存先に、段3e の migration を足しても、事実はそのまま。外した印は 0（使う）', async () => {
    const db = openDb({ empty: true });
    await ensureSchema(db, MIGRATIONS.slice(0, 5));
    db.raw.exec("INSERT INTO patients (id, age, age_on, sex, created_on) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 72, '2026-11-20', 'male', '2026-11-20')");
    db.raw.exec("INSERT INTO encounters (id, patient_id, kind, started) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'inpatient', '2026-11-20')");
    db.raw.exec("INSERT INTO sources (id, patient_id, encounter_id, kind, author_role, at, entered_at, text, replaced) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAX', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', 'lab', 'self', NULL, '2026-11-20T09:00', 'CRP 2.1', '{}')");
    db.raw.exec("INSERT INTO observations (id, patient_id, encounter_id, source_id, at, name, name_raw, kind, value, comparator, value_text, unit, span_start, span_end, ord, origin) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAY', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAX', NULL, 'CRP', 'CRP', 'lab', 2.1, NULL, '2.1', NULL, 0, 7, 0, 'parser')");
    expect(await ensureSchema(db, MIGRATIONS.slice(0, 6))).toBe(1);
    expect(db.raw.prepare('SELECT name, excluded, origin FROM observations').all()).toEqual([{ name: 'CRP', excluded: 0, origin: 'parser' }]);
  });

  test('もう一度動かしても、何もしない。入っている記録は、そのまま', async () => {
    const db = openDb({ empty: true });
    await ensureSchema(db);
    db.raw.exec("INSERT INTO patients (id, age, age_on, sex, created_on) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 72, '2026-11-20', 'male', '2026-11-20')");
    db.log.length = 0;
    expect(await ensureSchema(db)).toBe(0);
    expect(db.log).toEqual(['SELECT name FROM schema_migrations']);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM patients').get()).toEqual({ n: 1 });
  });

  test('migrations が増えたら、増えた分だけを適用する', async () => {
    const db = openDb({ empty: true });
    await ensureSchema(db, MIGRATIONS.slice(0, 2));
    expect(tables(db)).toEqual(['devices', 'entrance_daily', 'schema_migrations']);
    expect(await ensureSchema(db)).toBe(MIGRATIONS.length - 2);
    expect(tables(db)).toContain('patients');
  });

  test('途中で失敗した migration は、何も残さない（全部できるか、全部できないか）', async () => {
    const db = openDb({ empty: true });
    const broken = [...MIGRATIONS.slice(0, 2), { name: '0002_broken', statements: ['CREATE TABLE half (id TEXT)', 'THIS IS NOT SQL'] }];
    await expect(ensureSchema(db, broken)).rejects.toThrow();
    expect(tables(db)).toEqual(['devices', 'entrance_daily', 'schema_migrations']);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 2 });
  });
});

describe('同じ起動の中では、1回だけ確かめる', () => {
  test('何度呼んでも、保存先を見るのは1回。失敗したら、次に、もう一度確かめる', async () => {
    const db = openDb({ empty: true });
    let fail = true;
    const flaky: Db = {
      prepare: (sql) => db.prepare(sql),
      batch: (statements) => (fail ? Promise.reject(new Error('一時の失敗')) : db.batch(statements)),
    };
    const ready = schemaGate(() => flaky);
    await expect(ready()).rejects.toThrow();
    fail = false;
    await ready();
    db.log.length = 0;
    await ready();
    await ready();
    expect(db.log).toEqual([]);
    expect(tables(db)).toContain('patients');
  });
});

describe('入口と合わせて', () => {
  test('空の保存先でも、最初の要求で表ができ、端末を登録できる。合鍵がないときは、保存先に触れない', async () => {
    const db = openDb({ empty: true });
    const ready = schemaGate(() => db);
    const w = world({ db, ready });
    expect((await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'iphone' } })).status).toBe(200);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 1 });

    const empty = openDb({ empty: true });
    const noKey = world({ db: empty, key: undefined, ready: schemaGate(() => empty) });
    expect((await noKey.call('GET', '/api/session')).status).toBe(500);
    expect(tables(empty)).toEqual([]);
  });

  test('表の用意に失敗したら、名前だけの誤りを返す（何が起きたかを出さない）', async () => {
    const w = world({ ready: () => Promise.reject(new Error('保存先の中身が混ざりうる文')) });
    const r = await w.call('GET', '/api/session');
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'server' });
  });
});
