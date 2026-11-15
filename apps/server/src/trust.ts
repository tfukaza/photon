import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DclCertificateService } from '@matter/protocol';
import { Environment } from '@matter/general';

const certificate = z.object({ subjectKeyId: z.string(), derHex: z.string(), kind: z.enum(['production', 'test']) });
export const trustSchema = z.object({
  builtAt: z.string(), sourceCommit: z.string(), paaRoots: z.array(certificate), cdSigners: z.array(certificate),
});

/** Yields packaged certificates to matter.js without fetching any external service. */
async function* entries<T>(values: T[]) { yield* values; }

/** Installs a strictly offline trust store; test roots are accepted only in simulator mode. */
export async function installTrust(environment: Environment, file: string, simulator: boolean) {
  const snapshot = trustSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const select = (values: z.infer<typeof certificate>[]) => simulator ? values : values.filter(entry => entry.kind === 'production');
  const roots = select(snapshot.paaRoots);
  const signers = select(snapshot.cdSigners);
  if (!roots.length || !signers.length) throw new Error('Trust snapshot is empty. Run npm run trust:prepare during release preparation.');
  const service = new DclCertificateService(environment, {
    offline: true, acceptTestCertificates: simulator, fetchTestCertificates: simulator, fetchGithubCertificates: false, updateInterval: null,
    seed: {
      paaRoots: { builtAt: snapshot.builtAt, expectedCount: roots.length, entries: entries(roots) },
      cdSigners: { builtAt: snapshot.builtAt, expectedCount: signers.length, entries: entries(signers) },
    },
  });
  await service.construction;
  return service;
}
