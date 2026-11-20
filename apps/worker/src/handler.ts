// API の入口。/api/ の下だけを受け、ほかは画面の静的ファイルへ渡す。
// 順序：合鍵の設定の確かめ（なければ、すべてを断る）→ health → 書き込みの出どころの確かめ → 端末の登録 → 印の照合 → それぞれの API。
// 記録の中身・合鍵・印を、ログにも、誤りの答えにも出さない（AGENTS.md の 1）。
import { type DeviceKind, isDeviceKind, isUlid, keyProblem, MAX_KEY_LENGTH } from '@clinical-carte/core';
import { z } from 'zod';

import type { Db } from './db.ts';
import { clearCookie, type Device, enter, type EntranceDeps, listDevices, register, removeDevice } from './entrance.ts';
import type { Runtime } from './runtime.ts';

export interface HandlerDeps {
  readonly db: Db;
  /** サーバーの秘密 CARTE_KEY。ない・短い・単純なら、すべての API を断る */
  readonly key: string | undefined;
  readonly runtime: Runtime;
  readonly secureCookies: boolean;
  /** 画面の静的ファイル */
  readonly assets: (request: Request) => Promise<Response>;
}

/** 登録の要求の本文の上限（文字）。合鍵と端末の種類だけなので、小さくてよい */
export const REGISTER_BODY_LIMIT = 2000;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

function json(status: number, body: unknown, setCookie?: string | null): Response {
  const headers = new Headers(JSON_HEADERS);
  if (typeof setCookie === 'string') headers.append('set-cookie', setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

const RegisterBody = z.strictObject({
  key: z.string().min(1).max(MAX_KEY_LENGTH),
  kind: z.custom<DeviceKind>(isDeviceKind),
});

function deviceView(device: Device, currentId: string): { id: string; kind: DeviceKind; registeredOn: string; lastUsedOn: string; current: boolean } {
  return { ...device, current: device.id === currentId };
}

/** 書き込み（GET・HEAD 以外）は、自分のオリジンの画面からだけ受ける。 */
function writeProblem(request: Request, url: URL): string | null {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== url.origin) return 'origin';
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return 'origin';
  if (request.method !== 'DELETE' && !(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return 'content_type';
  return null;
}

async function api(request: Request, url: URL, deps: HandlerDeps): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  // 鍵なしで動かさない：設定がない・弱いときは、health も含めて、すべてを断る
  if (keyProblem(deps.key) !== null || deps.key === undefined) return json(500, { error: 'no_key' });
  const entrance: EntranceDeps = { db: deps.db, key: deps.key, runtime: deps.runtime, secureCookies: deps.secureCookies };

  if (path === '/api/health' && method === 'GET') return json(200, { ok: true });

  const problem = writeProblem(request, url);
  if (problem !== null) return json(403, { error: problem });

  const cookie = request.headers.get('cookie');

  if (path === '/api/devices' && method === 'POST') {
    const raw = await request.text();
    if (raw.length > REGISTER_BODY_LIMIT) return json(400, { error: 'bad_request' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json(400, { error: 'bad_request' });
    }
    const body = RegisterBody.safeParse(parsed);
    if (!body.success) return json(400, { error: 'bad_request' });
    const already = await enter(cookie, entrance);
    const result = await register({ key: body.data.key, kind: body.data.kind, replace: already?.device.id ?? null }, entrance);
    if (result.ok) return json(200, { device: deviceView(result.device, result.device.id) }, result.setCookie);
    if (result.reason === 'wrong_key') return json(401, { error: 'wrong_key', left: result.left });
    if (result.reason === 'locked') return json(429, { error: 'locked' });
    return json(409, { error: 'too_many_devices' });
  }

  const entered = await enter(cookie, entrance);
  if (entered === null) return json(401, { error: 'unregistered' });
  const me = entered.device;

  if (path === '/api/session' && method === 'GET') return json(200, { device: deviceView(me, me.id) }, entered.renew);

  if (path === '/api/devices' && method === 'GET') {
    const devices = await listDevices(deps.db);
    return json(200, { devices: devices.map((d) => deviceView(d, me.id)) }, entered.renew);
  }

  const one = /^\/api\/devices\/([^/]+)$/.exec(path);
  if (one && method === 'DELETE') {
    const id = one[1] ?? '';
    if (!isUlid(id)) return json(400, { error: 'bad_request' });
    const removed = await removeDevice(deps.db, id);
    if (removed === 0) return json(404, { error: 'not_found' });
    // この端末を外したら、印も消す
    return json(200, { removed: id }, id === me.id ? clearCookie(deps.secureCookies) : entered.renew);
  }

  return json(404, { error: 'not_found' }, entered.renew);
}

export async function handle(request: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return deps.assets(request);
  try {
    return await api(request, url, deps);
  } catch {
    // 何が起きたかを、答えにもログにも出さない（中身が混ざりうるため）
    return json(500, { error: 'server' });
  }
}
