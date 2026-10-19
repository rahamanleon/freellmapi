import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Scheduler } from '../../lib/scheduler.js';

const { initDb, getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const {
  checkAllKeys,
  nextHealthCheckDelayMs,
  startHealthChecker,
  stopHealthChecker,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_PASS_TIME_BUDGET_MS,
  RECENT_CHECK_SKIP_MS,
} = await import('../../services/health.js');

// #553: every enabled key was probed in raw DB order behind a concurrency-8
// pool every 5 minutes with no spacing, so a fleet with many keys on one
// provider fired them all back to back from one IP — which reads as abuse to
// the provider. The pass now interleaves providers, spaces same-provider
// probes, skips keys validated recently, and jitters its own interval.

let nextId = 20000;

function seedKey(platform: string, opts: { lastCheckedAt?: string; status?: string } = {}): number {
  const id = ++nextId;
  const enc = encrypt(`pacing-${id}`);
  getDb().prepare(`
    INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, platform, `pacing-${id}`, enc.encrypted, enc.iv, enc.authTag, opts.status ?? 'healthy', opts.lastCheckedAt ?? null);
  return id;
}

/** Fake clock driven by the injected sleep, so a pass costs no real time. */
function fakeClock() {
  const state = { t: 0 };
  return {
    now: () => state.t,
    sleep: async (ms: number) => { state.t += ms; },
  };
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  getDb().prepare('DELETE FROM api_keys').run();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('health pass ordering', () => {
  it('interleaves platforms instead of probing one provider back to back', async () => {
    // Inserted provider-clustered, exactly as the old raw-DB-order pass read them.
    const groq = [seedKey('groq'), seedKey('groq'), seedKey('groq')];
    const cf = [seedKey('cloudflare'), seedKey('cloudflare')];
    const mistral = [seedKey('mistral')];

    const clock = fakeClock();
    const platformOf = new Map<number, string>([
      ...groq.map(id => [id, 'groq'] as const),
      ...cf.map(id => [id, 'cloudflare'] as const),
      ...mistral.map(id => [id, 'mistral'] as const),
    ]);
    const order: string[] = [];

    await checkAllKeys({
      now: clock.now,
      sleep: clock.sleep,
      concurrency: 1,
      check: async (keyId: number) => { order.push(platformOf.get(keyId)!); },
    });

    expect(order).toEqual(['groq', 'cloudflare', 'mistral', 'groq', 'cloudflare', 'groq']);
  });

  it('spaces consecutive probes of the same provider', async () => {
    const ids = [seedKey('groq'), seedKey('groq'), seedKey('groq'), seedKey('cloudflare')];
    const clock = fakeClock();
    const spacingMs = 1000;
    const startedAt = new Map<number, number>();

    await checkAllKeys({
      now: clock.now,
      sleep: clock.sleep,
      concurrency: 1,
      minSpacingMs: spacingMs,
      check: async (keyId: number) => { startedAt.set(keyId, clock.now()); },
    });

    const groqTimes = ids.slice(0, 3).map(id => startedAt.get(id)!);
    expect(groqTimes).toHaveLength(3);
    for (let i = 1; i < groqTimes.length; i++) {
      expect(groqTimes[i]! - groqTimes[i - 1]!).toBeGreaterThanOrEqual(spacingMs);
    }
    // The other provider is not held behind groq's spacing.
    expect(startedAt.get(ids[3]!)).toBe(0);
  });

  it('keeps the whole pass inside its time budget even for a big single-provider fleet', async () => {
    for (let i = 0; i < 400; i++) seedKey('groq');

    const clock = fakeClock();
    await checkAllKeys({
      now: clock.now,
      sleep: clock.sleep,
      concurrency: 8,
      check: async () => {},
    });

    expect(clock.now()).toBeLessThanOrEqual(HEALTH_PASS_TIME_BUDGET_MS);
    expect(HEALTH_PASS_TIME_BUDGET_MS).toBeLessThan(HEALTH_CHECK_INTERVAL_MS);
  });
});

describe('recently-validated keys', () => {
  it('skips keys checked inside the recency window', async () => {
    const fresh = seedKey('groq');
    getDb().prepare("UPDATE api_keys SET last_checked_at = datetime('now') WHERE id = ?").run(fresh);
    const stale = seedKey('groq');
    getDb().prepare("UPDATE api_keys SET last_checked_at = datetime('now', '-30 minutes') WHERE id = ?").run(stale);
    const never = seedKey('groq');

    const clock = fakeClock();
    const checked: number[] = [];
    const result = await checkAllKeys({
      now: clock.now,
      sleep: clock.sleep,
      concurrency: 1,
      check: async (keyId: number) => { checked.push(keyId); },
    });

    expect(checked.sort()).toEqual([stale, never].sort());
    expect(result.skippedKeyIds).toEqual([fresh]);
    expect(RECENT_CHECK_SKIP_MS).toBeLessThan(HEALTH_CHECK_INTERVAL_MS);
  });

  it('never skips a key sitting at status=error', async () => {
    const errored = seedKey('groq', { status: 'error' });
    getDb().prepare("UPDATE api_keys SET last_checked_at = datetime('now') WHERE id = ?").run(errored);

    const clock = fakeClock();
    const checked: number[] = [];
    await checkAllKeys({
      now: clock.now, sleep: clock.sleep, concurrency: 1,
      check: async (keyId: number) => { checked.push(keyId); },
    });

    expect(checked).toEqual([errored]);
  });

  it('force ignores both the recency skip and the spacing (manual / post-wake pass)', async () => {
    const a = seedKey('groq');
    const b = seedKey('groq');
    getDb().prepare("UPDATE api_keys SET last_checked_at = datetime('now')").run();

    const clock = fakeClock();
    const checked: number[] = [];
    const result = await checkAllKeys({
      now: clock.now, sleep: clock.sleep, concurrency: 1, force: true,
      check: async (keyId: number) => { checked.push(keyId); },
    });

    expect(checked.sort()).toEqual([a, b].sort());
    expect(result.skippedKeyIds).toEqual([]);
    expect(clock.now()).toBe(0);
  });
});

describe('interval jitter', () => {
  it('spreads the next pass around the base interval', () => {
    expect(nextHealthCheckDelayMs(() => 0)).toBeLessThan(HEALTH_CHECK_INTERVAL_MS);
    expect(nextHealthCheckDelayMs(() => 0.999)).toBeGreaterThan(HEALTH_CHECK_INTERVAL_MS);
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const delay = nextHealthCheckDelayMs(() => r);
      expect(delay).toBeGreaterThanOrEqual(HEALTH_CHECK_INTERVAL_MS * 0.5);
      expect(delay).toBeLessThanOrEqual(HEALTH_CHECK_INTERVAL_MS * 1.5);
      // A jittered pass must never start before the recency window has closed,
      // or the skip filter would swallow whole passes.
      expect(delay).toBeGreaterThan(RECENT_CHECK_SKIP_MS);
    }
  });

  it('reschedules itself with a fresh delay after each pass', async () => {
    const scheduled: { ms: number; fn: () => void | Promise<void> }[] = [];
    const scheduler: Scheduler = {
      every: () => vi.fn(),
      after(ms, fn) { scheduled.push({ ms, fn }); return vi.fn(); },
    };

    startHealthChecker(scheduler);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!.fn();
    expect(scheduled).toHaveLength(2);
    stopHealthChecker();
    await scheduled[1]!.fn();
    // Stopped: the pass must not queue another timer.
    expect(scheduled).toHaveLength(2);
  });
});
