// 保存先（Cloudflare D1）の、使う分だけの形。D1 の型の依存を入れず、試験では node:sqlite の代役を同じ形で渡す。
export interface Statement {
  bind(...values: readonly unknown[]): Statement;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface Db {
  prepare(sql: string): Statement;
  /** いくつかの書き込みを、まとめて行う（全部できるか、全部できないか） */
  batch(statements: Statement[]): Promise<unknown>;
}

export function text(row: Record<string, unknown> | null | undefined, column: string): string | null {
  const v = row?.[column];
  return typeof v === 'string' ? v : null;
}

export function int(row: Record<string, unknown> | null | undefined, column: string): number | null {
  const v = row?.[column];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

export function real(row: Record<string, unknown> | null | undefined, column: string): number | null {
  const v = row?.[column];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
