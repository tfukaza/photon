import { resolve } from 'node:path';

export interface Config {
  dataDir: string; port: number; mode: 'hardware' | 'simulator' | 'fake';
  interface?: string; hciId: number; trustFile: string; webDir: string;
  commissionTimeoutMs: number; commandTimeoutMs: number; sessionTtlMs: number;
  simulatorMatterPort?: number;
  devNoAuth: boolean;
}

/** Reads deployment configuration; web access always binds to loopback. */
export function readConfig(): Config {
  const mode = process.env.PHOTON_MODE ?? 'hardware';
  if (!['hardware', 'simulator', 'fake'].includes(mode)) throw new Error('Invalid PHOTON_MODE.');
  return {
    dataDir: resolve(process.env.PHOTON_DATA_DIR ?? '.photon'),
    port: Number(process.env.PHOTON_PORT ?? 3000), mode: mode as Config['mode'],
    interface: process.env.PHOTON_INTERFACE, hciId: Number(process.env.PHOTON_HCI_ID ?? 0),
    trustFile: resolve(process.env.PHOTON_TRUST_FILE ?? 'assets/trust.json'),
    webDir: resolve('apps/web/dist'), commissionTimeoutMs: 120_000, commandTimeoutMs: 10_000,
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    simulatorMatterPort: Number(process.env.PHOTON_SIM_MATTER_PORT ?? 5540),
    devNoAuth: process.env.PHOTON_DEV_NO_AUTH === '1',
  };
}
