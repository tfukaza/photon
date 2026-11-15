import { mkdir, writeFile } from 'node:fs/promises';
import { Certificate, TestCert_PAA_NoVID_Cert, TestCert_PAA_FFF1_Cert } from '@matter/protocol';
import { Bytes } from '@matter/general';

const repository = 'project-chip/connectedhomeip';
const api = `https://api.github.com/repos/${repository}`;

/** Fetches release preparation input with a bounded timeout and clear failure. */
async function fetchChecked(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'Photon-trust-preparation' } });
  if (!response.ok) throw new Error(`Trust input failed: ${response.status} ${url}`);
  return response;
}

/** Snapshots public upstream certificates at a fixed commit; never called by the runtime. */
async function main() {
  const commit = await (await fetchChecked(`${api}/commits/master`)).json() as { sha: string };
  const snapshot = { builtAt: new Date().toISOString(), sourceCommit: commit.sha,
    paaRoots: [] as Entry[], cdSigners: [] as Entry[] };
  for (const kind of ['production', 'development'] as const) {
    for (const directory of ['paa-root-certs', 'cd-certs'] as const) {
      const files = await (await fetchChecked(`${api}/contents/credentials/${kind}/${directory}?ref=${commit.sha}`)).json() as { name: string }[];
      const derFiles = files.filter(file => file.name.endsWith('.der'));
      for (let offset = 0; offset < derFiles.length; offset += 6) {
        const batch = await Promise.all(derFiles.slice(offset, offset + 6).map(async file => {
          const response = await fetchChecked(`https://raw.githubusercontent.com/${repository}/${commit.sha}/credentials/${kind}/${directory}/${encodeURIComponent(file.name)}`);
          const bytes = Bytes.of(new Uint8Array(await response.arrayBuffer()));
          if (bytes.length > 600) {
            console.log(`Omitting ${file.name}: post-quantum certificates are outside this prototype's support.`);
            return null;
          }
          const parsed = Certificate.parseAsn1Certificate(bytes, directory === 'paa-root-certs' ? Certificate.REQUIRED_PAA_EXTENSIONS : Certificate.REQUIRED_EXTENSIONS);
          return { subjectKeyId: Bytes.toHex(parsed.extensions.subjectKeyIdentifier), derHex: Bytes.toHex(bytes),
            kind: kind === 'production' ? 'production' as const : 'test' as const };
        }));
        for (const entry of batch) if (entry) snapshot[directory === 'paa-root-certs' ? 'paaRoots' : 'cdSigners'].push(entry);
      }
    }
  }
  for (const bytes of [TestCert_PAA_NoVID_Cert, TestCert_PAA_FFF1_Cert]) {
    const parsed = Certificate.parseAsn1Certificate(bytes, Certificate.REQUIRED_PAA_EXTENSIONS);
    snapshot.paaRoots.push({ subjectKeyId: Bytes.toHex(parsed.extensions.subjectKeyIdentifier), derHex: Bytes.toHex(bytes), kind: 'test' });
  }
  await mkdir('assets', { recursive: true });
  await writeFile('assets/trust.json', JSON.stringify(snapshot));
  console.log(`Packaged ${snapshot.paaRoots.length} roots and ${snapshot.cdSigners.length} signers from ${commit.sha}.`);
}
type Entry = { subjectKeyId: string; derHex: string; kind: 'production' | 'test' };
await main();
