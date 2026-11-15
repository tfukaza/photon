import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { installMacBleIdentity } from '../apps/server/src/macos-ble.js';

it('keeps two addressless CoreBluetooth candidates distinct before SDK discovery observes them', () => {
  const noble = new EventEmitter();
  const observed: string[] = [];
  noble.on('discover', p => observed.push(p.address));
  const cleanup = installMacBleIdentity(noble);
  const first = { address: '', id: '0123456789abcdef0123456789abcdef' };
  const second = { address: 'unknown', id: 'fedcba98-7654-3210-fedc-ba9876543210' };
  noble.emit('discover', first);
  noble.emit('discover', second);
  expect(observed).toEqual([first.id, second.id]);
  expect(new Set(observed).size).toBe(2);
  cleanup();
  expect(noble.listenerCount('discover')).toBe(1);
  const after = { address: '', id: first.id };
  noble.emit('discover', after);
  expect(after.address).toBe('');
});

it('preserves existing addresses and does not invent identifiers for missing or invalid IDs', () => {
  const noble = new EventEmitter();
  const cleanup = installMacBleIdentity(noble);
  const candidates = [
    { address: 'aa:bb:cc:dd:ee:ff', id: '0123456789abcdef0123456789abcdef' },
    { address: '', id: '' }, { address: '', id: 'not-a-uuid' }, {},
  ];
  const before = structuredClone(candidates);
  for (const candidate of candidates) noble.emit('discover', candidate);
  expect(candidates).toEqual(before);
  cleanup();
});
