// Protocol-level tests for the receiver's request handler.
//
// These exercise the HTTP contract against an in-memory store, because what
// is under test here is the *routing and safety rules*, not MongoDB. The
// storage layer itself is proven against a real Atlas cluster in
// storage.test.js, and the full upstream round trip in upstream.test.js.
//
// The rules asserted here are the ones that decide whether a failed deploy is
// loud (good) or silently re-keys the gateway (catastrophic), so each of them
// is stated as an explicit expectation rather than inferred from a snapshot.

import { describe, it, expect } from 'vitest';
import { handleRequest, tokenMatches, extractBearer } from '../src/core.js';
import { StorageError, MAGIC } from '../src/storage.js';

const TOKEN = 'test-token-0123456789abcdef';
const CONFIG = {
  token: TOKEN,
  path: '/backup.bin',
  maxBytes: 1024,
  requireMagic: true,
};

const BLOB = Buffer.concat([MAGIC, Buffer.from('ciphertext-for-tests')]);

/** Minimal in-memory stand-in implementing the two methods handleRequest uses. */
function fakeStore({ newest = null, getError = null, putError = null } = {}) {
  const written = [];
  return {
    written,
    async get() {
      if (getError) throw getError;
      return newest;
    },
    async put(payload) {
      if (putError) throw putError;
      const record = { seq: written.length + 1, bytes: payload, size: payload.length, sha256: 'x'.repeat(64) };
      written.push(record);
      return { seq: record.seq, size: payload.length, sha256: record.sha256 };
    },
  };
}

function req(overrides = {}) {
  return {
    method: 'PUT',
    path: '/backup.bin',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
    body: BLOB,
    ...overrides,
  };
}

const ctx = (store) => ({ store, config: CONFIG });
const asJson = (res) => JSON.parse(res.body.toString('utf8'));

describe('bearer token comparison', () => {
  it('accepts the exact token and rejects everything else', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(tokenMatches(TOKEN, '')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
  });

  it('rejects tokens of a different length without throwing', () => {
    // A naive timingSafeEqual throws on unequal lengths; that must not become
    // a 500 that an attacker can use to distinguish "wrong" from "broken".
    expect(tokenMatches(TOKEN, 'short')).toBe(false);
    expect(tokenMatches('short', TOKEN)).toBe(false);
  });

  it('extracts a Bearer token and ignores other schemes', () => {
    expect(extractBearer('Bearer abc')).toBe('abc');
    expect(extractBearer('bearer   abc  ')).toBe('abc');
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('Bearer ')).toBeNull();
  });
});

describe('authentication', () => {
  it('rejects a missing token with 401 before touching the store', async () => {
    const store = fakeStore({ getError: new Error('store must not be consulted') });
    const res = await handleRequest(req({ headers: { 'content-type': 'application/octet-stream' } }), ctx(store));
    expect(res.status).toBe(401);
    expect(res.headers['WWW-Authenticate']).toBe('Bearer');
    expect(store.written).toHaveLength(0);
  });

  it('rejects a wrong token with 401', async () => {
    const store = fakeStore();
    const res = await handleRequest(
      req({ headers: { authorization: 'Bearer wrong-token-aaaaaaaaaaaaaaaa', 'content-type': 'application/octet-stream' } }),
      ctx(store),
    );
    expect(res.status).toBe(401);
    expect(store.written).toHaveLength(0);
  });

  it('rejects a non-Bearer scheme with 401', async () => {
    const store = fakeStore();
    const res = await handleRequest(
      req({ headers: { authorization: `Basic ${TOKEN}`, 'content-type': 'application/octet-stream' } }),
      ctx(store),
    );
    expect(res.status).toBe(401);
  });

  it('requires auth on GET too', async () => {
    const store = fakeStore({ newest: { seq: 1, bytes: BLOB, size: BLOB.length, sha256: 'x' } });
    const res = await handleRequest(req({ method: 'GET', headers: {}, body: null }), ctx(store));
    expect(res.status).toBe(401);
  });
});

describe('GET - the 404/500 rule that protects the unified API key', () => {
  it('returns 404 ONLY when nothing has ever been stored', async () => {
    const res = await handleRequest(req({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` }, body: null }), ctx(fakeStore()));
    expect(res.status).toBe(404);
  });

  it('returns the blob byte-for-byte with its checksum headers', async () => {
    const store = fakeStore({ newest: { seq: 7, bytes: BLOB, size: BLOB.length, sha256: 'a'.repeat(64) } });
    const res = await handleRequest(req({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` }, body: null }), ctx(store));
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/octet-stream');
    expect(res.headers['X-Backup-Seq']).toBe('7');
    expect(res.headers['X-Backup-Sha256']).toBe('a'.repeat(64));
    expect(res.body.equals(BLOB)).toBe(true);
  });

  it('turns a Mongo outage into 500, NEVER 404', async () => {
    // A 404 here would make the gateway boot empty and mint a new unified API
    // key, breaking every client. This is the single most important assertion
    // in the suite.
    const store = fakeStore({ getError: new StorageError('mongodb unavailable while reading the backup: timeout') });
    const res = await handleRequest(req({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` }, body: null }), ctx(store));
    expect(res.status).toBe(500);
    expect(asJson(res).ok).toBe(false);
  });

  it('turns an unexpected store error into 500, NEVER 404', async () => {
    const store = fakeStore({ getError: new Error('boom') });
    const res = await handleRequest(req({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` }, body: null }), ctx(store));
    expect(res.status).toBe(500);
  });
});

