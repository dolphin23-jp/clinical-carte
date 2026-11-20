// 入口（CA-016・CA-019）：鍵なしで動かさない。端末の登録は1回だけ。以後は印で通る。
import { MAX_DEVICES, MAX_FAILED_PER_DAY, TOKEN_MAX_AGE_SECONDS } from '@clinical-carte/core';
import { describe, expect, test } from 'vitest';

import { REGISTER_BODY_LIMIT } from '../src/handler.ts';
import { cookieOf, ORIGIN, registered, TEST_KEY, world } from './support.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('鍵なしで動かさない', () => {
  test.each([
    ['ない', undefined],
    ['空', ''],
    ['短い', 'short-key'],
    ['同じ字の繰り返し', 'a'.repeat(64)],
  ])('合鍵の設定が%sとき、health も含めて、すべての API を断る', async (_name, key) => {
    const w = world({ key });
    for (const [method, path] of [['GET', '/api/health'], ['GET', '/api/session'], ['GET', '/api/devices'], ['GET', '/api/anything']] as const) {
      const r = await w.call(method, path);
      expect(r.status, path).toBe(500);
      expect(await r.json()).toEqual({ error: 'no_key' });
    }
    const r = await w.call('POST', '/api/devices', { body: { key: key ?? '', kind: 'pc' } });
    expect(r.status).toBe(500);
    expect(w.db.log).toEqual([]); // 保存先にも触れない
  });
});

