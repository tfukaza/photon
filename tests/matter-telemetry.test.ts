import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Logger, LogLevel } from '@matter/general';
import { observeMatterTelemetry, translateMatterTelemetry } from '../apps/server/src/matter-telemetry.js';

const cleanups: (() => void)[] = [];
const level = Logger.destinations.default.level;
beforeEach(() => { Logger.destinations.default.level = LogLevel.ERROR; });
afterEach(() => { for (const close of cleanups.splice(0)) close(); Logger.destinations.default.level = level; });

it.each([
  ['NobleBleClient', 'Found peripheral private-address (private-device-name): private-advertisement', 'ble-advertisement', 'completed'],
  ['NobleBleClient', 'Peripheral private-address is not connectable ... ignoring', 'ble-advertisement-connectability', 'skipped'],
  ['BleScanner', 'Discovered device private-address data: private-advertisement', 'ble-matter-advertisement', 'completed'],
  ['BleScanner', 'Re-Discovered device private-address data: private-advertisement', 'ble-matter-advertisement', 'completed'],
  ['NobleBleClient', 'Noble state changed to poweredOn', 'ble-radio', 'completed'],
  ['NobleBleClient', 'Noble state changed to unauthorized', 'ble-radio', 'failed'],
  ['NobleBleClient', 'Start BLE scanning for Matter Services ...', 'ble-scan', 'running'],
  ['BleChannel', 'Peripheral private-address: Connect to Peripheral now (try 0, state disconnected)', 'ble-connect', 'running'],
  ['BleChannel', 'Timeout while connecting to peripheral private-address', 'ble-connect', 'failed'],
  ['BleChannel', 'Timeout while interviewing peripheral private-address', 'ble-services', 'failed'],
  ['BleChannel', 'Peripheral private-address: connection attempt failed, try again', 'ble-connect', 'running'],
  ['BleChannel', 'Peripheral private-address: Found services: fff6', 'ble-connect', 'completed'],
  ['BleChannel', 'Peripheral private-address: Found C1 characteristic', 'ble-c1', 'completed'],
  ['BleChannel', 'Peripheral private-address: Found C2 characteristic', 'ble-c2', 'completed'],
  ['BleChannel', 'Peripheral private-address: Subscribing to C2 characteristic', 'ble-notifications', 'running'],
  ['BleChannel', 'Peripheral private-address: Sending BTP handshake request: private-packet-hex', 'btp-handshake', 'running'],
  ['BleChannel', 'Peripheral private-address: Received Matter handshake response: private-packet-hex.', 'btp-handshake', 'completed'],
  ['BleChannel', 'Peripheral private-address: Handshake Response not received. Disconnect from peripheral', 'btp-handshake', 'failed'],
  ['BtpSessionHandler', 'Acknowledgement for the sent sequence number was not received ... disconnect', 'btp-ack', 'failed'],
  ['PaseClient', 'Paired successfully', 'pase', 'completed'],
] as const)('maps real SDK facility %s template to sanitized %s', (facility, text, stage, status) => {
  const events = translateMatterTelemetry(facility, text);
  expect(events).toContainEqual(expect.objectContaining({ stage, status }));
  expect(JSON.stringify(events)).not.toMatch(/private-address|private-packet-hex/);
  if (stage !== 'pase') expect(events.some(event => event.stage === 'pase')).toBe(false);
});

it('ignores unknown messages, wrong facilities, arbitrary state strings, and non-string values', () => {
  expect(translateMatterTelemetry('NobleBleChannel', 'Peripheral address: Found C1 characteristic')).toEqual([]);
  expect(translateMatterTelemetry('BleChannel', 'SSID: secret password: private-key')).toEqual([]);
  expect(translateMatterTelemetry('NobleBleClient', 'Noble state changed to private-password')).toEqual([]);
  expect(translateMatterTelemetry('BleChannel', { toString() { throw new Error('Must not format'); } })).toEqual([]);
});

it('uses the real logger API without formatting extra objects or altering existing destinations', () => {
  const before = { ...Logger.destinations };
  const beforeLevel = Logger.destinations.default.level;
  const beforeFacilities = { ...Logger.destinations.default.facilityLevels };
  const report = vi.fn(); const controller = new AbortController();
  const close = observeMatterTelemetry(report, controller.signal); cleanups.push(close);
  const poison = { toString() { throw new Error('private-password'); }, toJSON() { throw new Error('private-password'); } };
  Logger.get('BleChannel').debug('Peripheral private-address: Found C1 characteristic', poison);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: 'ble-c1', status: 'completed' }));
  expect(JSON.stringify(report.mock.calls)).not.toContain('private');
  close(); close();
  expect({ ...Logger.destinations }).toEqual(before);
  expect(Logger.destinations.default.level).toBe(beforeLevel);
  expect(Logger.destinations.default.facilityLevels).toEqual(beforeFacilities);
  Logger.get('BleChannel').debug('Peripheral private-address: Found C1 characteristic');
  expect(report).toHaveBeenCalledOnce();
});

it('limits repetition by event type without hiding later failure or authentication completion', () => {
  const report = vi.fn(); const close = observeMatterTelemetry(report, new AbortController().signal); cleanups.push(close);
  for (let i = 0; i < 100; i++) Logger.get('BleChannel').debug('Peripheral secret: received data on C2: private-packet (isNotification: true)');
  Logger.get('BtpSessionHandler').warn('Acknowledgement for the sent sequence number was not received ... disconnect');
  Logger.get('PaseClient').info('Paired successfully');
  expect(report.mock.calls.filter(([event]) => event.stage === 'ble-incoming')).toHaveLength(10);
  expect(report.mock.calls.filter(([event]) => event.stage === 'telemetry-limit-ble-incoming')).toHaveLength(1);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: 'btp-ack', status: 'failed' }));
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pase', status: 'completed' }));
  expect(JSON.stringify(report.mock.calls)).not.toContain('private-packet');
});

it('cleans up on abort, handles already-aborted attempts, and does not duplicate subsequent attempts', () => {
  const before = { ...Logger.destinations }; const controller = new AbortController(); const report = vi.fn();
  const close = observeMatterTelemetry(report, controller.signal); cleanups.push(close);
  controller.abort(); close();
  const closed = observeMatterTelemetry(report, controller.signal); closed();
  expect({ ...Logger.destinations }).toEqual(before);
  const next = vi.fn(); const closeNext = observeMatterTelemetry(next, new AbortController().signal); cleanups.push(closeNext);
  Logger.get('BleChannel').debug('Peripheral address: Found C2 characteristic');
  expect(report).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledOnce();
});

it('does not attribute background Bluetooth diagnostics to a LAN-only commissioning attempt', () => {
  const report = vi.fn(); const close = observeMatterTelemetry(report, new AbortController().signal, 'on-network'); cleanups.push(close);
  Logger.get('BleChannel').debug('Peripheral address: Found C1 characteristic');
  Logger.get('NobleBleClient').debug('Start BLE scanning for Matter Services ...');
  expect(report).not.toHaveBeenCalled();
  Logger.get('PaseClient').info('Paired successfully');
  expect(report).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pase', status: 'completed' }));
});
