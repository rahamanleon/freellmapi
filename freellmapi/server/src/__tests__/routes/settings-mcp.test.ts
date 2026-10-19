import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getSetting, getUnifiedApiKey } from '../../db/index.js';
import { up as seedMcpDefault } from '../../db/migrations/20260903_000001_mcp_enabled_default.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function request(app: Express, method: string, path: string, body: any, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

describe('/api/settings/enable-mcp', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('reports false on a fresh install', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/enable-mcp', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: false });
  });

  it('stores and returns the configured enabled flag', async () => {
    const put = await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: true }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ enabled: true });
    expect(getSetting('enable_mcp')).toBe('1');

    const get = await request(app, 'GET', '/api/settings/enable-mcp', undefined, token);
    expect(get.body).toEqual(put.body);
  });

  it('accepts false to disable', async () => {
    await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: true }, token);
    const put = await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: false }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ enabled: false });
    expect(getSetting('enable_mcp')).toBe('0');
  });

  const rejected: Array<[string, any]> = [
    ['non-boolean enabled', { enabled: 'yes' }],
    ['null enabled', { enabled: null }],
  ];

  for (const [label, payload] of rejected) {
    it(`rejects ${label} with a 400`, async () => {
      const { status, body } = await request(app, 'PUT', '/api/settings/enable-mcp', payload, token);
      expect(status).toBe(400);
      expect(body.error.type).toBe('invalid_request_error');
    });
  }
});

describe('/mcp lifecycle gate (#925)', () => {
  let app: Express;
  let token: string;
  let unifiedKey: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
    unifiedKey = getUnifiedApiKey();
  });

  it('off by default: POST /mcp answers 403 without touching auth', async () => {
    const { status, body } = await request(app, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, unifiedKey);
    expect(status).toBe(403);
    expect(body.error.code).toBe(-32000);
    expect(body.id).toBe(1);
  });

  // A disabled server must not answer "405, POST instead" on the other verbs:
  // that reads as "the server is here, you are holding it wrong".
  it('off by default: GET and DELETE /mcp answer 403 too', async () => {
    const get = await request(app, 'GET', '/mcp', undefined, unifiedKey);
    expect(get.status).toBe(403);
    expect(get.body.error.code).toBe(-32000);

    const del = await request(app, 'DELETE', '/mcp', undefined, unifiedKey);
    expect(del.status).toBe(403);
    expect(del.body.error.code).toBe(-32000);
  });

  it('serves JSON-RPC once enabled, rejects wrong keys, and takes the toggle down immediately', async () => {
    const put = await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: true }, token);
    expect(put.status).toBe(200);

    const ok = await request(app, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, unifiedKey);
    expect(ok.status).toBe(200);
    expect(ok.body.result).toBeDefined();

    // Enabled, stateless: the other verbs are back to their 405 explanation.
    const get = await request(app, 'GET', '/mcp', undefined, unifiedKey);
    expect(get.status).toBe(405);

    const bad = await request(app, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'ping' }, 'freellmapi-not-the-key');
    expect(bad.status).toBe(401);

    await request(app, 'PUT', '/api/settings/enable-mcp', { enabled: false }, token);
    const off = await request(app, 'POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'ping' }, unifiedKey);
    expect(off.status).toBe(403);
  });
});

// The stored default is what decides whether an upgrade is a silent breakage.
describe('enable_mcp default seed (#925)', () => {
  function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL);
    `);
    return db;
  }

  function stored(db: Database.Database): string | undefined {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'enable_mcp'").get() as { value: string } | undefined;
    return row?.value;
  }

  it('starts off on a fresh install (no provider keys yet)', () => {
    const db = makeDb();
    seedMcpDefault(db as any);
    expect(stored(db)).toBe('0');
    db.close();
  });

  it('stays on for an install that already had provider keys', () => {
    const db = makeDb();
    db.prepare("INSERT INTO api_keys (platform) VALUES ('groq')").run();
    seedMcpDefault(db as any);
    expect(stored(db)).toBe('1');
    db.close();
  });

  it('never overwrites a value the operator already chose', () => {
    const db = makeDb();
    db.prepare("INSERT INTO api_keys (platform) VALUES ('groq')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('enable_mcp', '0')").run();
    seedMcpDefault(db as any);
    expect(stored(db)).toBe('0');
    db.close();
  });
});
