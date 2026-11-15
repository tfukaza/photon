import { afterEach, expect, it, vi } from 'vitest';
import { Logger } from '@matter/general';
import * as simulatorFlow from '../apps/server/src/simulator-flow.js';
import type { ClientNode } from '@matter/node';
import { OnOffClient } from '@matter/node/behaviors/on-off';
import { DescriptorClient } from '@matter/node/behaviors/descriptor';
import { LevelControlClient } from '@matter/node/behaviors/level-control';
import { PasscodeMismatchError, type ReadResult } from '@matter/protocol';
import { MatterAdapter } from '../apps/server/src/matter-adapter.js';
import { confirmDeviceConnection, deviceControlKind } from '../apps/server/src/device-verification.js';
import type { Config } from '../apps/server/src/config.js';
import { input } from './helpers.js';

afterEach(() => vi.useRealTimers());

/** Models a paired peer with cached off state, independently controlled live reports, and no real radio. */
function fixture(deviceType = 0x101, dimmable = false) {
  const lifecycle = { isConnected: true, isSeeded: true, connectionStateChanged: { on: vi.fn(), off: vi.fn() } };
  const onoff = { onOff: false };
  const descriptor = { deviceTypeList: [{ deviceType }] };
  const endpoint = { number: 1, maybeStateOf: (behavior: unknown) => {
    if (behavior === OnOffClient) return onoff;
    if (behavior === DescriptorClient) return descriptor;
    if (behavior === LevelControlClient && dimmable) return { currentLevel: 127 };
    return undefined;
  } };
  const read = vi.fn<(request: unknown) => ReadResult>(() => reports(false));
  const peer = { lifecycle, endpoints: [endpoint], interaction: { read },
    state: { commissioning: { peerAddress: { nodeId: 2n } } }, maybeStateOf: () => undefined } as unknown as ClientNode;
  const adapter = new MatterAdapter({ mode: 'hardware' } as Config);
  const commission = vi.fn(async (..._args: unknown[]) => peer);
  Object.assign(adapter, { node: { peers: { commissioned: [peer], added: { on: vi.fn(), off: vi.fn() }, commission } }, fabricId: '1' });
  return { lifecycle, descriptor, endpoint, read, peer, adapter, commission };
}

it('uses normal hardware LAN discovery and strict attestation rather than simulator address/trust overrides', async () => {
  const f = fixture(0x10a); const report = vi.fn();
  const simulator = vi.spyOn(simulatorFlow, 'simulatorCommissioningFlow');
  try {
    await f.adapter.commission(input, new AbortController().signal, report);
    const options = f.commission.mock.calls[0][0] as { discoveryCapabilities: { ble: boolean; onIpNetwork: boolean }; wifiNetwork?: unknown; onAttestationFailure: (findings: { level: string; type: string }[]) => boolean };
    expect(options.discoveryCapabilities).toEqual({ ble: false, onIpNetwork: true });
    expect(options.wifiNetwork).toBeUndefined(); expect(simulator).not.toHaveBeenCalled();
    expect(options.onAttestationFailure([{ level: 'error', type: 'TrustedAsTestCertificate' }])).toBe(false);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: 'NetworkCommissioning.Wifi', status: 'skipped', detail: expect.stringContaining('No Wi-Fi credentials') }));
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: 'discovery', detail: expect.stringContaining('mDNS') }));
    expect(f.read).toHaveBeenCalledOnce();
  } finally { simulator.mockRestore(); }
});

it.each([0x100, 0x101, 0x10c, 0x10d, 0x10a, 0x10b])('recognizes supported control device type %s and verifies fresh off state', async type => {
  const plug = type === 0x10a || type === 0x10b;
  const dimmable = type === 0x10b || type === 0x101;
  const f = fixture(type, dimmable);
  expect(deviceControlKind([{ deviceType: type }])).toBe(plug ? 'plug' : 'light');
  await expect(f.adapter.commission(input, new AbortController().signal)).resolves.toBe('1-2');
  expect(f.adapter.devices()[0].endpoints[0]).toMatchObject({ kind: plug ? 'plug' : 'light', power: false, brightnessSupported: dimmable });
  expect(f.read).toHaveBeenCalledOnce();
});

