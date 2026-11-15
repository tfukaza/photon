import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Auth } from '../apps/server/src/auth.js';
import { Store } from '../apps/server/src/store.js';
import type { Device, Operation } from '../packages/contracts/src/index.js';

const root = await mkdtemp(join(tmpdir(), 'photon-protocol-'));
const auditFile = join(root, 'network-audit');
await writeFile(auditFile, '');
const children = new Set<ChildProcess>();
const logs: string[] = [];
const hubPort = Number(process.env.PHOTON_TEST_PORT ?? 13000);
const simulatorPort = hubPort + 1;
const environment = { ...process.env, PHOTON_MODE: 'simulator', PHOTON_PORT: String(hubPort),
  PHOTON_DATA_DIR: join(root, 'hub'), PHOTON_SIM_DATA_DIR: join(root, 'simulator'),
  PHOTON_NETWORK_AUDIT_FILE: auditFile,
  PHOTON_SIM_PORT: String(simulatorPort), PHOTON_SIM_MATTER_PORT: String(hubPort + 2) };
const password = 'protocol acceptance password';
let cookie = '';

/** Launches a fresh real protocol process with a dedicated persistent directory. */
function launch(entry: string) {
  const child = spawn(process.execPath, ['--import', './tests/deny-outbound-http.mjs', `dist/apps/server/src/${entry}.js`], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout?.on('data', data => logs.push(String(data)));
  child.stderr?.on('data', data => logs.push(String(data)));
  return child;
}

/** Waits for observable readiness with a deadline; transport startup is not a fixed sleep. */
async function until<T>(check: () => Promise<T>, accept: (value: T) => boolean, timeout = 45_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await check(); if (accept(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Protocol acceptance timed out.\n' + logs.join('').slice(-12_000));
}

/** Calls the application contract, preserving cookie authentication between requests. */
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${hubPort}/api/v1${path}`, {
    method, headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data as T;
}

/** Ends a process and refuses to continue if it cannot release the controller storage. */
async function stop(child: ChildProcess, requireClean = true) {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    if (requireClean) { assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null); }
    return;
  }
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  let forced = false;
  const timeout = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 8000);
  const [code, signal] = await exited; clearTimeout(timeout); children.delete(child);
  if (requireClean) {
    assert.equal(forced, false, 'SIGTERM must release resources without forced termination');
    assert.equal(code, 0, 'Process must shut down successfully'); assert.equal(signal, null);
  }
}

try {
  assert.ok((JSON.parse(await readFile('assets/trust.json', 'utf8')) as { paaRoots: unknown[] }).paaRoots.length);
  const store = new Store(environment.PHOTON_DATA_DIR);
  const auth = new Auth(store, 60_000);
  await auth.setup(auth.issueSetupToken(), password); store.close();
  let simulator = launch('simulator');
  const initial = await until(async () => (await fetch(`http://127.0.0.1:${simulatorPort}/state`, { signal: AbortSignal.timeout(5000) })).json() as Promise<{ code: string; commissioned: boolean }>, value => !!value.code);
  let hub = launch('main');
  await until(() => api<{ initialized: boolean }>('/setup'), value => value.initialized);
  await api('/session', 'POST', { password });
  const operation = await api<Operation>('/commissioning', 'POST', { code: initial.code, country: 'US', transport: 'on-network' });
  const result = await until(() => api<Operation>(`/operations/${operation.id}`), value => ['completed', 'failed'].includes(value.status), 130_000);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const trace = result.timeline ?? [];
  for (const stage of ['pase', 'GetInitialData', 'OperationalCredentials.DeviceAttestation', 'OperationalCredentials.Certificates', 'Reconnect', 'GeneralCommissioning.Complete', 'initial-state', 'verify-state']) {
    assert.ok(trace.some(event => event.stage === stage && event.status === 'completed'), `Missing real completed stage: ${stage}`);
  }
  assert.ok(trace.some(event => event.stage === 'discovery' && event.status === 'skipped'));
  assert.ok(trace.some(event => event.stage === 'NetworkCommissioning.Wifi' && event.status === 'skipped'));
  assert.ok(trace.findIndex(event => event.stage === 'pase') < trace.findIndex(event => event.stage === 'OperationalCredentials.DeviceAttestation'));
  assert.ok(trace.findIndex(event => event.stage === 'Reconnect') < trace.findIndex(event => event.stage === 'verify-state'));
  assert.ok(trace.every((event, index) => index === 0 || Date.parse(event.at) >= Date.parse(trace[index - 1].at)));
  assert.ok(!JSON.stringify(trace).includes(initial.code), 'Setup code must not enter the progress trace');
  console.log('Protocol: real Matter commissioning completed.');
  const devices = await until(() => api<Device[]>('/devices'), items => items.some(item => item.availability === 'online' && item.endpoints.length > 0));
  const light = devices[0];
  assert.equal(typeof light.endpoints[0].power, 'boolean', 'Completed commissioning requires confirmed on/off state');
  const endpoint = light.endpoints.find(endpoint => endpoint.kind === 'light');
  const plug = light.endpoints.find(endpoint => endpoint.kind === 'plug');
  assert.ok(endpoint); assert.ok(plug);
  assert.equal(plug.brightnessSupported, false);
  const reported = (items: Device[], kind: 'light' | 'plug') => items[0]?.endpoints.find(endpoint => endpoint.kind === kind);
  const run = async (body: unknown, endpointId = endpoint.id) => {
    const command = await api<Operation>(`/devices/${light.id}/endpoints/${endpointId}/commands`, 'POST', body);
    const terminal = await until(() => api<Operation>(`/operations/${command.id}`), value => ['completed', 'failed'].includes(value.status));
    assert.equal(terminal.status, 'completed', JSON.stringify(terminal));
  };
  await run({ type: 'power', value: true });
  await until(() => api<Device[]>('/devices'), items => reported(items, 'light')?.power === true);
  await run({ type: 'brightness', value: 75 });
  await until(() => api<Device[]>('/devices'), items => reported(items, 'light')?.brightness === 75);
  await fetch(`http://127.0.0.1:${simulatorPort}/power`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  await until(() => api<Device[]>('/devices'), items => reported(items, 'light')?.power === false);
  await run({ type: 'power', value: true }, plug.id);
  const plugOn = await until(() => api<Device[]>('/devices'), items => reported(items, 'plug')?.power === true);
  assert.equal(reported(plugOn, 'light')?.power, false, 'Plug commands must not change the light');
  await assert.rejects(() => api(`/devices/${light.id}/endpoints/${plug.id}/commands`, 'POST', { type: 'brightness', value: 50 }), /does not support brightness/);
  await fetch(`http://127.0.0.1:${simulatorPort}/plug-power`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  await until(() => api<Device[]>('/devices'), items => reported(items, 'plug')?.power === false);
  console.log('Protocol: commands and external state reports passed.');
  await stop(hub); hub = launch('main');
  const restored = await until(() => api<Device[]>('/devices'), items => items[0]?.availability === 'online' && items[0].endpoints.length > 0);
  assert.equal(restored[0].id, light.id, 'Operational fabric/node identity survives a fresh process');
  assert.equal(reported(restored, 'light')?.power, false);
  assert.equal(reported(restored, 'plug')?.id, plug.id);
  await run({ type: 'power', value: true }, plug.id);
  await until(() => api<Device[]>('/devices'), items => reported(items, 'plug')?.power === true);
  console.log('Protocol: hub restart preserved fabric/node identity and subscriptions.');
  const restoredOperation = await api<Operation>(`/operations/${operation.id}`);
  assert.deepEqual(restoredOperation.timeline, trace, 'Real commissioning history survives a fresh controller process');
  await run({ type: 'power', value: true });
  await stop(simulator); simulator = launch('simulator');
  await until(async () => (await fetch(`http://127.0.0.1:${simulatorPort}/state`, { signal: AbortSignal.timeout(5000) })).json() as Promise<{ commissioned: boolean }>, value => value.commissioned);
  console.log('Protocol: simulator restarted with fabric membership intact.');
  await until(() => api<Device[]>('/devices'), items => items[0]?.availability === 'online', 90_000);
  await run({ type: 'power', value: false });
  await until(() => api<Device[]>('/devices'), items => reported(items, 'light')?.power === false);
  await run({ type: 'power', value: false }, plug.id);
  await until(() => api<Device[]>('/devices'), items => reported(items, 'plug')?.power === false);
  assert.equal(await readFile(auditFile, 'utf8'), '', 'Runtime must not attempt remote HTTP lookups');
  console.log('PASS: real Matter light and smart-plug controls, external changes, brightness capability checks, timeline, stable identity, and hub/device restarts.');
  console.log('Physical BLE/Wi-Fi hardware and Internet-blocked acceptance are separate required runs.');
} catch (error) {
  console.error(error); console.error(logs.join('').slice(-12_000)); process.exitCode = 1;
} finally {
  for (const child of children) await stop(child, false);
  await rm(root, { recursive: true, force: true });
}
