import { afterEach, expect, it, vi } from 'vitest';
import { stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, input, signIn } from './helpers.js';
import { importMacWifi } from '../apps/server/src/mac-wifi.js';
import * as macWifi from '../apps/server/src/mac-wifi.js';

const contexts: Awaited<ReturnType<typeof harness>>[] = [];
/** Registers an isolated application for cleanup after assertions. */
async function create() { const c = await harness(); contexts.push(c); return c; }
afterEach(async () => { vi.restoreAllMocks(); for (const c of contexts.splice(0)) await c.close(); });

it('remembers credentials only by opt-in, returns metadata only, and resolves saved credentials on the server', async () => {
  const c = await create(); const cookie = await signIn(c);
  expect((await c.http.inject('/api/v1/wifi')).statusCode).toBe(401);
  const request = { ...input, transport: 'ble' as const, ssid: ' wifi "$()` network ', wifiPassword: ' password "$()` value ' };
  const first = c.hub.commission(request);
  await expect.poll(() => c.hub.operation(first.id).status).toBe('completed');
  expect(c.store.savedWifi()).toBeUndefined();
  const remembered = c.hub.commission({ ...request, rememberWifi: true });
  await expect.poll(() => c.hub.operation(remembered.id).status).toBe('completed');
  const metadata = await c.http.inject({ url: '/api/v1/wifi', headers: { cookie } });
  expect(metadata.json()).toMatchObject({ saved: true, ssid: request.ssid });
  expect(metadata.body).not.toContain(request.wifiPassword);
  const commission = vi.spyOn(c.adapter, 'commission');
  const saved = c.hub.commission({ ...input, transport: 'ble', useSavedWifi: true });
  await expect.poll(() => c.hub.operation(saved.id).status).toBe('completed');
  expect(commission.mock.calls[0][0]).toMatchObject({ ssid: request.ssid, wifiPassword: request.wifiPassword });
  const history = JSON.stringify(c.store.operations());
  expect(history).not.toContain(request.ssid); expect(history).not.toContain(request.wifiPassword);
  await c.http.inject({ method: 'DELETE', url: '/api/v1/wifi', headers: { cookie } });
  expect(c.store.savedWifi()).toBeUndefined();
  expect(() => c.hub.commission({ ...input, transport: 'ble', useSavedWifi: true })).toThrow('No Wi-Fi network is saved');
});

it('replaces only the one saved network and cannot overwrite it through invalid, ambiguous, or busy setup requests', async () => {
  const c = await create(); const cookie = await signIn(c);
  c.store.saveWifi('original', 'original-password');
  const post = (payload: Record<string, unknown>) => c.http.inject({ method: 'POST', url: '/api/v1/commissioning', headers: { cookie }, payload });
  const fields = { ...input, transport: 'ble', ssid: 'new', wifiPassword: 'new-password', rememberWifi: true };
  expect((await post({ ...fields, code: '123' })).statusCode).toBe(400);
  expect((await post({ ...fields, useSavedWifi: true })).statusCode).toBe(400);
  expect((await post({ ...fields, transport: 'on-network' })).statusCode).toBe(400);
  const operation = c.hub.commission(input);
  expect((await post(fields)).statusCode).toBe(409);
  expect(c.store.savedWifi()?.ssid).toBe('original');
  await expect.poll(() => c.hub.operation(operation.id).status).toBe('completed');
  const replacement = await c.http.inject({ method: 'POST', url: '/api/v1/wifi', headers: { cookie }, payload: { ssid: 'new', password: 'new-password' } });
  expect(replacement.json()).toMatchObject({ saved: true, ssid: 'new' });
  expect(c.store.db.prepare('SELECT COUNT(*) AS count FROM wifi_network').get()?.count).toBe(1);
});

it('persists remembered Wi-Fi across reopen, repairs permissions, and retains existing account/device data', async () => {
  let c = await harness();
  try {
    await signIn(c); c.store.saveWifi('persistent-network', 'persistent-password');
    const pairing = c.hub.commission(input);
    await expect.poll(() => c.hub.operation(pairing.id).status).toBe('completed');
    const directory = c.directory;
    await c.close(false); await chmod(join(directory, 'photon.db'), 0o644);
    c = await harness({ dataDir: directory });
    expect(c.store.savedWifi()).toEqual({ ssid: 'persistent-network', password: 'persistent-password' });
    expect(c.auth.initialized()).toBe(true); expect(c.store.deviceRecords()).toHaveLength(1);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'photon.db'))).mode & 0o777).toBe(0o600);
  } finally { await c.close(); }
});