describe('PUT - validation', () => {
  it('accepts a well-formed blob and reports the written revision', async () => {
    const store = fakeStore();
    const res = await handleRequest(req(), ctx(store));
    expect(res.status).toBe(200);
    expect(asJson(res).ok).toBe(true);
    expect(store.written).toHaveLength(1);
    expect(store.written[0].bytes.equals(BLOB)).toBe(true);
  });

  it('rejects a non-octet-stream content type with 400', async () => {
    const store = fakeStore();
    const res = await handleRequest(
      req({ headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }),
      ctx(store),
    );
    expect(res.status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it('rejects an empty body with 400', async () => {
    const store = fakeStore();
    const res = await handleRequest(req({ body: Buffer.alloc(0) }), ctx(store));
    expect(res.status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it('rejects a payload over the size limit with 413', async () => {
    const store = fakeStore();
    const oversized = Buffer.concat([MAGIC, Buffer.alloc(CONFIG.maxBytes + 1)]);
    const res = await handleRequest(req({ body: oversized }), ctx(store));
    expect(res.status).toBe(413);
    expect(asJson(res).maxBytes).toBe(CONFIG.maxBytes);
    expect(store.written).toHaveLength(0);
  });

  it('accepts a payload exactly at the size limit', async () => {
    const store = fakeStore();
    const exact = Buffer.concat([MAGIC, Buffer.alloc(CONFIG.maxBytes - MAGIC.length)]);
    expect(exact.length).toBe(CONFIG.maxBytes);
    const res = await handleRequest(req({ body: exact }), ctx(store));
    expect(res.status).toBe(200);
  });

  it('refuses a payload without the FreeLLMAPI magic header', async () => {
    // Storing bytes that cannot decrypt would guarantee a failed restore
    // later, when it is much harder to notice.
    const store = fakeStore();
    const res = await handleRequest(req({ body: Buffer.from('SQLite format 3\0not a backup') }), ctx(store));
    expect(res.status).toBe(400);
    expect(store.written).toHaveLength(0);
  });

  it('honours requireMagic=false when a deployment disables it', async () => {
    const store = fakeStore();
    const config = { ...CONFIG, requireMagic: false };
    const res = await handleRequest(req({ body: Buffer.from('arbitrary-bytes') }), { store, config });
    expect(res.status).toBe(200);
  });

  it('reports a failed write as 500 with an explicit NOT-stored message', async () => {
    const store = fakeStore({ putError: new StorageError('backup revision 4 was NOT stored (write concern timeout)') });
    const res = await handleRequest(req(), ctx(store));
    expect(res.status).toBe(500);
    expect(asJson(res).error).toContain('NOT stored');
  });

  it('does not write anything when the store rejects', async () => {
    const store = fakeStore({ putError: new Error('disk full') });
    const res = await handleRequest(req(), ctx(store));
    expect(res.status).toBe(500);
    expect(store.written).toHaveLength(0);
  });
});

describe('routing', () => {
  it('answers 404 for an unknown path without consulting the store', async () => {
    const store = fakeStore({ getError: new Error('must not be consulted') });
    const res = await handleRequest(req({ path: '/some/other/path' }), ctx(store));
    expect(res.status).toBe(404);
    expect(store.written).toHaveLength(0);
  });

  it('ignores a query string when matching the backup path', async () => {
    const store = fakeStore({ newest: { seq: 1, bytes: BLOB, size: BLOB.length, sha256: 'x' } });
    const res = await handleRequest(
      req({ method: 'GET', path: '/backup.bin?cachebust=1', headers: { authorization: `Bearer ${TOKEN}` }, body: null }),
      ctx(store),
    );
    expect(res.status).toBe(200);
  });

  it('answers 405 with an Allow header for unsupported methods', async () => {
    const store = fakeStore();
    const res = await handleRequest(req({ method: 'DELETE' }), ctx(store));
    expect(res.status).toBe(405);
    expect(res.headers.Allow).toBe('GET, PUT');
    expect(store.written).toHaveLength(0);
  });

  it('rejects PATCH and HEAD on the backup path', async () => {
    for (const method of ['PATCH', 'HEAD', 'POST']) {
      const res = await handleRequest(req({ method }), ctx(fakeStore()));
      expect(res.status).toBe(405);
    }
  });
});
