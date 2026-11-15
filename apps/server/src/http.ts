import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { setupInput, loginInput, commissionInput, commandInput, wifiInput, wifiImportInput } from '../../../packages/contracts/src/index.js';
import type { HubEvent } from '../../../packages/contracts/src/index.js';
import type { Config } from './config.js';
import { Auth, tokenHash } from './auth.js';
import { Hub } from './hub.js';
import { AppError } from './errors.js';
import { importMacWifi } from './mac-wifi.js';

/** Builds the HTTP boundary. Hub lifetime belongs to the caller, not a browser connection. */
export async function createHttp(config: Config, hub: Hub, auth: Auth) {
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  await app.register(cookie);
  const closeStreams = new Set<() => void>();
  const loginFailures = new Map<string, { count: number; until: number }>();
  const publicRoutes = new Set(['/api/v1/setup', '/api/v1/session']);

  /** Allows password-free access only when the local testing option is explicitly enabled. */
  function authorized(token?: string) { return config.devNoAuth || auth.valid(token); }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw new AppError('INVALID_HOST', 'Use localhost or an SSH tunnel.', 403);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.headers.origin && request.headers.origin !== `http://${host}`) throw new AppError('ORIGIN', 'Cross-origin requests are not allowed.', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('ORIGIN', 'Cross-origin requests are not allowed.', 403);
      if (request.method !== 'DELETE' && !request.headers['content-type']?.startsWith('application/json')) throw new AppError('CONTENT_TYPE', 'Send application/json.', 415);
    }
    const path = request.url.split('?')[0];
    if (path.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!publicRoutes.has(path) && !authorized(request.cookies.photon_session)) {
        throw new AppError('UNAUTHORIZED', 'Sign in to Photon.', 401);
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Check the supplied fields and try again.' } });
    if (error instanceof AppError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status < 500 ? status : 500).send({ error: { code: 'REQUEST_FAILED', message: 'The request could not be completed.' } });
  });

  /** Limits password and setup-token guessing without retaining submitted secrets. */
  async function limited<T>(ip: string, attempt: () => Promise<T>) {
    const failure = loginFailures.get(ip);
    const current = failure && failure.until > Date.now() ? failure : { count: 0, until: Date.now() + 900_000 };
    if (current.count >= 5) throw new AppError('RATE_LIMIT', 'Too many attempts. Try again in 15 minutes.', 429);
    current.count++; loginFailures.set(ip, current);
    try {
      const result = await attempt(); loginFailures.delete(ip); return result;
    } catch (error) { throw error; }
  }

  app.get('/api/v1/setup', async () => ({ initialized: auth.initialized(), mode: config.mode,
    authenticationRequired: !config.devNoAuth,
    attestation: 'Offline trust snapshot; current revocation freshness is unavailable.' }));
  app.post('/api/v1/setup', async (request, reply) => {
    if (config.devNoAuth) throw new AppError('AUTH_DISABLED', 'Owner setup is disabled during password-free local testing.', 409);
    const input = setupInput.parse(request.body);
    await limited(request.ip, () => auth.setup(input.token, input.password));
    return reply.code(201).send({ initialized: true });
  });
  app.get('/api/v1/session', async request => ({ authenticated: authorized(request.cookies.photon_session) }));
  app.post('/api/v1/session', async (request, reply) => {
    if (config.devNoAuth) return { authenticated: true };
    const input = loginInput.parse(request.body);
    const token = await limited(request.ip, () => auth.login(input.password));
    reply.setCookie('photon_session', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: Math.floor(config.sessionTtlMs / 1000) });
    return { authenticated: true };
  });
  app.delete('/api/v1/session', async (request, reply) => {
    if (config.devNoAuth) return { authenticated: true };
    if (request.cookies.photon_session) auth.logout(request.cookies.photon_session);
    reply.clearCookie('photon_session', { path: '/' });
    return { authenticated: false };
  });
  app.get('/api/v1/devices', async () => hub.snapshot().devices);
  /** Exposes only network identity and availability, never the stored password. */
  const wifiSummary = () => {
    const network = hub.store.savedWifi();
    return { saved: !!network, ssid: network?.ssid, importAvailable: process.platform === 'darwin' };
  };
  app.get('/api/v1/wifi', async () => wifiSummary());
  app.post('/api/v1/wifi', async request => {
    const input = wifiInput.parse(request.body);
    hub.store.saveWifi(input.ssid, input.password);
    return wifiSummary();
  });
  app.delete('/api/v1/wifi', async () => { hub.store.forgetWifi(); return wifiSummary(); });
  app.post('/api/v1/wifi/import', async request => {
    const input = wifiImportInput.parse(request.body);
    const network = await importMacWifi(input.ssid);
    hub.store.saveWifi(network.ssid, network.password);
    return wifiSummary();
  });
  app.post('/api/v1/commissioning', async (request, reply) => {
    const operation = hub.commission(commissionInput.parse(request.body));
    return reply.code(202).send(operation);
  });
  app.post<{ Params: { id: string; endpointId: string } }>('/api/v1/devices/:id/endpoints/:endpointId/commands', async (request, reply) => {
    const operation = hub.command(request.params.id, request.params.endpointId, commandInput.parse(request.body));
    return reply.code(202).send(operation);
  });
  app.get<{ Params: { id: string } }>('/api/v1/operations/:id', async request => hub.operation(request.params.id));

  app.get('/api/v1/events', (request, reply) => {
    const token = request.cookies.photon_session;
    const stream = reply.raw;
    let ready = false;
    let closed = false;
    const pending: HubEvent[] = [];

    /** Serializes only sanitized application events and disconnects clients that stop reading. */
    const send = (event: HubEvent) => {
      if (closed) return;
      if (!authorized(token) || stream.writableLength > 1_048_576) { close(); return; }
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const onEvent = (event: HubEvent) => { if (ready) send(event); else pending.push(event); };
    const revoked = (hash: string) => { if (token && hash === tokenHash(token)) close(); };
    const close = () => {
      if (closed) return;
      closed = true; clearInterval(heartbeat);
      hub.off('event', onEvent); auth.off('revoked', revoked); auth.off('reset', close);
      closeStreams.delete(close); stream.end();
    };
    const heartbeat = setInterval(() => {
      if (!authorized(token)) close();
      else if (stream.writableLength > 1_048_576) close();
      else stream.write(': heartbeat\n\n');
    }, 1000);
    heartbeat.unref();
    closeStreams.add(close);
    stream.on('close', close);
    if (!config.devNoAuth) { auth.on('revoked', revoked); auth.on('reset', close); }
    hub.on('event', onEvent);
    const snapshot = hub.snapshot();
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) stream.setHeader(name, value);
    stream.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    send({ type: 'snapshot', data: snapshot });
    ready = true;
    for (const event of pending) send(event);
    return reply;
  });
  app.addHook('preClose', async () => { for (const close of [...closeStreams]) close(); });
  if (existsSync(config.webDir)) {
    await app.register(staticFiles, { root: config.webDir, prefix: '/', cacheControl: true, maxAge: 0 });
  }
  return app;
}
