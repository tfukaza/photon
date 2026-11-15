import { afterEach, expect, it, vi } from 'vitest';
import { harness, input, password } from './helpers.js';
import { readConfig } from '../apps/server/src/config.js';

const contexts: Awaited<ReturnType<typeof harness>>[] = [];
/** Starts an isolated password-free test instance and registers its cleanup. */
async function create() { const context = await harness({ devNoAuth: true }); contexts.push(context); return context; }
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const context of contexts.splice(0)) await context.close();
});

it.each([undefined, '0', 'false', 'true', '1'])('enables password-free testing only for the exact opt-in value: %s', value => {
  vi.stubEnv('PHOTON_DEV_NO_AUTH', value);
  expect(readConfig().devNoAuth).toBe(value === '1');
});

it('allows local device management without an owner, password, cookie, or manufactured session', async () => {
  const c = await create();
  expect((await c.http.inject('/api/v1/setup')).json()).toMatchObject({ initialized: false, authenticationRequired: false });
  expect((await c.http.inject('/api/v1/session')).json()).toEqual({ authenticated: true });
  expect((await c.http.inject('/api/v1/devices')).statusCode).toBe(200);
  const response = await c.http.inject({ method: 'POST', url: '/api/v1/commissioning', payload: input });
  expect(response.statusCode).toBe(202);
  await expect.poll(() => c.hub.operation(response.json().id).status).toBe('completed');
  const command = await c.http.inject({ method: 'POST', url: '/api/v1/devices/fake-light/endpoints/1/commands', payload: { type: 'power', value: true } });
  expect(command.statusCode).toBe(202);
  expect(c.auth.initialized()).toBe(false);
  expect(c.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(0);
});

it('preserves owner credentials, setup tokens, and existing sessions when access endpoints are called during bypass', async () => {
  let c = await harness({ devNoAuth: true });
  try {
    const token = c.auth.issueSetupToken();
    expect((await c.http.inject({ method: 'POST', url: '/api/v1/setup', payload: { token, password } })).statusCode).toBe(409);
    await c.auth.setup(token, password);
    const session = await c.auth.login(password);
    const before = c.store.db.prepare('SELECT * FROM owner').all();
    for (const method of ['POST', 'DELETE'] as const) {
      const response = await c.http.inject({ method, url: '/api/v1/session', headers: { cookie: `photon_session=${session}` },
        ...(method === 'POST' ? { payload: { password: 'ignored' } } : {}) });
      expect(response.json()).toEqual({ authenticated: true });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(c.store.db.prepare('SELECT * FROM owner').all()).toEqual(before);
    expect(c.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count).toBe(1);
    expect(c.auth.valid(session)).toBe(true);
    const directory = c.directory;
    await c.close(false);
    c = await harness({ dataDir: directory });
    expect((await c.http.inject('/api/v1/setup')).json().authenticationRequired).toBe(true);
    expect((await c.http.inject('/api/v1/devices')).statusCode).toBe(401);
    expect((await c.http.inject({ url: '/api/v1/devices', headers: { cookie: `photon_session=${session}` } })).statusCode).toBe(200);
    await expect(c.auth.login(password)).resolves.toBeTypeOf('string');
  } finally { await c.close(); }
});

it('still rejects invalid hosts, cross-origin writes, wrong content types, and malformed inputs', async () => {
  const c = await create();
  expect((await c.http.inject({ url: '/api/v1/devices', headers: { host: 'evil.example' } })).statusCode).toBe(403);
  for (const headers of [{ origin: 'https://example.com' }, { 'sec-fetch-site': 'cross-site' }]) {
    expect((await c.http.inject({ method: 'POST', url: '/api/v1/commissioning', payload: input, headers })).statusCode).toBe(403);
  }
  expect((await c.http.inject({ method: 'POST', url: '/api/v1/commissioning', headers: { 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
  expect((await c.http.inject({ method: 'POST', url: '/api/v1/commissioning', payload: {} })).statusCode).toBe(400);
});

it('streams the snapshot, heartbeat, and live operations without a session cookie', async () => {
  const c = await create();
  await c.http.listen({ host: '127.0.0.1', port: 0 });
  const address = c.http.server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, { signal: AbortSignal.timeout(5000) });
  const reader = response.body!.getReader();
  let text = '';
  try {
    while (!text.includes(': heartbeat')) {
      const chunk = await reader.read(); expect(chunk.done).toBe(false);
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain('"type":"snapshot"');
    c.hub.commission(input);
    while (!text.includes('"type":"operation"')) {
      const chunk = await reader.read(); expect(chunk.done).toBe(false);
      text += new TextDecoder().decode(chunk.value);
    }
  } finally { await reader.cancel(); }
});