it.each(['root', 'missing-server', 'remote-switch', 'unknown-type'] as const)('does not accept a %s as a controllable plug', async reason => {
  const f = fixture(0x10a);
  if (reason === 'root') f.endpoint.number = 0;
  if (reason === 'remote-switch') f.descriptor.deviceTypeList[0].deviceType = 0x103;
  if (reason === 'unknown-type') f.descriptor.deviceTypeList[0].deviceType = 0xffff;
  if (reason === 'missing-server') {
    const original = f.endpoint.maybeStateOf;
    vi.spyOn(f.endpoint, 'maybeStateOf').mockImplementation(behavior => behavior === OnOffClient ? undefined : original(behavior));
  }
  await expect(confirmDeviceConnection(f.peer, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(f.read).not.toHaveBeenCalled();
});

it('retains an on/off plug pairing without inventing state when the live report is missing', async () => {
  const f = fixture(0x10a); f.read.mockImplementation(() => reports());
  await expect(f.adapter.commission(input, new AbortController().signal)).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
  expect(f.adapter.devices()[0]).toMatchObject({ id: '1-2', availability: 'offline', endpoints: [{ kind: 'plug', power: null, brightnessSupported: false }] });
});

/** Emits a wire-shaped report; cached state alone never produces this result. */
async function* reports(value?: unknown): ReadResult {
  if (value !== undefined) yield [{ kind: 'attr-value', path: { endpointId: 1, clusterId: 6, attributeId: 0 }, value, version: 1 } as ReadResult.Report];
}

it('keeps commissioning pending despite cached off state until a fresh live read completes', async () => {
  const f = fixture();
  const destinations = Object.keys(Logger.destinations);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.read.mockImplementation(async function* () { await wait; yield* reports(false); });
  const progress = vi.fn();
  let completed = false;
  const signal = new AbortController().signal;
  const job = f.adapter.commission(input, signal, progress).then(id => { completed = true; return id; });
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
  expect(completed).toBe(false);
  expect(f.adapter.devices()[0]).toMatchObject({ availability: 'offline', stale: true, endpoints: [{ power: null }] });
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'verify-state', status: 'running' }));
  expect(f.read.mock.calls[0][0]).toMatchObject({ includeKnownVersions: true, abort: signal, attributeRequests: [{ endpointId: 1, clusterId: 6, attributeId: 0 }] });
  expect((f.read.mock.calls[0][0] as { abort: AbortSignal }).abort).toBe(signal);
  release();
  await expect(job).resolves.toBe('1-2');
  expect(Object.keys(Logger.destinations)).toEqual(destinations);
  expect(f.adapter.devices()[0]).toMatchObject({ availability: 'online', stale: false, endpoints: [{ power: false }] });
});

it.each([undefined, null, 0, 'false'])('rejects a missing/nonboolean live report (%s) while retaining the paired identity', async value => {
  const f = fixture(); f.read.mockImplementation(() => reports(value));
  await expect(f.adapter.commission(input, new AbortController().signal)).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
  expect(f.adapter.devices()[0]).toMatchObject({ id: '1-2', availability: 'offline', stale: true });
});

it('retains a paired peer after a live-read failure instead of claiming it is online', async () => {
  const f = fixture(); f.read.mockImplementation(async function* () { throw new Error('transport unavailable'); });
  await expect(f.adapter.commission(input, new AbortController().signal)).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
  expect(f.adapter.devices()[0].availability).toBe('offline');
  expect(f.peer.state.commissioning.peerAddress?.nodeId).toBe(2n);
});

it('waits for connection and structure using only the caller’s remaining commissioning deadline', async () => {
  vi.useFakeTimers();
  const f = fixture(); f.lifecycle.isConnected = false;
  const controller = new AbortController();
  const job = confirmDeviceConnection(f.peer, controller.signal);
  const rejection = expect(job).rejects.toThrow('Original deadline');
  await vi.advanceTimersByTimeAsync(300);
  expect(f.read).not.toHaveBeenCalled();
  controller.abort(new Error('Original deadline'));
  await rejection;
});

