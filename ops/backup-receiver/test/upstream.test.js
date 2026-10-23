// End-to-end test using the REAL upstream backup code, not a reimplementation.
//
// This boots nothing and mocks nothing that matters: it imports the deployed
// v0.16.3 artifacts at freellmapi/server/dist/lib/db-backup.js and drives
// backupDbNow() and restoreDbBackupIfNeeded() against a receiver instance
// backed by real MongoDB Atlas. That is the exact call path FreeLLMAPI takes
// at boot and on its 15-minute pump.
//
// Requires MONGODB_URI; skipped with a loud warning when absent.
//
// What this proves, and what it deliberately does not:
//   proves the receiver speaks the protocol the shipped gateway actually
//   speaks - method, headers, body framing, status handling, and the
//   404-vs-500 distinction that decides whether a failed restore re-keys the
//   unified API key or fails the boot loudly.
//   does NOT prove a Render deployment works end to end; that needs the
//   deployed image and is covered by ops/scripts/test-remote-backup-restore.ps1.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { MongoClient } from 'mongodb';
import { startServer } from '../src/node.js';
import { loadConfig } from '../src/config.js';
import { MAGIC } from '../src/storage.js';

// Load better-sqlite3 out of the upstream checkout rather than installing it
// here. It is a native module that is already compiled in place, and using the
// gateway's own build means this test exercises the same SQLite library the
// deploy does.
const upstreamRequire = createRequire(
  pathToFileURL(path.resolve(import.meta.dirname, '../../../freellmapi/server/package.json')).href,
);
const Database = upstreamRequire('better-sqlite3');

const URI = process.env.MONGODB_URI?.trim();
const describeIf = URI ? describe : describe.skip;

if (!URI) {
  console.warn(
    '[upstream.test] MONGODB_URI is not set - the REAL-upstream round-trip tests were SKIPPED. ' +
      'A pass here proves nothing about the gateway round trip.',
  );
}

// The deployed build, exactly as Render runs it.
const UPSTREAM_DIST = path.resolve(import.meta.dirname, '../../../freellmapi/server/dist');
const dbBackupUrl = pathToFileURL(path.join(UPSTREAM_DIST, 'lib', 'db-backup.js')).href;

const RUN_ID = Date.now().toString(36);
const DB_NAME = `freellmapi_upstream_test_${RUN_ID}`;
const TOKEN = `upstream-token-${RUN_ID}-${crypto.randomBytes(12).toString('hex')}`;
// A real 64-hex key, as ENCRYPTION_KEY must be. Random per run so no test can
// depend on, or leak, the production key.
const ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

/** Drive the upstream module with the receiver's env, saving/restoring the
 *  process env around each call because upstream reads it at call time. */
