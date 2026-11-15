import type { EventEmitter } from 'node:events';

interface PeripheralIdentity { address?: string; id?: string }

/** CoreBluetooth exposes a local UUID instead of a peripheral MAC address. */
export function installMacBleIdentity(noble: Pick<EventEmitter, 'prependListener' | 'off'>) {
  const normalize = (peripheral: PeripheralIdentity) => {
    if (peripheral.address && peripheral.address !== 'unknown') return;
    const id = peripheral.id;
    if (typeof id === 'string' && /^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(id)) {
      // matter.js keys discovery and channels by address; noble connects using id.
      // This identifier is local to this Mac, not an authenticated Matter identity.
      peripheral.address = id;
    }
  };
  noble.prependListener('discover', normalize);
  return () => { noble.off('discover', normalize); };
}
