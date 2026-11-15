import { readFileSync } from 'node:fs';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { Auth } from './auth.js';

process.umask(0o077);
const config = readConfig();
const store = new Store(config.dataDir);
const auth = new Auth(store, config.sessionTtlMs);
try {
  const command = process.argv[2];
  if (command === 'setup-token') console.log(auth.issueSetupToken());
  else if (command === 'reset-password') {
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (password.length < 12 || password.length > 256) throw new Error('Use a password of 12 to 256 characters, supplied on standard input.');
    await auth.reset(password); console.log('Password reset. Existing sessions have been revoked.');
  } else throw new Error('Usage: cli setup-token | cli reset-password < password-file');
} catch (error) { console.error(error instanceof Error ? error.message : 'CLI command failed.'); process.exitCode = 1; }
finally { store.close(); }
