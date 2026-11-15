import { readConfig } from './config.js';
import { Store } from './store.js';
import { Auth } from './auth.js';
import { Hub } from './hub.js';
import { FakeAdapter } from './adapter.js';
import { acquireLock } from './lock.js';
import { createHttp } from './http.js';

const config = readConfig();
process.umask(0o077);
const unlock = acquireLock(config.dataDir);
const store = new Store(config.dataDir);
const auth = new Auth(store, config.sessionTtlMs);
const adapter = config.mode === 'fake' ? new FakeAdapter() : new (await import('./matter-adapter.js')).MatterAdapter(config);
const hub = new Hub(store, adapter, config);
const http = await createHttp(config, hub, auth);
let stopping = false;

/** Shuts down exactly once, allowing Matter to persist its identity and peer state. */
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await http.close(); await hub.close(); }
  finally { store.close(); unlock(); }
}

try {
  await hub.start();
  await http.listen({ host: '127.0.0.1', port: config.port });
  console.log(`Photon ready at http://127.0.0.1:${config.port} (${config.mode})`);
  if (config.devNoAuth) console.log('Password-free local testing enabled (PHOTON_DEV_NO_AUTH=1).');
  else if (!auth.initialized()) console.log('Create a setup token with the local CLI: npm run cli -- setup-token');
  process.on('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.on('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
} catch (error) {
  console.error('Photon could not start. Check data-directory access, the trust snapshot, network interface, and Bluetooth permissions.');
  console.error(error instanceof Error ? error.message : 'Unknown startup failure.');
  await stop(); process.exitCode = 1;
}
