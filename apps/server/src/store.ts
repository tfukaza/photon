import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Device, Operation } from '../../../packages/contracts/src/index.js';

/** Owns application data only. Matter credentials stay in the adapter's separate store. */
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'photon.db'));
    chmodSync(join(directory, 'photon.db'), 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  /** Applies the initial schema atomically, retaining a version for future changes. */
  private migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup(id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wifi_network(id INTEGER PRIMARY KEY CHECK(id=1), ssid TEXT NOT NULL, password TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1);
      INSERT OR IGNORE INTO migrations VALUES(2);
      COMMIT;`);
  }

  /** Reads the single remembered network for server-side provisioning; never return this object through HTTP. */
  savedWifi(): { ssid: string; password: string } | undefined {
    return this.db.prepare('SELECT ssid,password FROM wifi_network WHERE id=1').get() as { ssid: string; password: string } | undefined;
  }

  /** Replaces credentials only after explicit user opt-in; storage is protected by directory/file permissions. */
  saveWifi(ssid: string, password: string) {
    this.db.prepare('INSERT INTO wifi_network VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET ssid=excluded.ssid,password=excluded.password').run(ssid, password);
  }

  /** Removes the remembered network without changing credentials already used by a running operation. */
  forgetWifi() { this.db.prepare('DELETE FROM wifi_network').run(); }

  /** Replaces application metadata without taking ownership of live device state. */
  rememberDevice(device: Device) {
    this.db.prepare('INSERT INTO devices(id,name) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(device.id, device.name);
  }

  /** Returns persisted identities even while the controller has not connected yet. */
  deviceRecords(): { id: string; name: string }[] {
    return this.db.prepare('SELECT id,name FROM devices').all() as { id: string; name: string }[];
  }

  /** Persists sanitized operation state; onboarding inputs must never enter this method. */
  saveOperation(operation: Operation) {
    this.db.prepare('INSERT INTO operations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(operation.id, JSON.stringify(operation));
  }

  /** Returns operation history in creation order, including active work. */
  operations(): Operation[] {
    return this.db.prepare('SELECT data FROM operations ORDER BY rowid').all()
      .map(row => JSON.parse(String(row.data)) as Operation);
  }

  /** Releases the application database after the controller has stopped. */
  close() { this.db.close(); }
}
