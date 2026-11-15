import http from 'node:http';
import https from 'node:https';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

/** Rejects application-level outbound HTTP in protocol subprocesses; UDP Matter remains real. */
function allowed(target) {
  const host = target instanceof URL ? target.hostname : typeof target === 'string' ? new URL(target).hostname : target?.hostname ?? target?.host ?? 'localhost';
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
}

/** Makes an attempted remote lookup observable even if a caller catches its rejection. */
function refuse() {
  if (process.env.PHOTON_NETWORK_AUDIT_FILE) appendFileSync(process.env.PHOTON_NETWORK_AUDIT_FILE, 'Blocked outbound HTTP attempt\n');
  throw new Error('Outbound HTTP is disabled in protocol acceptance.');
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const target = input instanceof Request ? input.url : input;
  if (!allowed(target)) refuse();
  return originalFetch(input, options);
};
for (const module of [http, https]) {
  for (const name of ['request', 'get']) {
    const original = module[name];
    module[name] = function (...args) {
      if (!allowed(args[0])) refuse();
      return original.apply(this, args);
    };
  }
}
syncBuiltinESMExports();