describe('登録していない端末', () => {
  test('health だけが通る。答えは ok だけ', async () => {
    const w = world();
    const r = await w.call('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  test('ほかの API は、あるものも、ないものも、401', async () => {
    const w = world();
    for (const path of ['/api/session', '/api/devices', '/api/patients', '/api/x/y', '/api/']) {
      const r = await w.call('GET', path);
      expect(r.status, path).toBe(401);
      expect(await r.json()).toEqual({ error: 'unregistered' });
    }
  });

  test('形の違う印・知らない端末の印・秘密の違う印では、通らない', async () => {
    const w = world();
    const { cookie } = await registered(w);
    const [name, value = ''] = cookie.split('=');
    const [deviceId = '', secret = ''] = value.split('.');
    // 秘密の最後の1字が違う印、id の最後の1字が違う印（知らない端末）
    const flipped = `${deviceId}.${secret.slice(0, -1)}${secret.endsWith('0') ? '1' : '0'}`;
    const otherId = `${deviceId.slice(0, -1)}${deviceId.endsWith('0') ? '1' : '0'}.${secret}`;
    expect(otherId).not.toBe(value);
    for (const bad of [`${String(name)}=abc`, `${String(name)}=${flipped}`, `${String(name)}=${otherId}`, `x${cookie}`, `${cookie}; ${cookie}`]) {
      expect((await w.call('GET', '/api/session', { cookie: bad })).status, bad.length.toString()).toBe(401);
    }
    expect((await w.call('GET', '/api/session', { cookie })).status).toBe(200);
  });

  test('/api の外は、画面の静的ファイルへ渡す', async () => {
    const w = world();
    expect(await (await w.call('GET', '/')).text()).toBe('画面');
    expect(await (await w.call('GET', '/apix')).text()).toBe('画面');
  });
});

describe('端末の登録', () => {
  test('合鍵が合えば、印を出す：HttpOnly・Secure・SameSite=Strict・__Host-・長い期限', async () => {
    const w = world();
    const r = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'iphone' } });
    expect(r.status).toBe(200);
    const set = r.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^__Host-carte=[0-9A-Z]{26}\.[0-9a-f]{64}; /);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/');
    expect(set).toContain(`Max-Age=${String(TOKEN_MAX_AGE_SECONDS)}`);
    expect(set).not.toContain('Domain');
    const body = (await r.json()) as { device: Record<string, unknown> };
    expect(body.device).toMatchObject({ kind: 'iphone', registeredOn: '2026-11-20', lastUsedOn: '2026-11-20', current: true });
  });

  test('答えにも、保存先にも、合鍵・端末の秘密そのものを置かない', async () => {
    const w = world();
    const r = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'pc' } });
    const secret = (cookieOf(r).split('.')[1] ?? '').trim();
    expect(secret).toHaveLength(64);
    const text = await r.text();
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain(secret);
    const stored = JSON.stringify(w.db.raw.prepare('SELECT * FROM devices').all());
    expect(stored).not.toContain(TEST_KEY);
    expect(stored).not.toContain(secret);
  });

  test('合鍵が違えば 401。間違いを日ごとに数え、残りの回数を返す', async () => {
    const w = world();
    const r = await w.call('POST', '/api/devices', { body: { key: `${TEST_KEY}x`, kind: 'pc' } });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'wrong_key', left: MAX_FAILED_PER_DAY - 1 });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(w.db.raw.prepare('SELECT * FROM entrance_daily').all()).toEqual([{ day: '2026-11-20', failed: 1 }]);
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
  });

  test('間違いが上限に達した日は、合っていても受け付けない。次の日には受け付ける。登録済みの端末は使える', async () => {
    const w = world();
    const mine = await registered(w);
    for (let i = 0; i < MAX_FAILED_PER_DAY; i++) {
      expect((await w.call('POST', '/api/devices', { body: { key: 'wrong'.repeat(10), kind: 'pc' } })).status).toBe(401);
    }
    const locked = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'pc' } });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: 'locked' });
    expect((await w.call('GET', '/api/session', { cookie: mine.cookie })).status).toBe(200);
    w.clock.ms += DAY;
    expect((await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'pc' } })).status).toBe(200);
  });

  test('形の違う要求は 400：本文が JSON でない・欄が足りない・余計な欄・知らない種類・長すぎる', async () => {
    const w = world();
    const bad: { body?: unknown; rawBody?: string }[] = [
      { rawBody: '{' },
      { body: { key: TEST_KEY } },
      { body: { kind: 'pc' } },
      { body: { key: TEST_KEY, kind: 'pc', name: 'x' } },
      { body: { key: TEST_KEY, kind: 'android' } },
      { body: { key: '', kind: 'pc' } },
      { body: { key: 'k'.repeat(REGISTER_BODY_LIMIT + 1), kind: 'pc' } },
      { body: [TEST_KEY, 'pc'] },
    ];
    for (const options of bad) {
      const r = await w.call('POST', '/api/devices', options);
      expect(r.status, JSON.stringify(options).slice(0, 40)).toBe(400);
    }
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM entrance_daily').get()).toEqual({ n: 0 }); // 形の違いは、合鍵の間違いに数えない
  });

  test(`端末は ${String(MAX_DEVICES)} 台まで`, async () => {
    const w = world();
    for (let i = 0; i < MAX_DEVICES; i++) await registered(w, 'pc');
    const r = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'pc' } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'too_many_devices' });
  });

  test('登録済みの端末がもう一度登録すると、古い登録と入れ替わる（増えない）', async () => {
    const w = world();
    const first = await registered(w, 'iphone');
    const r = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'ipad' }, cookie: first.cookie });
    expect(r.status).toBe(200);
    const second = cookieOf(r);
    expect(w.db.raw.prepare('SELECT kind FROM devices').all()).toEqual([{ kind: 'ipad' }]);
    expect((await w.call('GET', '/api/session', { cookie: first.cookie })).status).toBe(401);
    expect((await w.call('GET', '/api/session', { cookie: second })).status).toBe(200);
  });
});

