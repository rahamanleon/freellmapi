// Hot-path hygiene for the limiter's two record paths: the usage-table
// retention sweep must not run on every insert, and the in-memory windows must
// not accumulate rows nothing reads.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  canMakeRequest,
  canUseTokens,
  recordRequest,
  recordTokens,
  setCooldown,
  isOnCooldown,
  cleanupExpiredCooldowns,
} from '../../services/ratelimit.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Insert a usage row at an explicit timestamp, bypassing recordRequest so the
 *  test controls how far in the past the row sits. */
function seedUsage(platform: string, modelId: string, keyId: number, atMs: number) {
  getDb().prepare(`
    INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
    VALUES (?, ?, ?, 'request', 0, ?)
  `).run(platform, modelId, keyId, atMs);
}

function usageRowsAt(atMs: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM rate_limit_usage WHERE created_at_ms = ?')
    .get(atMs) as { n: number };
  return row.n;
}

function cooldownRowCount(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns')
    .get() as { n: number };
  return row.n;
}

describe('rate_limit_usage retention sweep is throttled', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prunes at most once a minute instead of on every insert', () => {
    // The prune predicate (created_at_ms <= ?) cannot use the composite lookup
    // index, so it is a full table scan; running it per insert put that scan on
    // the request path. Rows outliving their DAY window by up to a minute are
    // harmless — every counter query filters on created_at_ms itself.
    vi.useFakeTimers();
    const t0 = Date.UTC(2026, 3, 1, 12, 0, 0);
    vi.setSystemTime(t0);
    initDb(':memory:');

    const keyId = Math.floor(Math.random() * 1_000_000);
    const model = `prune-${keyId}`;

    // First insert of the minute sweeps, establishing a known baseline.
    const firstStale = t0 - 2 * DAY;
    seedUsage('groq', model, keyId, firstStale);
    recordRequest('groq', model, keyId);
    expect(usageRowsAt(firstStale)).toBe(0);

    // Second insert lands inside the same throttle window: the expired row it
    // would otherwise have collected is still there.
    const secondStale = t0 - 3 * DAY;
    seedUsage('groq', model, keyId, secondStale);
    vi.setSystemTime(t0 + 30 * 1000);
    recordRequest('groq', model, keyId);
    expect(usageRowsAt(secondStale)).toBe(1);

    // Past the interval, the sweep runs again and clears the backlog.
    vi.setSystemTime(t0 + 61 * 1000);
    recordRequest('groq', model, keyId);
    expect(usageRowsAt(secondStale)).toBe(0);
  });

  it('sweeps again after the clock steps backwards', () => {
    // An NTP correction or a resumed host can move Date.now() back; a plain
    // "now - last >= interval" test would wedge the sweep off until real time
    // caught up with the pre-jump timestamp.
    vi.useFakeTimers();
    const t0 = Date.UTC(2026, 5, 1, 12, 0, 0);
    vi.setSystemTime(t0);
    initDb(':memory:');

    const keyId = Math.floor(Math.random() * 1_000_000);
    const model = `rewind-${keyId}`;
    recordRequest('groq', model, keyId); // baseline sweep at t0

    vi.setSystemTime(t0 - 10 * MINUTE);
    const stale = t0 - 10 * MINUTE - 2 * DAY;
    seedUsage('groq', model, keyId, stale);
    recordRequest('groq', model, keyId);
    expect(usageRowsAt(stale)).toBe(0);
  });
});

