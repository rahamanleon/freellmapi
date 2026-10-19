import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { getAppVersion, resetAppVersionCache } from '../../lib/app-version.js';

// #703: the dashboard had no way to show which release it is. The number users
// know the app by lives in desktop/package.json — server/package.json (0.2.x)
// and the OpenAPI spec (0.4.x) both track something else and would be wrong.

describe('app version resolution', () => {
  const saved = process.env.FREEAPI_VERSION;

  beforeEach(() => {
    resetAppVersionCache();
    delete process.env.FREEAPI_VERSION;
  });

  afterEach(() => {
    resetAppVersionCache();
    if (saved === undefined) delete process.env.FREEAPI_VERSION;
    else process.env.FREEAPI_VERSION = saved;
  });

  it('prefers FREEAPI_VERSION — the desktop shell states its own version', () => {
    process.env.FREEAPI_VERSION = '9.9.9';
    expect(getAppVersion()).toBe('9.9.9');
  });

  it('ignores a blank FREEAPI_VERSION rather than reporting an empty version', () => {
    process.env.FREEAPI_VERSION = '   ';
    // Falls through to the manifest, which exists in a source checkout.
    expect(getAppVersion()).not.toBe('');
    expect(getAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('falls back to the release manifest, and never to the server workspace version', async () => {
    const version = getAppVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    const desktopPkg = JSON.parse(
      await import('node:fs/promises').then(fs =>
        fs.readFile(new URL('../../../../desktop/package.json', import.meta.url), 'utf8')),
    ) as { version: string };
    expect(version).toBe(desktopPkg.version);

    const serverPkg = JSON.parse(
      await import('node:fs/promises').then(fs =>
        fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8')),
    ) as { version: string };
    // Guards the whole point of this resolver: if these ever coincide the test
    // still passes, but it fails loudly if someone repoints it at the server's.
    if (serverPkg.version !== desktopPkg.version) {
      expect(version).not.toBe(serverPkg.version);
    }
  });

  it('caches, so the resolver is not re-reading a manifest on every request', () => {
    const first = getAppVersion();
    process.env.FREEAPI_VERSION = 'ignored-because-cached';
    expect(getAppVersion()).toBe(first);
  });
});

describe('GET /api/settings/version', () => {
  let app: Express;
  let token = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  async function get(headers: Record<string, string>) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/settings/version`, { headers });
    const body = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body };
  }

  it('serves the version to a signed-in dashboard', async () => {
    const { status, body } = await get({ Authorization: `Bearer ${token}` });
    expect(status).toBe(200);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('requires auth — a build number is not for anonymous callers', async () => {
    const { status } = await get({});
    expect(status).toBe(401);
  });

  it('does not collide with the Ollama emulation, which already owns /api/version', async () => {
    // The obvious path for this endpoint was /api/version — but ollamaRouter is
    // mounted first and serves it to real Ollama clients, which gate features on
    // its value. Mounting there would have shadowed it and produced a dead route
    // besides. This asserts /api/version is still ANSWERED BY OLLAMA: with the
    // emulation off (the default) that is its own 404, never a version payload.
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/version`);
    const body = await res.json();
    server.close();
    expect(res.status).toBe(404);
    expect(body.error).toMatch(/Ollama emulation is disabled/);
    expect(body.version).toBeUndefined();
    expect(body.version).not.toBe(getAppVersion());
  });
});
