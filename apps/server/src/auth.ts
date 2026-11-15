import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { Store } from './store.js';
import { AppError } from './errors.js';

const scrypt = promisify(scryptCallback);

/** Produces an irreversible lookup value for a high-entropy bearer token. */
export function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }

/** Generates a salted, memory-hard password verifier. */
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}

/** Checks an encoded verifier in constant time after deriving its key. */
async function verifyPassword(password: string, encoded: string) {
  const [salt, expected] = encoded.split(':');
  const key = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(key, Buffer.from(expected, 'hex'));
}

/** Manages a single local owner and revocable sessions, with atomic first-owner setup. */
export class Auth extends EventEmitter {
  constructor(private store: Store, private ttlMs: number) { super(); }

  /** Reports whether local owner setup is finished. */
  initialized() { return !!this.store.db.prepare('SELECT id FROM owner').get(); }

  /** Rotates the local setup token; only available before an owner exists. */
  issueSetupToken() {
    if (this.initialized()) throw new AppError('ALREADY_CONFIGURED', 'An owner already exists.', 409);
    const token = randomBytes(32).toString('base64url');
    this.store.db.prepare('INSERT INTO setup VALUES(1,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash')
      .run(tokenHash(token));
    return token;
  }

  /** Consumes a token and creates the owner in one transaction after password derivation. */
  async setup(token: string, password: string) {
    const encoded = await hashPassword(password);
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (this.initialized()) throw new AppError('ALREADY_CONFIGURED', 'An owner already exists.', 409);
      const row = db.prepare('SELECT token_hash FROM setup WHERE id=1').get();
      if (!row || row.token_hash !== tokenHash(token)) throw new AppError('INVALID_TOKEN', 'The setup token is invalid.', 403);
      db.prepare('INSERT INTO owner VALUES(1,?)').run(encoded);
      db.exec('DELETE FROM setup; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  /** Authenticates the owner and issues an expiring opaque session. */
  async login(password: string) {
    const row = this.store.db.prepare('SELECT password FROM owner WHERE id=1').get();
    if (!row || !await verifyPassword(password, String(row.password))) {
      throw new AppError('INVALID_LOGIN', 'The password is incorrect.', 401);
    }
    const token = randomBytes(32).toString('base64url');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.store.db.prepare('SELECT password FROM owner WHERE id=1').get();
      if (current?.password !== row.password) throw new AppError('INVALID_LOGIN', 'The password changed. Sign in again.', 401);
      this.store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(tokenHash(token), Date.now() + this.ttlMs);
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    return token;
  }

  /** Checks persisted session validity, including expiry after a process restart. */
  valid(token?: string) {
    if (!token) return false;
    const row = this.store.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(tokenHash(token));
    return !!row && Number(row.expires) > Date.now();
  }

  /** Revokes a session and closes its existing event streams. */
  logout(token: string) {
    this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash(token));
    this.emit('revoked', tokenHash(token));
  }

  /** Resets the local password and invalidates all sessions without touching pairings. */
  async reset(password: string) {
    if (!this.initialized()) throw new AppError('NOT_CONFIGURED', 'Create the owner first.');
    const encoded = await hashPassword(password);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('UPDATE owner SET password=? WHERE id=1').run(encoded);
      this.store.db.exec('DELETE FROM sessions; COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.emit('reset');
  }
}
