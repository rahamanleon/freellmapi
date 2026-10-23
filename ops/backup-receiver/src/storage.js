// MongoDB storage layer for the backup receiver.
//
// The whole safety story of this service lives here, and it turns on one
// asymmetry that comes from how FreeLLMAPI reacts to the two outcomes:
//
//   * a RESTORE error (any non-2xx other than 404/204) throws in
//     restoreDbBackupIfNeeded(), reaches main().catch(), and exits 1. The
//     deploy fails loudly and the operator finds out.
//   * a RESTORE 404 is treated as "no backup found", the server boots an
//     EMPTY database, and the baseline migration mints a NEW unified API key.
//     Every client silently starts getting 401s.
//
// So `get()` may report "absent" in exactly one situation: no revision has
// ever been written. If a revision exists but its payload is missing,
// truncated, or fails its checksum, that is corruption - it surfaces as a
// thrown StorageError (HTTP 500) and therefore as a failed boot, never as a
// quiet re-key. A Mongo connection failure behaves the same way.
//
// Writes are likewise write-then-prune: the new revision is inserted and
// acknowledged BEFORE any older revision is deleted, so a write that fails
// halfway can never leave the receiver holding zero backups.

import crypto from 'node:crypto';
import { Binary } from 'mongodb';

export const MAGIC = Buffer.from('FAPIBK1\0', 'binary');

/** A failure that must be reported to the caller rather than swallowed.
 *  `status` is the HTTP status the receiver should answer with. */
export class StorageError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

/** Errors that mean "we could not consult MongoDB at all". These are always
 *  500s: the receiver must never translate an outage into a 404, because a
 *  404 is what makes the gateway re-key itself. */
function isMongoUnavailable(err) {
  const code = err?.codeName ?? err?.code ?? '';
  const name = err?.name ?? '';
  return (
    name === 'MongoServerSelectionError' ||
    name === 'MongoNetworkError' ||
    name === 'MongoClientClosedError' ||
    String(code).includes('TIMEOUT') ||
    String(code).includes('ExceededTimeLimit')
  );
}

function toBuffer(binary) {
  // BSON Binary exposes the raw bytes on `.buffer`. Copy rather than alias so
  // a caller mutating the result can never touch the driver's own view.
  const b = binary?.buffer ?? binary;
  if (Buffer.isBuffer(b)) return Buffer.from(b);
  if (b instanceof Uint8Array) return Buffer.from(b);
  return null;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export class BackupStore {
  /**
   * @param {import('mongodb').MongoClient} client
   * @param {{dbName: string, collection: string, retention: number}} opts
   */
  constructor(client, { dbName, collection, retention }) {
    this.client = client;
    this.db = client.db(dbName);
    this.revisions = this.db.collection(collection);
    // Sequence numbers come from a SEPARATE counter document, never from the
    // revisions collection itself. Allocating them with an upsert against the
    // revisions collection leaves a counter row sitting among the revisions -
    // it inflates the retention count by one, and because it carries the
    // highest seq with no payload, a `get()` ordered by seq desc can return
    // it and misreport a perfectly good backup as corrupt. Keeping the
    // counter elsewhere makes "every document in revisions is a real
    // revision" an invariant instead of a hope.
    this.counters = this.db.collection(`${collection}_counter`);
    this.retention = retention;
    this._indexesReady = false;
  }

  /** Create the index that orders revisions newest-first.
   *  Idempotent; safe to call on every boot. */
  async ensureIndexes() {
    if (this._indexesReady) return;
    await this.revisions.createIndex({ seq: -1, createdAt: -1 });
    this._indexesReady = true;
  }

  /** Allocate the next sequence number.
   *
   *  Atomic via $inc, so two concurrent writers cannot receive the same value.
   *  A single document keyed by a fixed _id is the whole counter; upserting it
   *  here is safe because this collection holds counters and nothing else. */
  async #nextSeq() {
    const doc = await this.counters.findOneAndUpdate(
      { _id: 'revisions' },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    // Driver v6 returns the document directly; older builds wrapped it in
    // { value: ... }. Accept both rather than breaking on an upgrade.
    const seq = typeof doc?.value === 'number' ? doc.value : doc?.value?.value;
    if (!Number.isInteger(seq) || seq < 1) {
      throw new StorageError(`could not allocate a backup sequence number (got ${JSON.stringify(doc)})`);
    }
    return seq;
  }

  /** Newest revision, or null if nothing has ever been stored.
   *  Throws StorageError(500) on any Mongo failure or on a corrupt record. */
  async get() {
    let rec;
    try {
      rec = await this.revisions.find({}).sort({ seq: -1, createdAt: -1 }).limit(1).next();
    } catch (err) {
      if (isMongoUnavailable(err)) {
        throw new StorageError(`mongodb unavailable while reading the backup: ${err.message}`);
      }
      throw new StorageError(`mongodb read failed: ${err.message}`);
    }

    // No document at all = the honest "no backup has ever been written" case.
    if (!rec) return null;

    const buf = toBuffer(rec.payload);
    if (!buf || buf.length === 0) {
      // A revision row exists but holds no bytes. Reporting absence here would
      // re-key the gateway, so this is corruption and must fail the boot.
      throw new StorageError(
        `the newest backup revision (seq ${rec.seq}) exists but its payload is missing or empty`,
      );
    }

    const actual = sha256(buf);
    if (rec.sha256 && rec.sha256 !== actual) {
      throw new StorageError(
        `the newest backup revision (seq ${rec.seq}) failed its checksum ` +
          `(stored ${rec.sha256.slice(0, 16)}..., computed ${actual.slice(0, 16)}...)`,
      );
    }

    return { seq: rec.seq, bytes: buf, size: buf.length, sha256: actual, createdAt: rec.createdAt };
  }

  /** Store a new revision, then prune older ones.
   *  Returns {seq, size, sha256} for logging. */
  async put(payload) {
    if (!Buffer.isBuffer(payload) || payload.length === 0) {
      throw new StorageError('refusing to store an empty backup payload', 400);
    }

    const seq = await this.#nextSeq();

    const record = {
      seq,
      payload: new Binary(payload),
      size: payload.length,
      sha256: sha256(payload),
      createdAt: new Date(),
    };

    try {
      await this.revisions.insertOne(record);
    } catch (err) {
      // The write failed, so the previous revisions are still intact. Say so
      // explicitly rather than leaving the caller to assume the backup landed.
      throw new StorageError(
        `backup revision ${seq} was NOT stored (${err.message}); ` +
          'the previous revision remains the newest',
      );
    }

    // Write-then-prune: only now is it safe to drop old revisions. Pruning is
    // best-effort - a failure here leaves extra history, never zero backups.
    try {
      await this.revisions.deleteMany({ seq: { $lt: seq - this.retention + 1 } });
    } catch {
      // Intentionally not fatal: retention drift is visible in the next cycle.
    }

    return { seq, size: payload.length, sha256: record.sha256 };
  }

  /** Retention/pruning is a no-op for reads, but a deployment may want to know
   *  how much history is being kept. */
  async count() {
    try {
      return await this.revisions.countDocuments({});
    } catch {
      return -1;
    }
  }

  async close() {
    try {
      await this.client.close();
    } catch {
      // Closing a client that is already gone is not an error worth surfacing.
    }
  }
}
