import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, signIn, input, password } from './helpers.js';
import { matterLevel, brightnessPercent } from '../apps/server/src/matter-adapter.js';
import { FakeAdapter } from '../apps/server/src/adapter.js';
import { Hub } from '../apps/server/src/hub.js';

const contexts: Awaited<ReturnType<typeof harness>>[] = [];
/** Registers resources for cleanup even when an assertion fails. */
async function create(overrides: Parameters<typeof harness>[0] = {}) { const context = await harness(overrides); contexts.push(context); return context; }
afterEach(async () => { vi.restoreAllMocks(); for (const context of contexts.splice(0)) await context.close(); });

describe('owner access', () => {
  it('consumes setup tokens atomically and requires authentication', async () => {
    const c = await create(); const token = c.auth.issueSetupToken();
    const responses = await Promise.all([1, 2].map(() => c.http.inject({ method: 'POST', url: '/api/v1/setup', payload: { token, password } })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect((await c.http.inject('/api/v1/devices')).statusCode).toBe(401);
    const cookie = await signIn(c);
    expect((await c.http.inject({ url: '/api/v1/devices', headers: { cookie } })).statusCode).toBe(200);
    expect((await c.http.inject({ method: 'POST', url: '/api/v1/setup', payload: { token, password } })).statusCode).toBe(409);
  });
  it('rejects cross-origin writes, bad passwords, and expired or revoked sessions', async () => {
    const c = await create(); const cookie = await signIn(c);
    expect((await c.http.inject({ method: 'POST', url: '/api/v1/commissioning', headers: { cookie, origin: 'https://example.com' }, payload: input })).statusCode).toBe(403);
    expect((await c.http.inject({ method: 'POST', url: '/api/v1/session', payload: { password: 'wrong' } })).statusCode).toBe(401);
    await c.http.inject({ method: 'DELETE', url: '/api/v1/session', headers: { cookie } });
    expect((await c.http.inject({ url: '/api/v1/devices', headers: { cookie } })).statusCode).toBe(401);
    const next = await signIn(c); await c.auth.reset(password + '-new');
    expect((await c.http.inject({ url: '/api/v1/devices', headers: { cookie: next } })).statusCode).toBe(401);
    await c.auth.login(password + '-new');
    c.store.db.prepare('UPDATE sessions SET expires=0').run();
    expect(c.auth.valid(next.split('=')[1])).toBe(false);
  });
  it('throttles repeated failed login attempts', async () => {
    const c = await create(); await signIn(c);
    for (let i = 0; i < 5; i++) expect((await c.http.inject({ method: 'POST', url: '/api/v1/session', payload: { password: 'wrong' } })).statusCode).toBe(401);
    expect((await c.http.inject({ method: 'POST', url: '/api/v1/session', payload: { password } })).statusCode).toBe(429);
  });
  it('reserves concurrent login attempts before asynchronous password verification', async () => {
    const c = await create(); await signIn(c);
    const responses = await Promise.all(Array.from({ length: 10 }, () => c.http.inject({ method: 'POST', url: '/api/v1/session', payload: { password: 'wrong' } })));
    expect(responses.filter(response => response.statusCode === 429)).toHaveLength(5);
    expect((await c.http.inject({ method: 'POST', url: '/api/v1/session', payload: { password } })).statusCode).toBe(429);
  });
  it('cannot create a usable old-password session across a concurrent reset', async () => {
    const c = await create(); await signIn(c);
    const reset = c.auth.reset(password + '-new');
    const login = c.auth.login(password).catch(() => undefined);
    await reset;
    const token = await login;
    expect(c.auth.valid(token)).toBe(false);
  });
});

describe('device management', () => {
  it('accepts already-configured hardware over the LAN without Wi-Fi credentials or saved-network changes', async () => {
    const c = await create({ mode: 'hardware' }); const cookie = await signIn(c);
    c.store.saveWifi('remembered', 'private-saved-password');
    const transport = vi.spyOn(c.adapter, 'commission');
    const response = await c.http.inject({ method: 'POST', url: '/api/v1/commissioning', headers: { cookie }, payload: input });
    expect(response.statusCode).toBe(202);
    await expect.poll(() => c.hub.operation(response.json().id).status).toBe('completed');
    expect(transport.mock.calls[0][0]).toEqual(input);
    expect(c.store.savedWifi()).toEqual({ ssid: 'remembered', password: 'private-saved-password' });
  });
  it.each([{ ssid: 'network' }, { wifiPassword: 'password' }, { useSavedWifi: true }, { rememberWifi: true }])('rejects network credential fields on LAN-only setup: %j', async fields => {
    const c = await create({ mode: 'hardware' }); const cookie = await signIn(c);
    const transport = vi.spyOn(c.adapter, 'commission'); c.store.saveWifi('remembered', 'saved-password');
    expect((await c.http.inject({ method: 'POST', url: '/api/v1/commissioning', headers: { cookie }, payload: { ...input, ...fields } })).statusCode).toBe(400);
    expect(transport).not.toHaveBeenCalled(); expect(c.store.savedWifi()?.ssid).toBe('remembered');
  });
  it('closes unconfirmed transport observations when a selected device completes instead of inventing BLE success', async () => {
    const c = await create();
    vi.spyOn(c.adapter, 'commission').mockImplementation(async (_input, _signal, report) => {
      report?.({ stage: 'ble-services', title: 'Discover Bluetooth services', detail: 'A candidate is being interviewed.', status: 'running' });
      report?.({ stage: 'pase', title: 'Establish PASE', detail: 'The selected candidate authenticated.', status: 'completed' });
      return 'selected-peer';
    });
    const operation = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(operation.id).status).toBe('completed');
    const events = c.hub.operation(operation.id).timeline!;
    expect(events.map(event => [event.stage, event.status])).toEqual([
      ['ble-services', 'running'], ['pase', 'completed'], ['ble-services', 'interrupted'],
    ]);
    expect(events.at(-1)?.detail).toContain('no transport success is inferred');
  });
  it('persists ordered timestamped stage history and closes a timed-out stage without accepting late updates', async () => {
    const c = await create({ commissionTimeoutMs: 10 });
    let finish!: (id: string) => void;
    let late!: () => void;
    vi.spyOn(c.adapter, 'commission').mockImplementation((_input, _signal, report) => {
      report?.({ stage: 'discovery', title: 'Discover devices', detail: 'Searching for candidates.', status: 'running' });
      late = () => report?.({ stage: 'discovery', title: 'Discover devices', detail: 'Late result.', status: 'completed' });
      return new Promise(resolve => { finish = resolve; });
    });
    const operation = c.hub.commission({ ...input, ssid: 'private-ssid', wifiPassword: 'private-password' });
    await expect.poll(() => c.hub.operation(operation.id).status).toBe('failed');
    const before = c.hub.operation(operation.id);
    expect(before.timeline?.map(event => event.status)).toEqual(['running', 'failed']);
    expect(before.timeline?.every(event => Number.isFinite(Date.parse(event.at)))).toBe(true);
    late(); finish('late-peer');
    await Promise.resolve(); await Promise.resolve();
    expect(c.hub.operation(operation.id)).toEqual(before);
    expect(c.store.operations().find(item => item.id === operation.id)?.timeline).toEqual(before.timeline);
    const restored = new Hub(c.store, new FakeAdapter(), c.config);
    expect(restored.operation(operation.id).timeline).toEqual(before.timeline);
    const json = JSON.stringify(c.store.operations());
    for (const secret of ['private-ssid', 'private-password', input.code]) expect(json).not.toContain(secret);
    await restored.close();
  });
  it('rejects malformed codes before transport work and rejects concurrent onboarding', async () => {
    const c = await create(); const commission = vi.spyOn(c.adapter, 'commission');
    expect(() => c.hub.commission({ ...input, code: '123' })).toThrow('valid Matter');
    expect(commission).not.toHaveBeenCalled();
    const operation = c.hub.commission(input);
    expect(() => c.hub.commission(input)).toThrow('Another device');
    await expect.poll(() => c.hub.operation(operation.id).status).toBe('completed');
    expect(c.hub.snapshot().devices[0].endpoints[0].power).toBe(false);
  });
  it('reports explicit commands, validates capabilities, and serializes per endpoint', async () => {
    const c = await create(); const onboarding = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(onboarding.id).status).toBe('completed');
    const device = c.hub.snapshot().devices[0];
    c.adapter.commandDelayMs = 5;
    const on = c.hub.command(device.id, '1', { type: 'power', value: true });
    const off = c.hub.command(device.id, '1', { type: 'power', value: false });
    await expect.poll(() => c.hub.operation(off.id).status).toBe('completed');
    expect(c.hub.operation(on.id).status).toBe('completed');
    expect(c.hub.snapshot().devices[0].endpoints[0].power).toBe(false);
    c.adapter.update({ ...device, availability: 'offline', stale: true });
    expect(() => c.hub.command(device.id, '1', { type: 'power', value: true })).toThrow('unavailable');
    device.endpoints[0].brightnessSupported = false; c.adapter.update(device);
    expect(() => c.hub.command(device.id, '1', { type: 'brightness', value: 50 })).toThrow('support brightness');
    expect([matterLevel(1), matterLevel(50), matterLevel(100)]).toEqual([3, 127, 254]);
    expect([brightnessPercent(null), brightnessPercent(127), brightnessPercent(254)]).toEqual([null, 50, 100]);
  });
  it('keeps timed-out operations terminal while reconciling late protocol state', async () => {
    const c = await create({ commissionTimeoutMs: 10 });
    let complete!: (id: string) => void;
    vi.spyOn(c.adapter, 'commission').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const operation = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(operation.id).status).toBe('failed');
    expect(() => c.hub.commission(input)).toThrow('Another device');
    c.adapter.update({ id: 'late-peer', name: 'Recovered light', stale: false, availability: 'online', endpoints: [] });
    complete('late-peer');
    await Promise.resolve(); await Promise.resolve();
    expect(c.hub.operation(operation.id).status).toBe('failed');
    expect(c.hub.snapshot().devices[0].id).toBe('late-peer');
    expect(c.store.deviceRecords()[0].id).toBe('late-peer');
  });
  it('keeps endpoint transport work serialized after a command deadline', async () => {
    const c = await create({ commandTimeoutMs: 10 });
    const pairing = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(pairing.id).status).toBe('completed');
    let finish!: () => void;
    const transport = vi.spyOn(c.adapter, 'command').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = c.hub.command('fake-light', '1', { type: 'power', value: true });
    const second = c.hub.command('fake-light', '1', { type: 'power', value: false });
    await expect.poll(() => c.hub.operation(first.id).status).toBe('failed');
    expect(c.hub.operation(second.id).status).toBe('accepted');
    expect(transport).toHaveBeenCalledTimes(1);
    finish();
    await expect.poll(() => c.hub.operation(second.id).status).toBe('completed');
    expect(c.hub.operation(first.id).status).toBe('failed');
  });
  it('allows retry after a transport failure and never persists onboarding secrets', async () => {
    const c = await create(); vi.spyOn(c.adapter, 'commission').mockRejectedValueOnce(new Error('private transport details'));
    const failed = c.hub.commission({ ...input, transport: 'ble', ssid: 'private-network', wifiPassword: 'secret-value' });
    await expect.poll(() => c.hub.operation(failed.id).status).toBe('failed');
    const next = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(next.id).status).toBe('completed');
    const stored = JSON.stringify(c.store.operations());
    expect(stored).not.toContain('secret-value'); expect(stored).not.toContain(input.code); expect(stored).not.toContain('private transport details');
  });
  it('interrupts unfinished work on restart and retains metadata with stale state', async () => {
    const c = await create(); const operation = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(operation.id).status).toBe('completed');
    c.store.saveOperation({ ...operation, id: 'interrupted', status: 'running', timeline: [
      { stage: 'discovery', title: 'Discover devices', detail: 'Scanning for a candidate.', status: 'running', at: operation.createdAt },
      { stage: 'pase', title: 'Establish PASE', detail: 'Waiting for setup-code authentication.', status: 'running', at: operation.createdAt },
    ] });
    const hub = new Hub(c.store, new FakeAdapter(), c.config);
    expect(hub.operation('interrupted').status).toBe('interrupted');
    expect(hub.operation('interrupted').timeline?.map(event => [event.stage, event.status])).toEqual([
      ['discovery', 'running'], ['pase', 'running'], ['discovery', 'interrupted'], ['pase', 'interrupted'],
    ]);
    expect(c.store.operations().find(item => item.id === 'interrupted')?.timeline).toEqual(hub.operation('interrupted').timeline);
    expect(hub.snapshot().devices[0]).toMatchObject({ id: 'fake-light', stale: true, availability: 'connecting' });
    await hub.close();
  });
});