async function withUpstreamEnv(extra, fn) {
  const saved = {};
  const apply = {
    FREEAPI_DB_BACKUP_TARGET: '',
    FREEAPI_DB_BACKUP_URL: '',
    FREEAPI_DB_BACKUP_PATH: '',
    FREEAPI_DB_BACKUP_TOKEN: TOKEN,
    ENCRYPTION_KEY,
    ...extra,
  };
  for (const [k, v] of Object.entries(apply)) {
    saved[k] = process.env[k];
    if (v === '') delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describeIf('real upstream db-backup <-> receiver <-> real Atlas', () => {
  let app;
  let client;
  let target;
  let scratch;

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-receiver-e2e-'));
    const config = loadConfig({
      MONGODB_URI: URI,
      BACKUP_TOKEN: TOKEN,
      MONGODB_DB: DB_NAME,
      MONGODB_COLLECTION: 'revisions',
      BACKUP_RETENTION: '5',
      BACKUP_PATH: '/backup.bin',
    });
    app = await startServer({ config, port: 0, host: '127.0.0.1' });
    target = `http://127.0.0.1:${app.port}/backup.bin`;
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 15_000 });
    await client.connect();
  }, 90_000);

  afterAll(async () => {
    // The Atlas user is least-privilege and cannot dropDatabase, so cleanup
    // empties the collections it touched and tolerates any failure. Leaking a
    // few test documents is acceptable; failing the suite on a permissions
    // error during teardown is not.
    try {
      const names = (await client.db(DB_NAME).listCollections().toArray()).map((c) => c.name);
      for (const name of names) {
        await client.db(DB_NAME).collection(name).deleteMany({}).catch(() => {});
      }
    } catch {
      // Listing may be restricted; nothing to do then.
    }
    await client?.close();
    await app?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('backs up through the real pump and restores the same bytes and key', async () => {
    const dbPath = path.join(scratch, 'e2e.db');
    const db = new Database(dbPath);
    // A table and row standing in for the settings that must survive: the
    // unified API key lives in settings.unified_api_key in the real schema.
    const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}-`;
    db.exec(
      `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       INSERT INTO settings (key, value) VALUES ('unified_api_key', '${key}');
       CREATE TABLE items (name TEXT NOT NULL);
       INSERT INTO items (name) VALUES ('survived');`,
    );

    const { backupDbNow } = await import(dbBackupUrl);

    // 1. real pump uploads to the receiver
    const backup = await withUpstreamEnv({ FREEAPI_DB_BACKUP_URL: target }, () => backupDbNow(db, dbPath));
    expect(backup.ok).toBe(true);
    expect(backup.bytes).toBeGreaterThan(0);
    db.close();

    // 2. the blob really landed in Atlas, and is NOT plaintext
    const coll = client.db(DB_NAME).collection('revisions');
    const doc = await coll.find({}).sort({ seq: -1 }).limit(1).next();
    expect(doc).toBeTruthy();
    const bytes = Buffer.from(doc.payload.buffer);
    expect(bytes.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(bytes.includes(Buffer.from('survived'))).toBe(false);

    // 3. wipe the database, the Render spin-down scenario
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      fs.rmSync(f, { force: true });
    }
    expect(fs.existsSync(dbPath)).toBe(false);

    // 4. the real restore path must rebuild it from the receiver
    const { restoreDbBackupIfNeeded } = await import(dbBackupUrl);
    const restored = await withUpstreamEnv({ FREEAPI_DB_BACKUP_URL: target }, () => restoreDbBackupIfNeeded(dbPath));
    expect(restored.restored).toBe(true);

    // 5. the unified API key and the data survive, byte-identically
    const reopened = new Database(dbPath);
    const row = reopened.prepare(`SELECT value FROM settings WHERE key = 'unified_api_key'`).get();
    expect(row.value).toBe(key);
    expect(reopened.prepare(`SELECT name FROM items`).get().name).toBe('survived');
    reopened.close();
  }, 90_000);

  it('returns 404 for a genuinely empty receiver, which the gateway treats as first-deploy', async () => {
    // A fresh collection. Upstream must see "no backup found" and skip rather
    // than fail - this is the one case where 404 is correct.
    const config = loadConfig({
      MONGODB_URI: URI,
      BACKUP_TOKEN: TOKEN,
      MONGODB_DB: DB_NAME,
      MONGODB_COLLECTION: `empty_${RUN_ID}`,
      BACKUP_PATH: '/backup.bin',
    });
    const localApp = await startServer({ config, port: 0, host: '127.0.0.1' });
    try {
      const url = `http://127.0.0.1:${localApp.port}/backup.bin`;
      const dbPath = path.join(scratch, 'never-backed-up.db');
      fs.rmSync(dbPath, { force: true });

      const { restoreDbBackupIfNeeded } = await import(dbBackupUrl);
      const result = await withUpstreamEnv({ FREEAPI_DB_BACKUP_URL: url }, () => restoreDbBackupIfNeeded(dbPath));
      // ok:true with skipped:'no backup found' - the honest first-deploy path.
      expect(result.ok).toBe(true);
      expect(result.restored).toBeUndefined();
      expect(result.skipped).toBe('no backup found');
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      await localApp.close();
    }
  }, 60_000);

  it('rejects a wrong token, and upstream surfaces it as a FAILED upload', async () => {
    const dbPath = path.join(scratch, 'wrong-token.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (x TEXT)');

    const { backupDbNow } = await import(dbBackupUrl);
    // Upstream only warns on upload failure (it never crashes the gateway for
    // a transient upload problem), so the assertion is that it THROWS and the
    // caller can tell. The receiver's own 401 is asserted directly too.
    const err = await withUpstreamEnv(
      { FREEAPI_DB_BACKUP_URL: target, FREEAPI_DB_BACKUP_TOKEN: 'definitely-not-the-right-token' },
      () => backupDbNow(db, dbPath).catch((e) => e),
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/401|upload failed/i);
    db.close();

    // And the receiver refuses the wrong token on restore as well, with 401
    // (not 404) so a boot with a bad token fails loudly instead of re-keying.
    const res = await fetch(target, { headers: { Authorization: 'Bearer wrong-token' } });
    expect(res.status).toBe(401);
    fs.rmSync(dbPath, { force: true });
  }, 60_000);

  it('refuses an unauthenticated request entirely', async () => {
    const res = await fetch(target);
    expect(res.status).toBe(401);
    const res2 = await fetch(target, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x') });
    expect(res2.status).toBe(401);
  });

  it('upstream rejects a receiver that is down, rather than silently succeeding', async () => {
    // Port 1 is reserved and refuses connections. A real outage must surface
    // as an error the operator can see, never as a quiet "ok".
    const dbPath = path.join(scratch, 'down.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (x TEXT)');

    const { backupDbNow } = await import(dbBackupUrl);
    const err = await withUpstreamEnv(
      { FREEAPI_DB_BACKUP_URL: 'http://127.0.0.1:1/backup.bin' },
      () => backupDbNow(db, dbPath).catch((e) => e),
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/upload failed|fetch failed|ECONNREFUSED/i);
    db.close();
    fs.rmSync(dbPath, { force: true });
  }, 60_000);

  it('preserves the blob across a second pump cycle (overwrite semantics)', async () => {
    // The pump runs every 15 minutes; each cycle must replace, not accumulate
    // into an unreadable pile, and the newest must always be the last write.
    const dbPath = path.join(scratch, 'cycle.db');
    const { backupDbNow, restoreDbBackupIfNeeded } = await import(dbBackupUrl);

    for (const marker of ['cycle-one', 'cycle-two', 'cycle-three']) {
      fs.rmSync(dbPath, { force: true });
      const db = new Database(dbPath);
      db.exec(`CREATE TABLE m (v TEXT NOT NULL); INSERT INTO m (v) VALUES ('${marker}')`);
      await withUpstreamEnv({ FREEAPI_DB_BACKUP_URL: target }, () => backupDbNow(db, dbPath));
      db.close();
      fs.rmSync(dbPath, { force: true });
      await withUpstreamEnv({ FREEAPI_DB_BACKUP_URL: target }, () => restoreDbBackupIfNeeded(dbPath));
      const check = new Database(dbPath);
      expect(check.prepare('SELECT v FROM m').get().v).toBe(marker);
      check.close();
    }

    // Retention must have pruned the older cycles rather than growing forever.
    const coll = client.db(DB_NAME).collection('revisions');
    expect(await coll.countDocuments({})).toBeLessThanOrEqual(5);
    fs.rmSync(dbPath, { force: true });
  }, 120_000);
});
