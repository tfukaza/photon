import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from '../apps/server/src/config.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
  vi.doUnmock('@matter/nodejs-ble');
  vi.doUnmock('../apps/server/src/trust.js');
});

/** Stops at controller construction so platform tests never start sockets or access a radio. */
async function startup(platform: NodeJS.Platform, mode: Config['mode'], importFailure?: Error) {
  vi.resetModules();
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
  const loadBle = vi.fn(() => { if (importFailure) throw importFailure; return {}; });
  const closeTrust = vi.fn();
  vi.doMock('@matter/nodejs-ble', loadBle);
  vi.doMock('../apps/server/src/trust.js', () => ({ installTrust: vi.fn(async () => ({ close: closeTrust })) }));
  const { Environment } = await import('@matter/general');
  const { ServerNode } = await import('@matter/node');
  const environment = new Environment('platform-test');
  vi.spyOn(Environment, 'default', 'get').mockReturnValue(environment);
  const constructed = new Error('Controller construction reached');
  const create = vi.spyOn(ServerNode, 'create').mockRejectedValue(constructed);
  const { MatterAdapter } = await import('../apps/server/src/matter-adapter.js');
  const config = { dataDir: '/unused', mode, hciId: 3, trustFile: '/unused' } as Config;
  const adapter = new MatterAdapter(config);
  const error = await adapter.start(() => {}).catch((cause: unknown) => cause);
  return { environment, loadBle, create, closeTrust, constructed, error };
}

it.each(['linux', 'darwin'] as const)('allows %s hardware to reach controller construction with native BLE', async platform => {
  const result = await startup(platform, 'hardware');
  expect(result.error).toBe(result.constructed);
  expect(result.create).toHaveBeenCalledOnce();
  expect(result.loadBle).toHaveBeenCalledOnce();
  expect(result.environment.vars.boolean('ble.enable')).toBe(true);
  expect(result.environment.vars.number('ble.hci.id')).toBe(platform === 'linux' ? 3 : undefined);
  expect(result.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    network: { ble: false }, controller: { adminFabricLabel: 'Photon', ble: true },
  }));
  expect(result.closeTrust).toHaveBeenCalledOnce();
});

it('rejects unsupported hardware hosts before loading native BLE or constructing a controller', async () => {
  const result = await startup('win32', 'hardware');
  expect(result.error).toEqual(new Error('Hardware commissioning requires Linux or macOS.'));
  expect(result.loadBle).not.toHaveBeenCalled();
  expect(result.create).not.toHaveBeenCalled();
});

it('keeps macOS simulator startup independent of Bluetooth', async () => {
  const result = await startup('darwin', 'simulator');
  expect(result.error).toBe(result.constructed);
  expect(result.environment.vars.boolean('ble.enable')).toBe(false);
  expect(result.loadBle).not.toHaveBeenCalled();
});

it('propagates a native BLE loading failure without creating a controller', async () => {
  const failure = new Error('Native Bluetooth binding unavailable');
  const result = await startup('darwin', 'hardware', failure);
  expect(result.error).toMatchObject({ cause: failure });
  expect(result.create).not.toHaveBeenCalled();
});
