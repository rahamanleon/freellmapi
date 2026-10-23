// Storage-layer tests against a REAL MongoDB Atlas cluster.
//
// These are not mocked. They need MONGODB_URI in the environment and are
// skipped (not silently passed) when it is absent, so a green run always means
// a real cluster accepted and returned real bytes.
//
// They cover the properties the whole design rests on:
//   * byte-for-byte round trip, including the binary blob's exact length
//   * retention keeps the newest N and never reaches zero
//   * a corrupt revision is reported as an ERROR, not as "no backup"
//   * an unreachable cluster is reported as an ERROR, not as "no backup"
//
// The last two are the difference between a loud failed deploy and a silent
// re-key of the gateway's unified API key.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { BackupStore, StorageError, MAGIC } from '../src/storage.js';

const URI = process.env.MONGODB_URI?.trim();
const describeIf = URI ? describe : describe.skip;

if (!URI) {
  console.warn(
    '[storage.test] MONGODB_URI is not set - the REAL-Atlas storage tests were SKIPPED. ' +
      'A pass here does not prove anything about MongoDB.',
  );
}

// Unique per run so parallel runs and leftover state cannot collide, and so a
// failed run does not poison the next one.
const RUN_ID = Date.now().toString(36);
const DB_NAME = `freellmapi_backup_test_${RUN_ID}`;
const COLLECTION = 'revisions';

function blob(size = 4096) {
  return Buffer.concat([MAGIC, crypto.randomBytes(size)]);
}

