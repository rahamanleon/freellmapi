import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

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
const {
  checkKeyHealth,
  markKeyHealthyFromRequest,
  clearTransportFailureState,
  SUGGESTED_TRANSPORT_PARK_AFTER: CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK,
} = await import('../../services/health.js');

const ORIGINAL_PARK_AFTER = process.env.HEALTH_TRANSPORT_PARK_AFTER;

/**
 * #1510: transport errors (DNS/timeout/TLS) never accumulated, so a key whose
 * provider has been unreachable for days kept status='healthy' and stayed a
 * first-class routing candidate — a real install logged 264 failures vs 8
 * successes in a day with zero keys ever showing 'error'. The fix counts
 * consecutive transport errors per key and parks the key at 'error' once the
 * streak passes the threshold. 'error' is deliberately NOT auto-disable: the
 * key is re-probed every pass and self-heals on a valid probe or a served
 * request.
 */
describe('transport-error parking (#1510)', () => {
  let nextId = 9000;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterAll(() => {
    if (ORIGINAL_PARK_AFTER === undefined) delete process.env.HEALTH_TRANSPORT_PARK_AFTER;
    else process.env.HEALTH_TRANSPORT_PARK_AFTER = ORIGINAL_PARK_AFTER;
  });

  beforeEach(() => {
    process.env.HEALTH_TRANSPORT_PARK_AFTER = String(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK);
    validateKey.mockReset();
    clearTransportFailureState();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function seedKey(status: string): number {
    const id = ++nextId;
    const enc = encrypt(`park-${id}`);
    getDb().prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status)
      VALUES (?, 'mistral', ?, ?, ?, ?, 1, ?)
    `).run(id, `park-${id}`, enc.encrypted, enc.iv, enc.authTag, status);
    return id;
  }

  function statusOf(id: number): string {
    return (getDb().prepare('SELECT status FROM api_keys WHERE id = ?').get(id) as { status: string }).status;
  }

  async function failTransport(times: number, id: number): Promise<void> {
    validateKey.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.mistral.ai'));
    for (let i = 0; i < times; i++) await checkKeyHealth(id);
  }

  it('parking is off by default: a long unreachable streak keeps the key in rotation', async () => {
    delete process.env.HEALTH_TRANSPORT_PARK_AFTER;
    const id = seedKey('healthy');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK * 3, id);
    expect(statusOf(id)).toBe('healthy');
  });

  it('HEALTH_TRANSPORT_PARK_AFTER=0 also keeps parking off', async () => {
    process.env.HEALTH_TRANSPORT_PARK_AFTER = '0';
    const id = seedKey('healthy');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK * 3, id);
    expect(statusOf(id)).toBe('healthy');
  });

  it('a short unreachable streak never parks the key', async () => {
    const id = seedKey('healthy');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK - 1, id);
    expect(statusOf(id)).toBe('healthy');
  });

  it('a sustained unreachable streak parks the key at error', async () => {
    const id = seedKey('healthy');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK, id);
    expect(statusOf(id)).toBe('error');
  });

  it('the parking probe itself reports error', async () => {
    const id = seedKey('healthy');
    validateKey.mockRejectedValue(new Error('connect ECONNREFUSED'));
    for (let i = 1; i < CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK; i++) {
      expect(await checkKeyHealth(id)).toBe('healthy');
    }
    expect(await checkKeyHealth(id)).toBe('error');
  });

  it('a valid probe in the middle resets the streak', async () => {
    const id = seedKey('healthy');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK - 1, id);
    validateKey.mockResolvedValue(true);
    expect(await checkKeyHealth(id)).toBe('healthy');
    // A full fresh streak is needed from here on.
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK - 1, id);
    expect(statusOf(id)).toBe('healthy');
  });

  it('a 429 counts as reachability, not another transport failure', async () => {
    const id = seedKey('healthy');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK - 1, id);
    const err = Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    validateKey.mockRejectedValue(err);
    expect(await checkKeyHealth(id)).toBe('healthy');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK - 1, id);
    expect(statusOf(id)).toBe('healthy');
  });

  it('a parked key heals on the next valid probe', async () => {
    const id = seedKey('healthy');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK, id);
    expect(statusOf(id)).toBe('error');
    validateKey.mockResolvedValue(true);
    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(statusOf(id)).toBe('healthy');
  });

  it('a parked key heals when it serves a live request', async () => {
    const id = seedKey('healthy');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK, id);
    expect(statusOf(id)).toBe('error');
    markKeyHealthyFromRequest(id);
    expect(statusOf(id)).toBe('healthy');
  });

  it('parking never overwrites a confirmed-invalid verdict', async () => {
    const id = seedKey('invalid');
    await failTransport(CONSECUTIVE_TRANSPORT_ERRORS_TO_PARK, id);
    expect(statusOf(id)).toBe('invalid');
  });
});
