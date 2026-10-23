// Node entry point.
//
// Used for local verification and for any host that runs plain Node. The
// Cloudflare Worker entry (worker.js) is the production target; both share
// core.js, so the protocol logic proven here is the protocol logic that runs
// in production.
//
//   MONGODB_URI='mongodb+srv://...' BACKUP_TOKEN='...' node src/node.js

import http from 'node:http';
import { MongoClient } from 'mongodb';
import { loadConfig, ConfigError } from './config.js';
import { BackupStore, StorageError } from './storage.js';
import { handleRequest } from './core.js';

// Read a request body with a hard ceiling. Streams rather than buffering the
// whole thing first, so a hostile client cannot make us allocate more than
// maxBytes + a chunk before being refused.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        // Drain and destroy: leaving the socket mid-body without a response
        // would look like a network fault rather than a 413.
        req.destroy();
        const err = new Error(`request body exceeded ${maxBytes} bytes`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function headerValue(headers, name) {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export async function startServer({ config, store, port = Number(process.env.PORT || 8787), host = '127.0.0.1' } = {}) {
  const cfg = config ?? loadConfig();
  const client = new MongoClient(cfg.uri, {
    // Keep the pool tiny: traffic is one PUT every 15 minutes plus rare GETs.
    maxPoolSize: 4,
    minPoolSize: 0,
    serverSelectionTimeoutMS: cfg.connectTimeoutMs,
  });
  const bk = store ?? new BackupStore(client, cfg);
  await bk.ensureIndexes();

  const log = (fields) => {
    // One structured line per request. Never the token, never the URI, never
    // the payload - only sizes, statuses and timings.
    console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'backup-receiver', ...fields }));
  };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let status = 500;
    try {
      let body = null;
      if (req.method === 'PUT') {
        try {
          body = await readBody(req, cfg.maxBytes);
        } catch (err) {
          status = err.statusCode ?? 400;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'could not read request body', detail: String(err.message).slice(0, 200) }));
          log({ method: req.method, path: req.url, status, ms: Date.now() - started });
          return;
        }
      }

      const result = await handleRequest(
        {
          method: req.method,
          path: req.url,
          headers: {
            authorization: headerValue(req.headers, 'authorization'),
            'content-type': headerValue(req.headers, 'content-type'),
          },
          body,
        },
        { store: bk, config: cfg },
      );
      status = result.status;
      res.writeHead(status, result.headers);
      res.end(result.body);
    } catch (err) {
      status = 500;
      const message = err instanceof StorageError ? err.message : 'internal error';
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error', detail: String(message).slice(0, 200) }));
    } finally {
      log({ method: req.method, path: req.url, status, ms: Date.now() - started });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  log({ event: 'listening', port: addr.port, path: cfg.path, db: cfg.dbName, collection: cfg.collection, retention: cfg.retention });

  return {
    server,
    store: bk,
    port: addr.port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await bk.close();
    },
  };
}

// Standalone bootstrap.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('node.js')) {
  try {
    const cfg = loadConfig();
    const app = await startServer({ config: cfg });
    const shutdown = async (signal) => {
      console.error(`[backup-receiver] ${signal} received, closing`);
      await app.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[backup-receiver] ${err.message}`);
      process.exit(78); // EX_CONFIG
    }
    console.error(`[backup-receiver] failed to start: ${err?.message ?? err}`);
    process.exit(1);
  }
}
