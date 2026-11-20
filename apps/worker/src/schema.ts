// 表の用意（docs/03 の 1）：サーバーが、まだ適用していない migrations を、自分で適用する。
// 配る人が、表を作るコマンドを打たなくてよいようにするため（Cloudflare が自動で配るときの権限には、D1 が入っていない）。
// 表を作る SQL の正本は migrations/*.sql で、ここが読むのは、その写し（migrations.gen.ts）。
import type { Db } from './db.ts';
import { text } from './db.ts';
import { type Migration, MIGRATIONS } from './migrations.gen.ts';

/** 適用した migrations の名前。控えの表がまだなければ（はじめて動かしたとき）、空 */
async function applied(db: Db): Promise<Set<string>> {
  try {
    const { results } = await db.prepare('SELECT name FROM schema_migrations').all();
    return new Set(results.map((row) => text(row, 'name')).filter((name): name is string => name !== null));
  } catch {
    return new Set();
  }
}

/**
 * まだ適用していない migrations を、番号の順に適用する。1件ごとに、全部できるか、全部できないか。
 * 適用した件数を返す。2つの要求が同時に動いても、名前の控えは重ならない（INSERT OR IGNORE）。
 */
export async function ensureSchema(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<number> {
  const done = await applied(db);
  let count = 0;
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    await db.batch([...migration.statements.map((sql) => db.prepare(sql)), db.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').bind(migration.name)]);
    count += 1;
  }
  return count;
}

/** 同じ起動の中では、1回だけ確かめる。失敗したら、次の要求で、もう一度確かめる */
export function schemaGate(db: () => Db): () => Promise<void> {
  let ready: Promise<void> | null = null;
  return () => {
    ready ??= ensureSchema(db()).then(
      () => undefined,
      (error: unknown) => {
        ready = null;
        throw error;
      },
    );
    return ready;
  };
}
