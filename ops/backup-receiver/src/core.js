// Platform-agnostic request handler for the backup receiver.
//
// Speaks exactly the protocol FreeLLMAPI v0.16.3's lib/db-backup.ts produces
// and consumes (see ops/backup-receiver/README.md for the verified table):
//
//   PUT <target>  Content-Type: application/octet-stream
//                 Authorization: Bearer <token>   (present only when
//                                                  FREEAPI_DB_BACKUP_TOKEN is set)
//                 body: raw encrypted blob (NOT base64 - base64 is the
//                       huggingface.co commit-API path only)
//                 -> any 2xx; anything else makes upstream throw
//
//   GET <target>  Authorization: Bearer <token>
//                 -> 200 + raw bytes, or 404/204 meaning "no backup found"
//
// Upstream allows 30 s per call, so nothing here may block indefinitely.
//
// Two rules are load-bearing and are enforced here rather than left to
// storage.js, because they decide whether a failed deploy is loud or silent:
//
//   1. 404 is only ever returned when the store says "no revision has ever
//      been written". Every other failure - Mongo down, corrupt payload,
//      bad checksum - is a 5xx, which makes the gateway's restore throw and
//      the boot exit 1 instead of minting a fresh unified API key.
//   2. Auth is checked before any Mongo call, so an unauthenticated caller
//      can neither read nor overwrite the backup, and cannot use response
//      timing to probe what is stored.

import crypto from 'node:crypto';
import { StorageError, MAGIC } from './storage.js';

export const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const BINARY_HEADERS = {
  'Content-Type': 'application/octet-stream',
  // The blob is already AES-256-GCM encrypted by the sender, but it is still
  // the gateway's full database. Keep any intermediary from caching it.
  'Cache-Control': 'no-store',
};

/** Constant-time bearer-token comparison. The digest comparison avoids both
 *  the length leak of a naive equality check and the timing signal of an
 *  early return on the first differing byte. */
export function tokenMatches(expected, presented) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(presented, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** Pull the bare token out of an Authorization header. Returns null when the
 *  header is missing or uses a scheme other than Bearer. */
export function extractBearer(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)\s*$/i.exec(authorization);
  return match ? match[1] : null;
}

function isAuthorized(config, authorization) {
  return tokenMatches(config.token, extractBearer(authorization));
}

function json(status, body, extra = {}) {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body: Buffer.from(JSON.stringify(body)) };
}

/**
 * @param {{method: string, path: string, headers: Record<string,string>,
 *          body: Buffer | null}} req
 * @param {{store: import('./storage.js').BackupStore, config: object}} ctx
 * @returns {Promise<{status: number, headers: Record<string,string>, body: Buffer}>}
 */
export async function handleRequest(req, ctx) {
  const { store, config } = ctx;
  const method = String(req.method ?? '').toUpperCase();
  // Compare on pathname only; upstream never sends a query string, and
  // treating "/backup.bin?x=1" as a different resource would only create a
  // confusing failure at 2 a.m.
  const path = String(req.path ?? '').split('?')[0];

  // --- routing -------------------------------------------------------------
  if (path !== config.path) {
    // Deliberately answered before auth: an unknown path is not this
    // service's resource, and 404-without-touching-Mongo is the cheapest
    // possible answer. Nothing about the stored state is revealed.
    return json(404, { ok: false, error: 'not found' });
  }

  if (method !== 'GET' && method !== 'PUT') {
    return json(405, { ok: false, error: 'method not allowed' }, { Allow: 'GET, PUT' });
  }

  // --- authentication ------------------------------------------------------
  // Before any storage call, so an unauthenticated request cannot read,
  // overwrite, or probe the backup.
  if (!isAuthorized(config, req.headers?.authorization)) {
    return json(401, { ok: false, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  }

  // --- GET -----------------------------------------------------------------
  if (method === 'GET') {
    try {
      const found = await store.get();
      if (!found) {
        // The ONLY permitted 404: nothing has ever been stored. Upstream
        // treats this as "no backup found" and boots empty, which is correct
        // on a genuinely first deploy.
        return json(404, { ok: false, error: 'no backup stored' });
      }
      return {
        status: 200,
        headers: {
          ...BINARY_HEADERS,
          'Content-Length': String(found.size),
          // Checksum is echoed so the operator can verify a download without
          // ever needing to decrypt the blob.
          'X-Backup-Sha256': found.sha256,
          'X-Backup-Seq': String(found.seq),
          // Freshness signal. Upstream only warns when an upload fails, so a
          // dead pump is otherwise indistinguishable from a healthy one until
          // a spin-down reveals it. This header is what lets an external
          // check notice a pump that has stopped keeping up.
          'X-Backup-Created-At': found.createdAt instanceof Date
            ? found.createdAt.toISOString()
            : new Date(found.createdAt ?? Date.now()).toISOString(),
        },
        body: found.bytes,
      };
    } catch (err) {
      // Mongo outage or a corrupt revision. MUST be 5xx - see rule 1 above.
      const status = err instanceof StorageError ? err.status : 500;
      return json(status, {
        ok: false,
        error: 'backup could not be read; the gateway will fail to restore rather than start empty',
        detail: String(err?.message ?? err).slice(0, 300),
      });
    }
  }

  // --- PUT -----------------------------------------------------------------
  // Upstream always sets this header; its absence means the client is not
  // FreeLLMAPI (or is misconfigured), which is worth saying out loud.
  const contentType = req.headers?.['content-type'] ?? '';
  if (!/^application\/octet-stream/i.test(String(contentType))) {
    return json(400, {
      ok: false,
      error: 'expected Content-Type: application/octet-stream',
    });
  }

  const payload = req.body;
  if (!payload || payload.length === 0) {
    return json(400, { ok: false, error: 'empty request body' });
  }

  if (payload.length > config.maxBytes) {
    return json(413, {
      ok: false,
      error: `backup of ${payload.length} bytes exceeds the ${config.maxBytes} byte limit`,
      maxBytes: config.maxBytes,
    });
  }

  if (config.requireMagic && !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    // Upstream's encrypted blob always starts with "FAPIBK1\0" (MAGIC in
    // db-backup.ts). Storing a payload without it would guarantee a failed
    // restore later, so refuse now, while the failure is still visible.
    return json(400, {
      ok: false,
      error: 'payload does not start with the FreeLLMAPI backup magic header; refusing to store it',
    });
  }

  try {
    const written = await store.put(payload);
    return json(200, {
      ok: true,
      seq: written.seq,
      bytes: written.size,
      sha256: written.sha256,
    });
  } catch (err) {
    const status = err instanceof StorageError ? err.status : 500;
    return json(status, {
      ok: false,
      error: 'backup was NOT stored',
      detail: String(err?.message ?? err).slice(0, 300),
    });
  }
}