it('does not retarget in-flight provisioning when the remembered network is forgotten or replaced', async () => {
  const c = await create(); c.store.saveWifi('first-network', 'first-password');
  let finish!: (id: string) => void;
  const transport = vi.spyOn(c.adapter, 'commission').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  c.hub.commission({ ...input, transport: 'ble', useSavedWifi: true });
  c.store.forgetWifi(); c.store.saveWifi('second-network', 'second-password');
  expect(transport.mock.calls[0][0]).toMatchObject({ ssid: 'first-network', wifiPassword: 'first-password' });
  finish('fake-light');
});

it('imports only the named Keychain item using argument arrays and never a shell', async () => {
  const ssid = ' network "$(echo nope)` value ';
  const password = ' password with trailing spaces  ';
  const run = vi.fn(async () => password + '\n');
  expect(await importMacWifi(ssid, 'darwin', run)).toEqual({ ssid, password });
  expect(run).toHaveBeenCalledWith('/usr/bin/security', ['find-generic-password', '-D', 'AirPort network password', '-a', ssid, '-w']);
});

it('can discover an available Mac Wi-Fi name before requesting its Keychain item', async () => {
  const run = vi.fn().mockResolvedValueOnce('Hardware Port: Wi-Fi\nDevice: en7\n').mockResolvedValueOnce('Current Wi-Fi Network: current-network\n').mockResolvedValueOnce('current-password\n');
  expect(await importMacWifi(undefined, 'darwin', run)).toEqual({ ssid: 'current-network', password: 'current-password' });
  expect(run.mock.calls[1][1]).toEqual(['-getairportnetwork', 'en7']);
});

it.each(['Current Wi-Fi Network: <redacted>\n', 'You are not associated with an AirPort network.\n'])('does not search Keychain with a hidden or unavailable SSID: %s', async output => {
  const run = vi.fn().mockResolvedValueOnce('Hardware Port: Wi-Fi\nDevice: en0\n').mockResolvedValueOnce(output);
  await expect(importMacWifi(undefined, 'darwin', run)).rejects.toMatchObject({ code: 'WIFI_NAME_REQUIRED' });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.every(([file]) => file === '/usr/sbin/networksetup')).toBe(true);
});

it('terminates setup cleanly when remembering Wi-Fi fails, without starting pairing or leaving queued work', async () => {
  const c = await create();
  const save = vi.spyOn(c.store, 'saveWifi').mockImplementationOnce(() => { throw new Error('private-disk-diagnostic'); });
  const transport = vi.spyOn(c.adapter, 'commission');
  const failed = c.hub.commission({ ...input, transport: 'ble', ssid: 'network', wifiPassword: 'password', rememberWifi: true });
  await expect.poll(() => c.hub.operation(failed.id).status).toBe('failed');
  expect(c.hub.operation(failed.id).error?.code).toBe('WIFI_SAVE_FAILED');
  expect(transport).not.toHaveBeenCalled();
  expect(JSON.stringify(c.store.operations())).not.toContain('private-disk-diagnostic');
  save.mockRestore();
  await expect.poll(() => { try { return c.hub.commission(input).id; } catch { return ''; } }).not.toBe('');
});

it('keeps native errors and password output out of public import failures', async () => {
  const run = vi.fn(async () => { throw new Error('private-keychain-password stderr'); });
  await expect(importMacWifi('named-network', 'darwin', run)).rejects.toMatchObject({ code: 'WIFI_IMPORT_FAILED' });
  try { await importMacWifi('named-network', 'darwin', run); } catch (error) { expect(String(error)).not.toContain('private-keychain-password'); }
  await expect(importMacWifi(undefined, 'darwin', run)).rejects.toMatchObject({ code: 'WIFI_NAME_REQUIRED' });
  await expect(importMacWifi('named-network', 'linux', run)).rejects.toMatchObject({ code: 'WIFI_IMPORT_UNAVAILABLE' });
});

it('imports only on explicit request and preserves the saved network on denied or failed imports', async () => {
  const c = await create(); const cookie = await signIn(c);
  const importer = vi.spyOn(macWifi, 'importMacWifi').mockResolvedValueOnce({ ssid: 'imported-network', password: 'private-import-password' });
  await c.http.inject({ url: '/api/v1/wifi', headers: { cookie } });
  expect(importer).not.toHaveBeenCalled();
  const imported = await c.http.inject({ method: 'POST', url: '/api/v1/wifi/import', headers: { cookie }, payload: { ssid: 'imported-network' } });
  expect(imported.json()).toMatchObject({ saved: true, ssid: 'imported-network' });
  expect(imported.body).not.toContain('private-import-password');
  importer.mockRejectedValueOnce(new Error('secret-keychain-stderr'));
  const failed = await c.http.inject({ method: 'POST', url: '/api/v1/wifi/import', headers: { cookie }, payload: {} });
  expect(failed.statusCode).toBe(500);
  expect(failed.body).not.toContain('secret-keychain-stderr');
  expect(c.store.savedWifi()?.ssid).toBe('imported-network');
});
