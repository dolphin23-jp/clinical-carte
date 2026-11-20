// apps/worker/migrations/*.sql を、サーバーが読める形（apps/worker/src/migrations.gen.ts）にする。
// サーバーは、起動のとき、まだ適用していない migrations を、自分で適用する（apps/worker/src/schema.ts）。
// 表を作る SQL の正本は、migrations/ の .sql。このファイルが作る .gen.ts は、その写し（手で直さない）。
//   node scripts/build_migrations.mjs          … 書き出す
//   node scripts/build_migrations.mjs --check  … 古くないかだけ確かめる（違えば 1 で終わる）
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '..', 'apps', 'worker', 'migrations');
const OUT = resolve(import.meta.dirname, '..', 'apps', 'worker', 'src', 'migrations.gen.ts');

/** SQL を、1つずつの文に分ける：コメント（-- から行末）を除き、「;」で分ける。文字列（'…'）の中の「;」「--」は、文の一部として残す */
export function statementsOf(sql) {
  const out = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      current += c;
      if (c === "'") inString = false;
    } else if (c === "'") {
      current += c;
      inString = true;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      current += '\n';
    } else if (c === ';') {
      out.push(current);
      current = '';
    } else current += c;
  }
  if (inString) throw new Error('文字列が閉じていない');
  out.push(current);
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s !== '');
}

const names = readdirSync(DIR).filter((n) => n.endsWith('.sql')).sort();
for (const [i, name] of names.entries()) {
  if (!new RegExp(`^${String(i).padStart(4, '0')}_[a-z_]+\\.sql$`).test(name)) throw new Error(`名前は、0000_ から続く番号にする：${name}`);
}
const migrations = names.map((name) => ({ name: name.replace(/\.sql$/, ''), statements: statementsOf(readFileSync(join(DIR, name), 'utf8')) }));

const body = `// このファイルは scripts/build_migrations.mjs が作る。手で直さない。正本は apps/worker/migrations/*.sql。

export interface Migration {
  readonly name: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = ${JSON.stringify(migrations, null, 2)};
`;

if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== body) {
    process.stderr.write('apps/worker/src/migrations.gen.ts が、migrations/ と違います。node scripts/build_migrations.mjs で作り直してください。\n');
    process.exit(1);
  }
  process.stdout.write(`同じです（${String(migrations.length)} 件）。\n`);
} else if (process.argv[1] === import.meta.filename) {
  writeFileSync(OUT, body);
  process.stdout.write(`書き出した：${migrations.map((m) => m.name).join(', ')}\n`);
}
