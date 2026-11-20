// 手元のサーバー（試験・E2E 用）：ビルドした画面（静的ファイル。_headers のヘッダつき）と、本物の API の処理（handler）を、1つのオリジンで配る。
// 保存先は、メモリの中の node:sqlite（止めると消える）。実データを入れない。
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';

import { handle } from '../src/handler.ts';
import { type Clock, openDb, type TestDb, testRuntime } from './support.ts';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** `_headers`（Cloudflare の形式）を読む：道（末尾が `*` なら、その前までの一致）→ ヘッダ。当たる規則のヘッダは、すべて付く。 */
export function headersFor(rulesText: string): (pathname: string) => Record<string, string> {
  const rules: { path: string; headers: [string, string][] }[] = [];
  for (const line of rulesText.split('\n')) {
    if (line.trim() === '') continue;
    if (!line.startsWith(' ')) rules.push({ path: line.trim(), headers: [] });
    else {
      const colon = line.indexOf(':');
      rules.at(-1)?.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
  }
  return (pathname) => {
    const out: Record<string, string> = {};
    for (const rule of rules) {
      const hit = rule.path.endsWith('*') ? pathname.startsWith(rule.path.slice(0, -1)) : pathname === rule.path;
      if (hit) for (const [name, value] of rule.headers) out[name] = value;
    }
    return out;
  };
}

export interface DevServer {
  readonly url: string;
  readonly db: TestDb;
  readonly clock: Clock;
  close(): Promise<void>;
}

export async function startDevServer(options: { dist: string; key: string | undefined }): Promise<DevServer> {
  const db = openDb();
  const clock: Clock = { ms: Date.UTC(2026, 10, 20, 3, 0) };
  const runtime = testRuntime(clock);
  const headerRules = headersFor(await readFile(join(options.dist, '_headers'), 'utf8').catch(() => ''));

  const assets = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    const relative = normalize(pathname === '/' ? '/index.html' : pathname);
    if (relative.includes('..')) return new Response('not found', { status: 404 });
    try {
      const body = await readFile(join(options.dist, relative));
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-type': MIME[extname(relative)] ?? 'application/octet-stream', ...headerRules(pathname) },
      });
    } catch {
      return new Response('not found', { status: 404, headers: headerRules(pathname) });
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(', '));
      }
      const method = req.method ?? 'GET';
      const init: RequestInit = { method, headers };
      if (method !== 'GET' && method !== 'HEAD') init.body = new Uint8Array(Buffer.concat(chunks));
      const request = new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, init);
      // 手元は http なので、印に Secure と __Host- を付けない
      const response = await handle(request, { db, key: options.key, runtime, secureCookies: false, assets });
      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') res.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    db,
    clock,
    close: () =>
      new Promise<void>((done, fail) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) fail(error);
          else done();
        });
      }),
  };
}