describe('in-memory windows stay bounded', () => {
  let keyId: number;
  let model: string;

  beforeEach(() => {
    initDb(':memory:');
    keyId = Math.floor(Math.random() * 1_000_000);
    model = `mem-${keyId}`;
  });

  it('records nothing in memory while the DB is answering', () => {
    const limits = { rpm: 5, rpd: null, tpm: null, tpd: null };
    for (let i = 0; i < 5; i++) recordRequest('groq', model, keyId);
    // Persisted counters see all five.
    expect(canMakeRequest('groq', model, keyId, limits)).toBe(false);

    // Drop the DB and the limiter falls back to its in-memory windows. Those
    // are the degraded-mode store only: because nothing was mirrored into them
    // while the DB was healthy, they start clean rather than holding five
    // timestamps that no read path would ever have pruned.
    getDb().close();
    expect(canMakeRequest('groq', model, keyId, limits)).toBe(true);
  });

  it('records nothing in memory for tokens while the DB is answering', () => {
    const limits = { tpm: 1000, tpd: null };
    recordTokens('groq', model, keyId, 900);
    expect(canUseTokens('groq', model, keyId, 200, limits)).toBe(false);

    getDb().close();
    expect(canUseTokens('groq', model, keyId, 200, limits)).toBe(true);
  });

  it('still counts requests in memory while the DB is unavailable', () => {
    getDb().close();
    const limits = { rpm: 3, rpd: null, tpm: null, tpd: null };
    recordRequest('groq', model, keyId);
    recordRequest('groq', model, keyId);
    expect(canMakeRequest('groq', model, keyId, limits)).toBe(true);
    recordRequest('groq', model, keyId);
    expect(canMakeRequest('groq', model, keyId, limits)).toBe(false);
  });

  it('still counts tokens in memory while the DB is unavailable', () => {
    getDb().close();
    const limits = { tpm: 1000, tpd: null };
    recordTokens('groq', model, keyId, 900);
    expect(canUseTokens('groq', model, keyId, 200, limits)).toBe(false);
    expect(canUseTokens('groq', model, keyId, 50, limits)).toBe(true);
  });

  it('drops timestamps that fell out of the window when the next one arrives', () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.UTC(2026, 7, 1, 9, 0, 0);
      vi.setSystemTime(t0);
      getDb().close();

      const limits = { rpm: 2, rpd: null, tpm: null, tpd: null };
      recordRequest('groq', model, keyId);
      recordRequest('groq', model, keyId);
      expect(canMakeRequest('groq', model, keyId, limits)).toBe(false);

      // Two minutes on, the earlier pair is outside the rpm window, so the
      // window holds one timestamp again rather than growing to three.
      vi.setSystemTime(t0 + 2 * MINUTE);
      recordRequest('groq', model, keyId);
      expect(canMakeRequest('groq', model, keyId, limits)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cleanupExpiredCooldowns', () => {
  let keyId: number;

  beforeEach(() => {
    initDb(':memory:');
    keyId = Math.floor(Math.random() * 1_000_000);
  });

  it('removes expired rows and reports how many went', () => {
    // Cooldown expiry is otherwise collected only by isOnCooldown, and only for
    // the exact route asked about — rows for a retired model or a deleted key
    // are never asked about again, so they sit in the table forever.
    setCooldown('groq', 'expired-a', keyId, -1000);
    setCooldown('groq', 'expired-b', keyId, -5 * MINUTE);
    expect(cooldownRowCount()).toBe(2);

    expect(cleanupExpiredCooldowns()).toBe(2);
    expect(cooldownRowCount()).toBe(0);
  });

  it('leaves an active bench alone', () => {
    setCooldown('groq', 'still-benched', keyId, 10 * MINUTE);
    setCooldown('groq', 'expired', keyId, -1000);

    expect(cleanupExpiredCooldowns()).toBe(1);
    expect(isOnCooldown('groq', 'still-benched', keyId)).toBe(true);
    expect(isOnCooldown('groq', 'expired', keyId)).toBe(false);
  });

  it('clears the in-memory expiry too, not just the row', () => {
    setCooldown('groq', 'mem-expired', keyId, -1000);
    cleanupExpiredCooldowns();
    // With the DB gone the in-memory map is authoritative; the sweep must have
    // emptied it as well or the route stays benched for the whole process.
    getDb().close();
    expect(isOnCooldown('groq', 'mem-expired', keyId)).toBe(false);
  });

  it('is a no-op on an empty table', () => {
    expect(cleanupExpiredCooldowns()).toBe(0);
  });
});
