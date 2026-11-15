import { mkdirSync, openSync, closeSync, ftruncateSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { flockSync } from 'fs-ext';

/** Holds an OS lock for the controller lifetime; process death automatically releases ownership. */
export function acquireLock(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const descriptor = openSync(join(directory, 'controller.lock'), 'a+', 0o600);
  try { flockSync(descriptor, 'exnb'); }
  catch { closeSync(descriptor); throw new Error('Another Photon controller is using this data directory.'); }
  ftruncateSync(descriptor, 0); writeSync(descriptor, String(process.pid));
  return () => { flockSync(descriptor, 'un'); closeSync(descriptor); };
}
