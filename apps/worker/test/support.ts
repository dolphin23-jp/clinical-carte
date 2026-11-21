// 試験の道具：D1 の代役（node:sqlite。本番と同じ SQL と、同じ migrations を使う）と、決まった時計・乱数。
import { resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { toHex } from '@clinical-carte/core';

import type { OrganizeAnswer, SelectionAnswer } from '@clinical-carte/core';

import type { Db, Statement } from '../src/db.ts';
import { handle, type HandlerDeps } from '../src/handler.ts';
import { MIGRATIONS as MIGRATION_LIST } from '../src/migrations.gen.ts';
import { type Runtime, webRuntime } from '../src/runtime.ts';
import type { DiscussResult, DrafterResult, LinkerResult, Organizer, OrganizerResult, ProposerResult, ResearchResult } from '../src/organizer.ts';
import type { OrganizePromptChoice } from '../src/prompt.ts';
import type { Selector, SelectorResult } from '../src/selector.ts';

export const MIGRATIONS = resolve(import.meta.dirname, '..', 'migrations');

export interface TestDb extends Db {
  readonly raw: DatabaseSync;
  /** これまでに動かした SQL（書き込みの一覧の試験が読む） */
  readonly log: string[];
}

export function openDb(options: { empty?: boolean } = {}): TestDb {
  const raw = new DatabaseSync(':memory:');
  // 本番と同じ文（migrations.gen.ts。サーバーが自分で適用するもの）で、表を作る
  if (options.empty !== true) for (const migration of MIGRATION_LIST) for (const sql of migration.statements) raw.exec(sql);
  const log: string[] = [];
  const statement = (sql: string, values: readonly unknown[]): Statement => ({
    bind: (...next) => statement(sql, next),
    first: () => {
      log.push(sql);
      return Promise.resolve(raw.prepare(sql).get(...(values as SQLInputValue[])) ?? null);
    },
    all: () => {
      log.push(sql);
      return Promise.resolve({ results: raw.prepare(sql).all(...(values as SQLInputValue[])) });
    },
    run: () => {
      log.push(sql);
      const r = raw.prepare(sql).run(...(values as SQLInputValue[]));
      return Promise.resolve({ meta: { changes: Number(r.changes) } });
    },
  });
  return {
    raw,
    log,
    prepare: (sql) => statement(sql, []),
    // 本番（D1）の batch と同じく、全部できるか、全部できないか
    batch: async (statements) => {
      raw.exec('BEGIN');
      try {
        for (const s of statements) await s.run();
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/** 試験用の合鍵（実行時に組み立てる。長くて、字の種類が多い）。 */
export const TEST_KEY = toHex(Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256));

export interface Clock {
  ms: number;
}

/** 決まった時計と、数えるだけの乱数（同じ入力から、同じ結果）。ハッシュは本物。 */
export function testRuntime(clock: Clock): Runtime {
  let counter = 0;
  return {
    now: () => clock.ms,
    randomBytes: (length) => {
      counter += 1;
      return Uint8Array.from({ length }, (_, i) => (counter * 31 + i * 7) % 256);
    },
    sha256Hex: (value) => webRuntime.sha256Hex(value),
  };
}

export const ORIGIN = 'https://carte.test';

export interface World {
  readonly db: TestDb;
  readonly clock: Clock;
  readonly deps: HandlerDeps;
  call(method: string, path: string, options?: { body?: unknown; cookie?: string | null; headers?: Record<string, string>; rawBody?: string }): Promise<Response>;
}

export function world(overrides: Partial<HandlerDeps> = {}): World {
  const db = openDb();
  const clock: Clock = { ms: Date.UTC(2026, 10, 20, 3, 0) };
  const deps: HandlerDeps = {
    db,
    key: TEST_KEY,
    runtime: testRuntime(clock),
    secureCookies: true,
    assets: () => Promise.resolve(new Response('画面', { status: 200 })),
    selector: fakeSelector(),
    dailyAiLimit: 0,
    model: 'test-model',
    organizer: fakeOrganizer(),
    ...overrides,
  };
  return {
    db,
    clock,
    deps,
    call: (method, path, options = {}) => {
      const headers = new Headers(options.headers);
      const hasBody = options.body !== undefined || options.rawBody !== undefined;
      if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json');
      if (typeof options.cookie === 'string') headers.set('cookie', options.cookie);
      const init: RequestInit = { method, headers };
      if (hasBody) init.body = options.rawBody ?? JSON.stringify(options.body);
      return handle(new Request(`${ORIGIN}${path}`, init), deps);
    },
  };
}

/** Set-Cookie から、次の要求に付ける「名前=値」を取り出す。 */
export function cookieOf(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (header === null) throw new Error('Set-Cookie がない');
  return header.split(';')[0] ?? '';
}

export async function registered(w: World, kind = 'iphone'): Promise<{ cookie: string; id: string }> {
  const response = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind } });
  if (response.status !== 200) throw new Error(`登録できない: ${String(response.status)}`);
  const body = (await response.json()) as { device: { id: string } };
  return { cookie: cookieOf(response), id: body.device.id };
}

type Identifier = SelectionAnswer['identifiers'][number];

export interface FakeSelector extends Selector {
  /** 選別に渡された文（何が AI に届くかを、試験が確かめる） */
  readonly seen: string[];
}

/**
 * AI の選別の代役：渡した語が文にあれば、その場所を指す（文にない語は、指さない）。
 * 本物の AI の賢さは、ここでは試さない（評価の道具 eval/ が受け持つ）。試すのは、指された後の、決定論の流れ。
 */
export function fakeSelector(known: readonly Omit<Identifier, 'facility'>[] = [], override?: (text: string) => SelectorResult): FakeSelector {
  const seen: string[] = [];
  return {
    seen,
    select: (text) => {
      seen.push(text);
      if (override !== undefined) return Promise.resolve(override(text));
      const identifiers: Identifier[] = known.filter((k) => text.includes(k.quote)).map((k) => ({ ...k, facility: null }));
      return Promise.resolve({ ok: true, answer: { identifiers } });
    },
  };
}

export const EMPTY_ORGANIZE: OrganizeAnswer = { kind: null, when: null, segments: [], medications: [], events: [], problems: [], measurements: [] };

export interface FakeOrganizer extends Organizer {
  /** 整理に渡された文（何が AI に届くかを、試験が確かめる） */
  readonly seen: string[];
  /** 整理の指示の選び先（本番は、いつも current。評価だけが previous を選べる） */
  readonly prompts: OrganizePromptChoice[];
  /** つなぎに渡された資料（JSON） */
  readonly linked: string[];
  /** 草案に渡された資料（JSON） */
  readonly drafted: string[];
  /** 参照元の検索・A/P の案・議論に渡された資料（JSON） */
  readonly researched: string[];
  readonly proposed: string[];
  readonly discussed: string[];
}

export interface FakeApAnswers {
  readonly research?: (message: string) => ResearchResult;
  readonly propose?: (message: string) => ProposerResult;
  readonly discuss?: (message: string) => DiscussResult;
}

/** AI の整理の代役：文を受け取り、決めた答えを返す（既定は、何も見つけない）。つなぎは、既定では何もつながない */
export function fakeOrganizer(
  answer: (text: string, prompt: OrganizePromptChoice) => OrganizerResult = () => ({ ok: true, answer: EMPTY_ORGANIZE }),
  link: (message: string) => LinkerResult = () => ({ ok: true, answer: { links: [] } }),
  draft: (message: string) => DrafterResult = () => ({ ok: true, answer: { sections: [] } }),
  ap: FakeApAnswers = {},
): FakeOrganizer {
  const researched: string[] = [];
  const proposed: string[] = [];
  const discussed: string[] = [];
  const seen: string[] = [];
  const prompts: OrganizePromptChoice[] = [];
  const linked: string[] = [];
  const drafted: string[] = [];
  return {
    seen,
    prompts,
    linked,
    drafted,
    researched,
    proposed,
    discussed,
    research: (message) => {
      researched.push(message);
      return Promise.resolve(ap.research?.(message) ?? { ok: true, hits: [] });
    },
    propose: (message) => {
      proposed.push(message);
      return Promise.resolve(ap.propose?.(message) ?? { ok: true, answer: { problems: [] } });
    },
    discuss: (message) => {
      discussed.push(message);
      return Promise.resolve(ap.discuss?.(message) ?? { ok: true, answer: { paragraphs: [] } });
    },
    organize: (text, prompt = 'current') => {
      seen.push(text);
      prompts.push(prompt);
      return Promise.resolve(answer(text, prompt));
    },
    link: (message) => {
      linked.push(message);
      return Promise.resolve(link(message));
    },
    draft: (message) => {
      drafted.push(message);
      return Promise.resolve(draft(message));
    },
  };
}