it('waits for delayed readiness and accepts a live report of on', async () => {
  vi.useFakeTimers();
  const f = fixture(); f.lifecycle.isSeeded = false; f.read.mockImplementation(() => reports(true));
  const job = confirmDeviceConnection(f.peer, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(200);
  expect(f.read).not.toHaveBeenCalled();
  f.lifecycle.isSeeded = true;
  await vi.advanceTimersByTimeAsync(100);
  await job;
  expect(f.read).toHaveBeenCalledOnce();
});

it('rejects unsupported device types and disconnects during live verification', async () => {
  const f = fixture(); f.descriptor.deviceTypeList[0].deviceType = 0x103;
  await expect(confirmDeviceConnection(f.peer, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  expect(f.read).not.toHaveBeenCalled();
  f.descriptor.deviceTypeList[0].deviceType = 0x101;
  f.read.mockImplementation(async function* () { yield* reports(false); f.lifecycle.isConnected = false; });
  await expect(confirmDeviceConnection(f.peer, new AbortController().signal)).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
});

it('cannot confirm a late live report after the commissioning deadline has expired', async () => {
  const f = fixture(); const controller = new AbortController();
  f.read.mockImplementation(async function* () { controller.abort(new Error('Expired')); yield* reports(false); });
  await expect(f.adapter.commission(input, controller.signal)).rejects.toBeDefined();
  expect(f.adapter.devices()[0].availability).toBe('offline');
});

it('discovery failures cannot create a fabricated device', async () => {
  const f = fixture();
  Object.assign(f.adapter, { node: { peers: { commissioned: [], added: { on: vi.fn(), off: vi.fn() }, commission: vi.fn(async () => { throw new Error('not found'); }) } } });
  await expect(f.adapter.commission(input, new AbortController().signal)).rejects.toMatchObject({ code: 'COMMISSIONING_FAILED' });
  expect(f.adapter.devices()).toEqual([]);
});

it('reports an incorrect device passcode without fabricating a device', async () => {
  const f = fixture();
  const destinations = Object.keys(Logger.destinations);
  const added = { on: vi.fn(), off: vi.fn() };
  const report = vi.fn();
  Object.assign(f.adapter, { node: { peers: { commissioned: [], added, commission: vi.fn(async () => {
    added.on.mock.calls[0][0](f.peer);
    throw new PasscodeMismatchError('wrong passcode');
  }) } } });
  await expect(f.adapter.commission({ ...input, transport: 'ble', ssid: 'test-network', wifiPassword: 'test-password' }, new AbortController().signal, report)).rejects.toMatchObject({ code: 'WRONG_CODE' });
  expect(report.mock.calls.map(([event]) => [event.stage, event.status])).toEqual([
    ['discovery', 'running'], ['discovery', 'running'], ['transport', 'running'],
  ]);
  expect(report.mock.calls[1][0].detail).toContain('not been authenticated');
  expect(added.off).toHaveBeenCalledWith(added.on.mock.calls[0][0]);
  expect(Object.keys(Logger.destinations)).toEqual(destinations);
  expect(f.adapter.devices()).toEqual([]);
});

it.each([
  { kind: 'attr-value', path: { endpointId: 2, clusterId: 6, attributeId: 0 }, value: false },
  { kind: 'attr-value', path: { endpointId: 1, clusterId: 8, attributeId: 0 }, value: false },
  { kind: 'attr-value', path: { endpointId: 1, clusterId: 6, attributeId: 1 }, value: false },
  { kind: 'attr-status', path: { endpointId: 1, clusterId: 6, attributeId: 0 }, status: 1 },
])('rejects unrelated attributes or error status instead of confirming state: %j', async report => {
  const f = fixture();
  f.read.mockImplementation(async function* () { yield [report as ReadResult.Report]; });
  await expect(f.adapter.commission(input, new AbortController().signal)).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
  expect(f.adapter.devices()[0].availability).toBe('offline');
});
