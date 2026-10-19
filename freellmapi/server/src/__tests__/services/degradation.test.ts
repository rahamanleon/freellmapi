import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { initDb, getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const {
  computeHealthSnapshot,
  updateDegradationState,
  getDegradationStatus,
  isDegraded,
  resetDegradationState,
} = await import('../../services/degradation.js');

// #904 degraded-mode state machine: when the healthy-provider ratio stays
// below the threshold for a sustained period, the gateway flips to degraded
// mode (router stops exploring, health endpoint reports the state); recovery
// needs the ratio back above threshold for a longer grace period.

let nextId = 40000;

function seedKey(platform: string, opts: { status?: string; enabled?: number } = {}): number {
  const id = ++nextId;
  const enc = encrypt(`deg-${id}`);
  getDb().prepare(`
    INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, platform, `deg-${id}`, enc.encrypted, enc.iv, enc.authTag, opts.enabled ?? 1, opts.status ?? 'healthy');
  return id;
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  getDb().prepare('DELETE FROM api_keys').run();
  resetDegradationState();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('degraded-mode state machine', () => {
  it('reports normal with all providers healthy', () => {
    seedKey('groq');
    seedKey('cloudflare');
    seedKey('mistral');
    const s = updateDegradationState(0);
    expect(s.state).toBe('normal');
    expect(s.healthyProviders).toBe(3);
    expect(s.totalProviders).toBe(3);
    expect(s.ratio).toBe(1);
    expect(isDegraded()).toBe(false);
  });

  it('counts unknown-status keys as usable, error keys as not', () => {
    seedKey('groq', { status: 'unknown' });
    seedKey('cloudflare', { status: 'healthy' });
    seedKey('mistral', { status: 'error' });
    const snap = computeHealthSnapshot();
    expect(snap.healthyProviders).toBe(2);
    expect(snap.totalProviders).toBe(3);
    expect(snap.ratio).toBeCloseTo(2 / 3);
  });

  it('ignores disabled keys', () => {
    seedKey('groq', { enabled: 0, status: 'healthy' });
    seedKey('cloudflare', { enabled: 0, status: 'healthy' });
    seedKey('mistral', { enabled: 0, status: 'healthy' });
    const snap = computeHealthSnapshot();
    expect(snap.totalProviders).toBe(0);
    expect(snap.ratio).toBe(1); // no providers to judge → not degraded
  });

  it('enters degraded mode only after the ratio stays low for the grace period', () => {
    seedKey('groq', { status: 'healthy' });
    seedKey('cloudflare', { status: 'error' });
    seedKey('mistral', { status: 'error' });
    seedKey('openai', { status: 'error' });

    // Below threshold (1/4 = 25% < 50%) but grace period not elapsed yet.
    const early = updateDegradationState(0);
    expect(early.state).toBe('normal');
    expect(isDegraded()).toBe(false);

    // Within the entry grace (60s default) still normal.
    const within = updateDegradationState(59_000);
    expect(within.state).toBe('normal');

    // Past the grace → degraded.
    const degraded = updateDegradationState(60_000);
    expect(degraded.state).toBe('degraded');
    expect(degraded.degradedAt).not.toBeNull();
    expect(isDegraded()).toBe(true);
  });

  it('stays normal when the ratio is at or above the threshold', () => {
    seedKey('groq', { status: 'healthy' });
    seedKey('cloudflare', { status: 'healthy' });
    seedKey('mistral', { status: 'error' });
    seedKey('openai', { status: 'error' });
    // 2/4 = 50% — exactly at the default threshold → not below.
    const s = updateDegradationState(0);
    expect(s.state).toBe('normal');
  });

  it('exits degraded mode only after recovery grace elapses', () => {
    seedKey('groq', { status: 'healthy' });
    seedKey('cloudflare', { status: 'error' });
    seedKey('mistral', { status: 'error' });
    seedKey('openai', { status: 'error' });
    updateDegradationState(0);
    updateDegradationState(60_000);
    expect(isDegraded()).toBe(true);

    // Providers recover, but the exit grace (120s default) hasn't elapsed.
    getDb().prepare("UPDATE api_keys SET status = 'healthy' WHERE platform IN ('cloudflare', 'mistral', 'openai')").run();
    const recovering = updateDegradationState(60_001);
    expect(recovering.state).toBe('degraded'); // still degraded
    expect(isDegraded()).toBe(true);

    // Past the exit grace → back to normal.
    const recovered = updateDegradationState(60_001 + 120_000);
    expect(recovered.state).toBe('normal');
    expect(recovered.degradedAt).toBeNull();
    expect(isDegraded()).toBe(false);
  });

  it('does not flap: a transient single-pass recovery resets the recovery streak', () => {
    seedKey('groq', { status: 'healthy' });
    seedKey('cloudflare', { status: 'error' });
    seedKey('mistral', { status: 'error' });
    seedKey('openai', { status: 'error' });
    updateDegradationState(0);
    updateDegradationState(60_000);
    expect(isDegraded()).toBe(true);

    // One good pass then back down: the recovery streak must reset so the
    // gateway stays degraded instead of exiting early.
    getDb().prepare("UPDATE api_keys SET status = 'healthy' WHERE platform = 'cloudflare'").run();
    updateDegradationState(60_001); // recovered pass starts streak
    getDb().prepare("UPDATE api_keys SET status = 'error' WHERE platform = 'cloudflare'").run();
    updateDegradationState(60_002); // down again — streak reset
    getDb().prepare("UPDATE api_keys SET status = 'healthy' WHERE platform IN ('cloudflare', 'mistral', 'openai')").run();
    const afterLongRecovery = updateDegradationState(60_002 + 120_000);
    expect(afterLongRecovery.state).toBe('degraded'); // exit streak restarted at 60_002
  });

  it('does not degrade when there are fewer providers than DEGRADED_MIN_PROVIDERS', () => {
    seedKey('groq', { status: 'healthy' });
    seedKey('cloudflare', { status: 'error' });
    // Only 2 providers < default min of 3 → never degraded.
    const s = updateDegradationState(0);
    updateDegradationState(60_000);
    expect(s.state).toBe('normal');
    expect(isDegraded()).toBe(false);
  });

  it('getDegradationStatus returns the last snapshot without re-querying', () => {
    seedKey('groq', { status: 'healthy' });
    updateDegradationState(0);
    const status = getDegradationStatus();
    expect(status.totalProviders).toBe(1);
    expect(status.state).toBe('normal');
  });
});