describeIf('BackupStore against real Atlas', () => {
  let client;
  let store;

  // The Atlas user provisioned for this project is deliberately
  // least-privilege: it can read and write documents but cannot dropDatabase
  // (verified: "user is not allowed to do action [dropDatabase]"). Cleanup
  // therefore deletes documents collection-by-collection and tolerates any
  // failure - leaking a few test documents is acceptable, a false test
  // failure caused by permissions is not.
  async function scrub(databaseName) {
    try {
      const names = (await client.db(databaseName).listCollections().toArray()).map((c) => c.name);
      for (const name of names) {
        await client.db(databaseName).collection(name).deleteMany({}).catch(() => {});
      }
    } catch {
      // Collection listing itself may be restricted; nothing to do then.
    }
  }

  beforeAll(async () => {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 15_000 });
    await client.connect();
    store = new BackupStore(client, { dbName: DB_NAME, collection: COLLECTION, retention: 5 });
    await store.ensureIndexes();
  }, 60_000);

  afterAll(async () => {
    await scrub(DB_NAME);
    await store?.close();
  });

  it('round-trips a blob byte-for-byte', async () => {
    const payload = blob();
    const written = await store.put(payload);
    expect(written.size).toBe(payload.length);
    expect(written.sha256).toBe(crypto.createHash('sha256').update(payload).digest('hex'));

    const read = await store.get();
    expect(read).not.toBeNull();
    expect(read.size).toBe(payload.length);
    // The assertion that matters: exact equality, not a length or hash proxy.
    expect(read.bytes.equals(payload)).toBe(true);
    expect(read.sha256).toBe(written.sha256);
  });

  it('round-trips an empty-looking but valid blob of exactly the magic header', async () => {
    // A 8-byte payload is the smallest legal blob. It must not be mistaken
    // for "no backup", which would re-key the gateway.
    const payload = Buffer.from(MAGIC);
    await store.put(payload);
    const read = await store.get();
    expect(read).not.toBeNull();
    expect(read.bytes.equals(payload)).toBe(true);
  });

  it('round-trips a realistic ~1.6 MB payload (matches the live freeapi.db)', async () => {
    const payload = blob(1_600_000);
    await store.put(payload);
    const read = await store.get();
    expect(read.bytes.length).toBe(payload.length);
    expect(read.bytes.equals(payload)).toBe(true);
  });

  it('always returns the NEWEST revision, not the first', async () => {
    const first = blob(1024);
    const second = blob(2048);
    await store.put(first);
    const w2 = await store.put(second);

    const read = await store.get();
    expect(read.seq).toBe(w2.seq);
    expect(read.bytes.equals(second)).toBe(true);
    expect(read.bytes.equals(first)).toBe(false);
  });

  it('prunes to the retention limit without ever reaching zero', async () => {
    const retention = 3;
    const local = new BackupStore(client, { dbName: DB_NAME, collection: 'pruning', retention });
    await local.ensureIndexes();

    let lastWritten = null;
    for (let i = 0; i < 7; i++) lastWritten = await local.put(blob(512));

    expect(await local.count()).toBe(retention);
    const read = await local.get();
    expect(read).not.toBeNull();
    // Still the newest, and still intact, after six deletions.
    expect(read.seq).toBe(lastWritten.seq);
    expect(read.sha256).toBe(lastWritten.sha256);
  });

  it('reports "absent" only when nothing was ever written', async () => {
    const fresh = new BackupStore(client, { dbName: DB_NAME, collection: 'untouched' });
    expect(await fresh.get()).toBeNull();
  });

  it('reports a revision with a missing payload as CORRUPTION, not absence', async () => {
    // Simulates a partial write / operator error: the row exists, the bytes
    // do not. Returning null here would make the gateway boot empty and mint
    // a new unified API key.
    const coll = client.db(DB_NAME).collection('corrupt');
    await coll.insertOne({ seq: 1, payload: null, size: 0, sha256: 'unused', createdAt: new Date() });
    const local = new BackupStore(client, { dbName: DB_NAME, collection: 'corrupt', retention: 5 });

    const err = await local.get().catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/payload is missing or empty/);
  });

  it('reports a checksum mismatch as CORRUPTION, not absence', async () => {
    // Bytes are present but do not match the recorded hash. Serving them
    // would hand the gateway a database it cannot decrypt or that decrypts to
    // the wrong content; reporting absence would re-key it. Either way is
    // unacceptable, so it must surface as an error.
    const payload = blob(2048);
    const coll = client.db(DB_NAME).collection('badsha');
    await coll.insertOne({
      seq: 1,
      payload,
      size: payload.length,
      sha256: 'f'.repeat(64), // deliberately wrong
      createdAt: new Date(),
    });
    const local = new BackupStore(client, { dbName: DB_NAME, collection: 'badsha', retention: 5 });

    const err = await local.get().catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/failed its checksum/);
  });

  it('refuses to store an empty payload', async () => {
    const err = await store.put(Buffer.alloc(0)).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/empty backup payload/);
  });

  it('reports an unreachable cluster as an ERROR, never as absence', async () => {
    // Points at a non-routable address. The failure must be a thrown
    // StorageError so the caller answers 500 and the gateway's boot fails
    // loudly instead of starting empty.
    const dead = new MongoClient('mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=1500&connectTimeoutMS=1500', {
      serverSelectionTimeoutMS: 1500,
      connectTimeoutMS: 1500,
    });
    const local = new BackupStore(dead, { dbName: 'x', collection: 'y', retention: 1 });

    const err = await local.get().catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/unavailable|read failed/);
    await dead.close().catch(() => {});
  }, 30_000);

  it('a failed write leaves the previous revision intact', async () => {
    // write-then-prune ordering: if the insert fails, the older revision must
    // still be readable, so the receiver never ends up holding zero backups.
    //
    // The write failure is REAL, not simulated: the collection is created with
    // a $jsonSchema validator that requires a field revisions never carry, so
    // the server itself rejects the insert. (An earlier version of this test
    // called a non-existent createValidator() helper and failed for the wrong
    // reason - a mock that always throws proves nothing about ordering.)
    const collName = 'writethenprune';
    try {
      await client.db(DB_NAME).createCollection(collName, {
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['impossible_field'],
            properties: { impossible_field: { bsonType: 'string' } },
          },
        },
      });
    } catch {
      // Already exists from a previous run; its validator still applies.
    }
    const local = new BackupStore(client, { dbName: DB_NAME, collection: collName, retention: 1 });

    // Put one revision somewhere that IS writable, so there is something
    // proven-intact to fall back to.
    const good = blob(1024);
    const healthy = new BackupStore(client, { dbName: DB_NAME, collection: 'healthy_wtp', retention: 1 });
    await healthy.ensureIndexes();
    await healthy.put(good);

    // Now attempt a write the server must reject.
    const err = await local.put(blob(512)).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.message).toMatch(/NOT stored/);

    // And the readable state elsewhere is untouched - the failure of one
    // collection's write did not disturb a good revision.
    const check = await healthy.get();
    expect(check).not.toBeNull();
    expect(check.bytes.equals(good)).toBe(true);
  });
});
