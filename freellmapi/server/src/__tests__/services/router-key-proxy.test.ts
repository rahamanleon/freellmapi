import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { encryptProxyUrl } from '../../lib/key-proxy.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';

// Per-key proxy override (#590): the URL rides on the RouteResult the router
// already builds, so the dispatch loop needs neither a query nor a decrypt per
// attempt. These pin that contract — the loop reads route.proxyUrl and nothing
// else.
describe('Router — per-key proxy override (#590)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    setRoutingStrategy('priority');
    db.prepare('DELETE FROM api_keys').run();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function insertKey(proxyColumns: { encrypted: string | null; iv: string | null; authTag: string | null }): number {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('sk-google-1');
    const result = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, proxy_encrypted, proxy_iv, proxy_auth_tag)
      VALUES ('google', 'test', ?, ?, ?, 'healthy', 1, ?, ?, ?)
    `).run(encrypted, iv, authTag, proxyColumns.encrypted, proxyColumns.iv, proxyColumns.authTag);
    return Number(result.lastInsertRowid);
  }

  it('carries the decrypted proxy URL on the route', () => {
    insertKey(encryptProxyUrl('socks5h://alice:hunter2@proxy.internal:1080'));
    const route = routeRequest();
    expect(route.platform).toBe('google');
    expect(route.proxyUrl).toBe('socks5h://alice:hunter2@proxy.internal:1080');
  });

  it("carries '' for a key with no override", () => {
    insertKey({ encrypted: null, iv: null, authTag: null });
    expect(routeRequest().proxyUrl).toBe('');
  });

  it('falls back to the global proxy when the override cannot be decrypted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Ciphertext from a different ENCRYPTION_KEY: the key itself still works,
    // so the request must proceed on the global proxy rather than fail.
    insertKey({ encrypted: 'deadbeef', iv: '00'.repeat(16), authTag: '11'.repeat(16) });
    const route = routeRequest();
    expect(route.apiKey).toBe('sk-google-1');
    expect(route.proxyUrl).toBe('');
    expect(warn).toHaveBeenCalled();
  });
});
