import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../apps/server/src/store.js';
import { Auth } from '../apps/server/src/auth.js';
import { Hub } from '../apps/server/src/hub.js';
import { FakeAdapter } from '../apps/server/src/adapter.js';
import { createHttp } from '../apps/server/src/http.js';
import type { Config } from '../apps/server/src/config.js';

export const password = 'correct horse photon battery';
export const setupCode = '34970112332';
export const input = { code: setupCode, transport: 'on-network' as const, country: 'US' };

/** Starts an isolated application with real disk persistence and a controlled transport. */
export async function harness(overrides: Partial<Config> = {}) {
  const directory = overrides.dataDir ?? await mkdtemp(join(tmpdir(), 'photon-test-'));
  const config: Config = { dataDir: directory, port: 0, mode: 'fake', hciId: 0,
    trustFile: resolve('assets/trust.json'), webDir: resolve('apps/web/dist'),
    commandTimeoutMs: 100, commissionTimeoutMs: 100, sessionTtlMs: 100_000, devNoAuth: false, ...overrides };
  const store = new Store(directory);
  const auth = new Auth(store, config.sessionTtlMs);
  const adapter = new FakeAdapter();
  const hub = new Hub(store, adapter, config);
  const http = await createHttp(config, hub, auth);
  await hub.start();
  return { directory, config, store, auth, adapter, hub, http,
    async close(remove = true) { await http.close(); await hub.close(); store.close(); if (remove) await rm(directory, { recursive: true, force: true }); } };
}

/** Creates an owner and returns the browser's real session cookie. */
export async function signIn(context: Awaited<ReturnType<typeof harness>>) {
  if (!context.auth.initialized()) await context.auth.setup(context.auth.issueSetupToken(), password);
  const response = await context.http.inject({ method: 'POST', url: '/api/v1/session', payload: { password } });
  return response.headers['set-cookie']!.toString().split(';')[0];
}
