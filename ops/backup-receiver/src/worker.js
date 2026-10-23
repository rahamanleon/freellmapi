// Cloudflare Workers entry point (the production target).
//
// Free plan limits that shaped this file, from developers.cloudflare.com
// (verified 2026-10): 100,000 requests/day, 10 ms CPU time per invocation,
// 128 MB memory, 100 MB request body on the Free account plan. Our load is
// one PUT per 15 min (96/day) plus rare restore GETs, so requests are a
// rounding error; the binding constraint is CPU time.
//
// The MongoDB Node driver works on Workers, but only with the Node
// compatibility flag and a compatibility date that includes node:net +
// node:tls (landed Jan 2025, cf/workerd#3340 + #3594). See wrangler.toml.
//
// Connection handling: a module-scope MongoClient is reused across invocations
// that land on the same isolate. Workers are ephemeral and a cold invocation
// pays the full TLS + SCRAM handshake, which is the main risk against the
// 10 ms CPU budget. If measurement (see ops/scripts/verify-backup-receiver.mjs)
// shows the handshake blowing the budget, the documented fix is to move the
// client into a Durable Object so the pool survives across isolates - that is
// a contained change to this file only, not to core.js or storage.js.

import { MongoClient } from 'mongodb';
import { loadConfig } from './config.js';
import { BackupStore } from './storage.js';
import { handleRequest } from './core.js';

// Per-isolate cache. Keyed by nothing: a Worker isolate only ever sees one
// binding set, and a redeploy creates a fresh isolate anyway.
let cached = null;

async function getStore(env) {
  const config = loadConfig(env);
  if (cached && cached.config === config) return cached;

  const client = new MongoClient(config.uri, {
    // Small pool: traffic is a PUT every 15 minutes plus occasional restores.
    maxPoolSize: 2,
    minPoolSize: 0,
    serverSelectionTimeoutMS: config.connectTimeoutMs,
  });

  const store = new BackupStore(client, config);
  // Index creation is idempotent but costs a round trip; do it once per
  // isolate rather than per request.
  await store.ensureIndexes();

  cached = { config, store };
  return cached;
}

function readBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') ?? '');
  // Refuse before reading when the client declared an oversized body.
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };

  const reader = request.body?.getReader?.();
  if (!reader) return { body: null };

  const chunks = [];
  let total = 0;
  return (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be errored; nothing useful to do.
        }
        return { tooLarge: true };
      }
      chunks.push(Buffer.from(value));
    }
    return { body: Buffer.concat(chunks) };
  })();
}

export default {
  async fetch(request, env) {
    let config;
    let store;
    try {
      ({ config, store } = await getStore(env));
    } catch (err) {
      // Misconfiguration (missing MONGODB_URI / BACKUP_TOKEN) must never look
      // like "no backup stored" - the gateway would re-key itself.
      return Response.json(
        { ok: false, error: 'receiver is misconfigured', detail: String(err?.message ?? err).slice(0, 300) },
        { status: 500 },
      );
    }

    const url = new URL(request.url);
    let body = null;

    if (request.method === 'PUT') {
      const read = await readBody(request, config.maxBytes);
      if (read.tooLarge) {
        return Response.json(
          { ok: false, error: `request body exceeds the ${config.maxBytes} byte limit` },
          { status: 413 },
        );
      }
      body = read.body;
    }

    const result = await handleRequest(
      {
        method: request.method,
        path: url.pathname,
        headers: {
          authorization: request.headers.get('authorization'),
          'content-type': request.headers.get('content-type'),
        },
        body,
      },
      { store, config },
    );

    return new Response(result.body, { status: result.status, headers: result.headers });
  },
};
