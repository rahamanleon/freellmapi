import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

// #687, second half. #717 taught POST /api/keys/import about custom endpoints,
// but the dashboard never calls that route — the Add-key dialog does
// /preview then /import-selected, and /import-selected rejected every custom
// row outright. So a custom endpoint still could not be restored from its own
// export file through the UI. These cover the route the dashboard actually uses.

let dashToken = '';

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashToken}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json as any };
}

async function previewFile(app: Express, filename: string, content: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const form = new FormData();
  form.append('files', new Blob([content], { type: 'text/plain' }), filename);
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dashToken}` },
    body: form,
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json as any };
}

function customRows() {
  return getDb()
    .prepare("SELECT id, platform, label, base_url FROM api_keys WHERE platform = 'custom' ORDER BY id")
    .all() as Array<{ id: number; platform: string; label: string; base_url: string | null }>;
}

describe('POST /api/keys/import-selected — custom endpoints (#687)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('restores a custom endpoint when the row carries its base URL', async () => {
    const { status, body } = await post(app, '/api/keys/import-selected', {
      keys: [{
        keyName: 'My Relay',
        keyValue: 'sk-relay-123',
        platform: 'custom',
        baseUrl: 'https://relay.example.com/v1',
      }],
    });

    expect(status).toBe(200);
    expect(body.imported).toBe(1);
    expect(body.errors).toEqual([]);
    expect(customRows()).toEqual([
      expect.objectContaining({ platform: 'custom', base_url: 'https://relay.example.com/v1' }),
    ]);
  });

  it('still refuses a custom row with no base URL — there is nowhere to route it', async () => {
    const { status, body } = await post(app, '/api/keys/import-selected', {
      keys: [{ keyName: 'My Relay', keyValue: 'sk-relay-123', platform: 'custom' }],
    });

    expect(status).toBe(200);
    expect(body.imported).toBe(0);
    expect(body.errors[0].error).toContain('base URL');
    expect(customRows()).toHaveLength(0);
  });

  it('applies the SSRF guard the manual add path uses (#440)', async () => {
    const { status, body } = await post(app, '/api/keys/import-selected', {
      keys: [{
        keyName: 'metadata',
        keyValue: 'sk-x',
        platform: 'custom',
        baseUrl: 'http://169.254.169.254/latest/meta-data',
      }],
    });

    expect(status).toBe(200);
    expect(body.imported).toBe(0);
    expect(body.errors[0].error).toContain('baseUrl rejected');
    expect(customRows()).toHaveLength(0);
  });

  it('keeps auth-less local servers on the no-key sentinel', async () => {
    const { body } = await post(app, '/api/keys/import-selected', {
      keys: [{
        keyName: 'Local Ollama',
        keyValue: 'no-key',
        platform: 'custom',
        baseUrl: 'http://192.168.1.10:11434/v1',
      }],
    });

    expect(body.imported).toBe(1);
    expect(customRows()).toHaveLength(1);
  });

  it('pools re-imports of the same endpoint instead of duplicating the row (#619)', async () => {
    const row = {
      keyName: 'My Relay',
      keyValue: 'sk-relay-123',
      platform: 'custom',
      baseUrl: 'https://relay.example.com/v1',
    };
    await post(app, '/api/keys/import-selected', { keys: [row] });
    await post(app, '/api/keys/import-selected', { keys: [row] });

    // Importing the same backup twice is an ordinary thing to do; it must not
    // leave two rows pointing at one endpoint.
    expect(customRows()).toHaveLength(1);
  });

  it('carries baseUrl from /preview so the dialog can pass it back', async () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('sk-relay-123');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
      VALUES ('custom', 'My Relay', ?, ?, ?, 'unknown', 1, ?)
    `).run(encrypted, iv, authTag, 'https://relay.example.com/v1');

    const exportFile = JSON.stringify({
      version: 1,
      exportedAt: '2026-08-02T00:00:00Z',
      source: 'freellmapi',
      keys: [{ platform: 'custom', key: 'sk-relay-123', label: 'My Relay', baseUrl: 'https://relay.example.com/v1' }],
    });

    const { status, body } = await previewFile(app, 'freellmapi-keys.json', exportFile);
    expect(status).toBe(200);
    const custom = body.keys.find((k: any) => k.detectedPlatform === 'custom');
    expect(custom).toBeTruthy();
    expect(custom.baseUrl).toBe('https://relay.example.com/v1');
  });
});
