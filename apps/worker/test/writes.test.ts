// 書き込みの一覧（docs/04 の 6）を固定する：サーバーが書く表と、ログを出さないこと。
// 表を足すときは、先に docs/04 の一覧を直してから、ここを直す。
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import { FACT_TABLES } from '../src/records.ts';
import { MIGRATIONS, openDb, registered, TEST_KEY, world } from './support.ts';

const SRC = resolve(import.meta.dirname, '..', 'src');
// migrations.gen.ts は、migrations/*.sql の写し（表を作る文そのもの）なので、ここでは見ない。写しが正本と同じことは、schema.test.ts が確かめる
const sources = readdirSync(SRC)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.gen.ts'))
  .map((name) => ({ name, text: readFileSync(join(SRC, name), 'utf8') }));
const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

/** いまある表（段0〜段3a）。docs/04 の 6 の一覧のうち、作った分 */
const TABLES = ['devices', 'entrance_daily', 'patients', 'encounters', 'sources', 'observations', 'usage_daily', 'schema_migrations', 'segments', 'medications', 'events', 'problems', 'problem_threads', 'history'];

describe('書き込みの一覧', () => {
  test('migrations が作る表は、一覧のとおり', () => {
    const db = openDb();
    const names = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual([...TABLES].sort());
  });

  test('ソースの SQL が書く表は、一覧の表だけ', () => {
    const written = new Set<string>();
    for (const { text } of sources) {
      for (const m of code(text).matchAll(/\b(?:INSERT\s+(?:OR\s+IGNORE\s+)?INTO|(?<!\bDO\s+)UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi)) written.add((m[1] ?? '').toLowerCase());
    }
    expect([...written].sort()).toEqual([...TABLES].sort());
  });

  test('文から作った行の表（文を消すと、一緒に消える）は、一覧の表', () => {
    for (const table of FACT_TABLES) expect(TABLES).toContain(table);
  });

  test('表を作る・変える SQL は、migrations にだけある（ソースにない）', () => {
    for (const { name, text } of sources) expect(code(text), name).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX)/i);
    expect(readdirSync(MIGRATIONS).length).toBeGreaterThan(0);
  });

  test('端末の表に入るのは、id・種類・照合用の値・日だけ。日は日付で、時刻を持たない', async () => {
    const w = world();
    await registered(w);
    const rows = w.db.raw.prepare('SELECT * FROM devices').all() as Record<string, unknown>[];
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'kind', 'last_used_on', 'registered_on', 'secret_hash']);
    expect(rows[0]?.['registered_on']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0]?.['last_used_on']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('合鍵の間違いの表に入るのは、日付と整数だけ（打たれた合鍵を残さない）', async () => {
    const w = world();
    const typed = `${TEST_KEY.slice(0, 20)}-wrong-key-typed-by-someone`;
    await w.call('POST', '/api/devices', { body: { key: typed, kind: 'pc' } });
    const rows = w.db.raw.prepare('SELECT * FROM entrance_daily').all() as Record<string, unknown>[];
    expect(rows).toEqual([{ day: '2026-11-20', failed: 1 }]);
    const all = JSON.stringify([rows, w.db.raw.prepare('SELECT * FROM devices').all()]);
    expect(all).not.toContain('wrong-key-typed');
  });
});

describe('ログを出さない', () => {
  test('ソースに console がない', () => {
    for (const { name, text } of sources) expect(code(text), name).not.toMatch(/\bconsole\b/);
  });
});

describe('時計・乱数・暗号に触れるのは runtime.ts だけ', () => {
  test('Date.now・crypto は、runtime.ts にだけある', () => {
    const users = sources.filter((s) => /\bDate\.now\b|\bcrypto\b|\bMath\.random\b/.test(code(s.text))).map((s) => s.name);
    expect(users).toEqual(['runtime.ts']);
  });
});
