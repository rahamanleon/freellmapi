import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const validateKey = vi.fn();
vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    resolveProvider: () => ({ name: 'fake', validateKey }),
  };
});

const { initDb, getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { checkKeyHealth, checkAllKeys, markKeyHealthyFromRequest } = await import('../../services/health.js');

/**
 * selectKeyForModel only accepts keys with status IN ('healthy','unknown'), so
 * writing status='error' removes a key's capacity entirely. A transport error
 * (DNS, TLS, timeout, suspended laptop) says nothing about the credential, so it
 * must not demote — otherwise one blip benches every key on a provider at once.
 */
describe('transport errors do not demote a key', () => {
  let nextId = 7000;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    validateKey.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function seedKey(status: string): number {
    const id = ++nextId;
    const enc = encrypt(`health-preserve-${id}`);
    getDb().prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status)
      VALUES (?, 'mistral', ?, ?, ?, ?, 1, ?)
    `).run(id, `preserve-${id}`, enc.encrypted, enc.iv, enc.authTag, status);
    return id;
  }

  function statusOf(id: number): string {
    return (getDb().prepare('SELECT status FROM api_keys WHERE id = ?').get(id) as { status: string }).status;
  }

  it('keeps a healthy key healthy through a transport failure', async () => {
    const id = seedKey('healthy');
    validateKey.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.mistral.ai'));

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(statusOf(id)).toBe('healthy');
  });

  it('records the diagnostic and timestamp even though status is unchanged', async () => {
    const id = seedKey('healthy');
    validateKey.mockRejectedValue(new Error('socket hang up'));

    await checkKeyHealth(id);
    const row = getDb().prepare(
      'SELECT last_health_error, last_checked_at FROM api_keys WHERE id = ?',
    ).get(id) as { last_health_error: string; last_checked_at: string | null };

    expect(row.last_health_error).toContain('socket hang up');
    expect(row.last_checked_at).not.toBeNull();
  });

  it('still demotes on a confirmed bad credential', async () => {
    const id = seedKey('healthy');
    validateKey.mockResolvedValue({ valid: false, error: 'HTTP 401 invalid key' });

    expect(await checkKeyHealth(id)).toBe('invalid');
    expect(statusOf(id)).toBe('invalid');
  });

  it('an offline burst leaves every key routable', async () => {
    const ids = [seedKey('healthy'), seedKey('healthy'), seedKey('unknown')];
    validateKey.mockRejectedValue(new Error('fetch failed'));

    await checkAllKeys();

    // Previously all three would have gone to 'error' and the router would have
    // had zero usable keys until a later pass succeeded.
    expect(ids.map(statusOf)).toEqual(['healthy', 'healthy', 'unknown']);
  });
});

describe('markKeyHealthyFromRequest', () => {
  let nextId = 8000;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function seedKey(status: string): number {
    const id = ++nextId;
    const enc = encrypt(`heal-${id}`);
    getDb().prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, last_health_error)
      VALUES (?, 'groq', ?, ?, ?, ?, 1, ?, 'stale reason')
    `).run(id, `heal-${id}`, enc.encrypted, enc.iv, enc.authTag, status);
    return id;
  }

  function row(id: number): { status: string; last_health_error: string | null } {
    return getDb().prepare('SELECT status, last_health_error FROM api_keys WHERE id = ?').get(id) as any;
  }

  it("promotes an 'error' key back to healthy and clears the stale reason", () => {
    const id = seedKey('error');
    markKeyHealthyFromRequest(id);
    expect(row(id)).toEqual({ status: 'healthy', last_health_error: null });
  });

  it("promotes a never-probed 'unknown' key to healthy (#1459)", () => {
    const id = seedKey('unknown');
    markKeyHealthyFromRequest(id);
    expect(row(id)).toEqual({ status: 'healthy', last_health_error: null });
  });

  it("never resurrects an 'invalid' key — only a real probe clears that", () => {
    const id = seedKey('invalid');
    markKeyHealthyFromRequest(id);
    expect(row(id).status).toBe('invalid');
  });

  it('leaves an already-healthy key untouched', () => {
    const id = seedKey('healthy');
    markKeyHealthyFromRequest(id);
    expect(row(id).status).toBe('healthy');
  });

  it('is silent for an unknown key id', () => {
    expect(() => markKeyHealthyFromRequest(999_999)).not.toThrow();
  });
});
