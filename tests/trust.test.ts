import '@matter/nodejs';
import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Environment } from '@matter/general';
import { TestCert_PAA_NoVID_SKID } from '@matter/protocol';
import { installTrust } from '../apps/server/src/trust.js';

it('loads offline production trust without admitting the simulator root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photon-trust-'));
  const environment = Environment.default;
  environment.vars.set('storage.path', directory);
  environment.vars.set('storage.driver', 'sqlite');
  environment.vars.set('log.level', 'error');
  const service = await installTrust(environment, resolve('assets/trust.json'), false);
  try {
    const snapshot = JSON.parse(await readFile('assets/trust.json', 'utf8')) as { paaRoots: { kind: string; subjectKeyId: string }[] };
    const production = snapshot.paaRoots.find(entry => entry.kind === 'production');
    expect(production).toBeDefined();
    expect(service.getCertificate(production!.subjectKeyId)).toBeDefined();
    expect(service.offline).toBe(true);
    expect(service.getCertificate(TestCert_PAA_NoVID_SKID, { considerTestCertificates: true })).toBeUndefined();
    expect(service.getCertificate('ffffffffffffffffffffffffffffffffffffffff')).toBeUndefined();
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