describe('event stream', () => {
  it('buffers changes during the initial snapshot and ends streams on logout', async () => {
    const c = await create(); const cookie = await signIn(c);
    const onboarding = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(onboarding.id).status).toBe('completed');
    const original = c.hub.snapshot.bind(c.hub);
    vi.spyOn(c.hub, 'snapshot').mockImplementationOnce(() => {
      const snapshot = original(); const device = structuredClone(snapshot.devices[0]);
      device.endpoints[0].power = true; c.adapter.update(device); return snapshot;
    });
    await c.http.listen({ host: '127.0.0.1', port: 0 });
    const address = c.http.server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, { headers: { cookie } });
    const reader = response.body!.getReader();
    let data = '';
    while (data.split('\n\n').length < 3) data += new TextDecoder().decode((await reader.read()).value);
    const events = data.split('\n\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(6)));
    expect(events[0].type).toBe('snapshot'); expect(events[0].data.devices[0].endpoints[0].power).toBe(false);
    expect(events[1].type).toBe('device'); expect(events[1].data.endpoints[0].power).toBe(true);
    await c.http.inject({ method: 'DELETE', url: '/api/v1/session', headers: { cookie } });
    expect((await reader.read()).done).toBe(true);
    expect(c.hub.listenerCount('event')).toBe(0);
  });
  it.each(['expiry', 'reset'] as const)('closes established streams after session %s', async reason => {
    const c = await create(); const cookie = await signIn(c);
    await c.http.listen({ host: '127.0.0.1', port: 0 });
    const address = c.http.server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, { headers: { cookie } });
    const reader = response.body!.getReader(); await reader.read();
    if (reason === 'reset') await c.auth.reset(password + '-new');
    else c.store.db.prepare('UPDATE sessions SET expires=0').run();
    let ended = false;
    while (!ended) ended = (await reader.read()).done;
    expect(c.hub.listenerCount('event')).toBe(0);
  });
});