describe('登録した端末', () => {
  test('ログインなしで通る。同じ日は、保存先に書かない・印を出し直さない', async () => {
    const w = world();
    const { cookie, id } = await registered(w);
    w.db.log.length = 0;
    const r = await w.call('GET', '/api/session', { cookie });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ device: { id, kind: 'iphone', registeredOn: '2026-11-20', lastUsedOn: '2026-11-20', current: true } });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(w.db.log.filter((sql) => !sql.startsWith('SELECT'))).toEqual([]);
  });

  test('日が変わって最初に使ったとき：使った日を書き、印の期限を延ばす（1日に1回）', async () => {
    const w = world();
    const { cookie } = await registered(w);
    w.clock.ms += 3 * DAY;
    w.db.log.length = 0;
    const r = await w.call('GET', '/api/session', { cookie });
    expect(cookieOf(r)).toBe(cookie);
    expect(r.headers.get('set-cookie')).toContain(`Max-Age=${String(TOKEN_MAX_AGE_SECONDS)}`);
    expect(((await r.json()) as { device: { lastUsedOn: string } }).device.lastUsedOn).toBe('2026-11-23');
    expect(w.db.log.filter((sql) => sql.startsWith('UPDATE'))).toHaveLength(1);
    w.db.log.length = 0;
    expect((await w.call('GET', '/api/session', { cookie })).headers.get('set-cookie')).toBeNull();
    expect(w.db.log.filter((sql) => !sql.startsWith('SELECT'))).toEqual([]);
  });

  test('端末の一覧：この端末に印が付く。照合用の値は返さない', async () => {
    const w = world();
    const a = await registered(w, 'iphone');
    const b = await registered(w, 'pc');
    const r = await w.call('GET', '/api/devices', { cookie: b.cookie });
    const text = await r.clone().text();
    expect(text).not.toContain('secret');
    expect(((await r.json()) as { devices: { id: string; current: boolean }[] }).devices.map((d) => [d.id, d.current])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
  });

  test('なくした端末を、別の端末から外せる。外した端末の印は、通らなくなる', async () => {
    const w = world();
    const lost = await registered(w, 'iphone');
    const mine = await registered(w, 'pc');
    const r = await w.call('DELETE', `/api/devices/${lost.id}`, { cookie: mine.cookie });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ removed: lost.id });
    expect((await w.call('GET', '/api/session', { cookie: lost.cookie })).status).toBe(401);
    expect((await w.call('GET', '/api/session', { cookie: mine.cookie })).status).toBe(200);
    expect((await w.call('DELETE', `/api/devices/${lost.id}`, { cookie: mine.cookie })).status).toBe(404);
    expect((await w.call('DELETE', '/api/devices/not-an-id', { cookie: mine.cookie })).status).toBe(400);
  });

  test('この端末を外すと、印も消す', async () => {
    const w = world();
    const mine = await registered(w);
    const r = await w.call('DELETE', `/api/devices/${mine.id}`, { cookie: mine.cookie });
    expect(r.headers.get('set-cookie')).toMatch(/^__Host-carte=; .*Max-Age=0/);
    expect((await w.call('GET', '/api/session', { cookie: mine.cookie })).status).toBe(401);
  });

  test('まだない API は 404（登録した端末にだけ、そう答える）', async () => {
    const w = world();
    const { cookie } = await registered(w);
    expect((await w.call('GET', '/api/patients', { cookie })).status).toBe(404);
  });
});

describe('書き込みは、自分のオリジンの画面からだけ', () => {
  test('ほかのオリジンからの書き込みは 403（印があっても）', async () => {
    const w = world();
    const mine = await registered(w);
    const other = await registered(w, 'pc');
    for (const headers of [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      const r = await w.call('DELETE', `/api/devices/${other.id}`, { cookie: mine.cookie, headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      const reg = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'pc' }, headers });
      expect(reg.status).toBe(403);
    }
    expect(w.db.raw.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 2 });
  });

  test('自分のオリジンからは通る', async () => {
    const w = world();
    const r = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'pc' }, headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } });
    expect(r.status).toBe(200);
  });

  test('本文つきの書き込みは、JSON だけ（フォームからの送信を受けない）', async () => {
    const w = world();
    const r = await w.call('POST', '/api/devices', { rawBody: JSON.stringify({ key: TEST_KEY, kind: 'pc' }), headers: { 'content-type': 'text/plain' } });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'content_type' });
  });
});

describe('答えの形', () => {
  test('API の答えは、キャッシュさせない', async () => {
    const w = world();
    const { cookie } = await registered(w);
    for (const r of [await w.call('GET', '/api/health'), await w.call('GET', '/api/session', { cookie }), await w.call('GET', '/api/session')]) {
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  test('保存先が壊れていても、何が起きたかを答えに出さない', async () => {
    const w = world({
      db: {
        prepare: () => {
          throw new Error('合鍵や記録の中身が混ざりうる文');
        },
      },
    });
    const r = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'pc' } });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'server' });
  });

  test('手元の http のサーバー（試験）では、Secure と __Host- を付けない', async () => {
    const w = world({ secureCookies: false });
    const r = await w.call('POST', '/api/devices', { body: { key: TEST_KEY, kind: 'pc' } });
    const set = r.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^carte=/);
    expect(set).not.toContain('Secure');
    expect((await w.call('GET', '/api/session', { cookie: cookieOf(r) })).status).toBe(200);
  });
});