describe('application contract recovery', () => {
  it('keeps reported state independent from successful command acknowledgement', async () => {
    const c = await create();
    const pairing = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(pairing.id).status).toBe('completed');
    const before = c.hub.snapshot().devices[0];
    vi.spyOn(c.adapter, 'command').mockResolvedValueOnce();
    const command = c.hub.command(before.id, '1', { type: 'power', value: true });
    await expect.poll(() => c.hub.operation(command.id).status).toBe('completed');
    expect(c.hub.snapshot().devices[0].endpoints[0].power).toBe(false);
    const report = structuredClone(before);
    report.endpoints[0].power = true;
    c.adapter.update(report);
    expect(c.hub.snapshot().devices[0].endpoints[0].power).toBe(true);
  });

  it('validates command inputs at the HTTP boundary and accepts supported brightness limits', async () => {
    const c = await create(); const cookie = await signIn(c);
    const pairing = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(pairing.id).status).toBe('completed');
    const url = '/api/v1/devices/fake-light/endpoints/1/commands';
    for (const value of [0, 101, 50.5, '50', null]) {
      const response = await c.http.inject({ method: 'POST', url, headers: { cookie }, payload: { type: 'brightness', value } });
      expect(response.statusCode, `invalid brightness ${String(value)}`).toBe(400);
    }
    for (const value of [1, 100]) {
      const response = await c.http.inject({ method: 'POST', url, headers: { cookie }, payload: { type: 'brightness', value } });
      expect(response.statusCode).toBe(202);
      const operation = response.json();
      await expect.poll(() => c.hub.operation(operation.id).status).toBe('completed');
      expect(c.hub.snapshot().devices[0].endpoints[0].brightness).toBe(value);
    }
    const unknown = await c.http.inject({ method: 'POST', url: '/api/v1/devices/missing/endpoints/1/commands', headers: { cookie }, payload: { type: 'power', value: true } });
    expect(unknown.statusCode).toBe(404);
  });

  it('restores identities and interrupted work from reopened disk storage, then reconciles protocol reports', async () => {
    let current = await harness();
    try {
      const pairing = current.hub.commission(input);
      await expect.poll(() => current.hub.operation(pairing.id).status).toBe('completed');
      const device = current.hub.snapshot().devices[0];
      current.store.saveOperation({ ...pairing, id: 'unfinished-before-restart', status: 'running' });
      const directory = current.directory;
      await current.close(false);
      current = await harness({ dataDir: directory });
      expect(current.hub.operation('unfinished-before-restart').status).toBe('interrupted');
      expect(current.hub.snapshot().devices).toHaveLength(1);
      expect(current.hub.snapshot().devices[0]).toMatchObject({ id: device.id, stale: true, availability: 'connecting' });
      current.adapter.update(device);
      current.adapter.update(device);
      expect(current.hub.snapshot().devices).toHaveLength(1);
      expect(current.hub.snapshot().devices[0]).toMatchObject({ id: device.id, stale: false, availability: 'online' });
      const recovered = { ...device, id: 'peer-without-application-record', name: 'Recovered light' };
      current.adapter.update(recovered);
      expect(current.store.deviceRecords()).toContainEqual({ id: recovered.id, name: recovered.name });
    } finally { await current.close(); }
  });

  it('sends current state on a new stream after changes missed during a browser disconnect', async () => {
    const c = await create(); const cookie = await signIn(c);
    const pairing = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(pairing.id).status).toBe('completed');
    await c.http.listen({ host: '127.0.0.1', port: 0 });
    const address = c.http.server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/api/v1/events`;
    const first = await fetch(url, { headers: { cookie } });
    const firstReader = first.body!.getReader();
    await firstReader.read(); await firstReader.cancel();
    await expect.poll(() => c.hub.listenerCount('event')).toBe(0);
    const device = c.hub.snapshot().devices[0]; device.endpoints[0].power = true;
    c.adapter.update(device);
    const second = await fetch(url, { headers: { cookie } });
    const secondReader = second.body!.getReader();
    try {
      let data = '';
      while (!data.includes('\n\n')) data += new TextDecoder().decode((await secondReader.read()).value);
      const event = JSON.parse(data.split('\n\n')[0].slice(6));
      expect(event.type).toBe('snapshot');
      expect(event.data.devices[0].endpoints[0].power).toBe(true);
    } finally { await secondReader.cancel(); }
  });
});
