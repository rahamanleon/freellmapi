import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Unit tests for cooldown-probe early recovery: which cooldowns are eligible
// (heuristic only — authoritative/credit/tier are provider-stated facts and are
// never probed), the half-bench ripeness gate, the restart stagger, the failed-
// probe backoff progression, the per-pass probe budget, and early clearing on a
// successful probe. Plus the provenance classification the whole feature keys
// off (cooldownDecisionForError / setCooldown source tagging).

import { initDb, getDb } from '../../db/index.js';
import {
  setCooldown,
  isOnCooldown,
  getProbeableCooldowns,
} from '../../services/ratelimit.js';
import {
  runCooldownProbePass,
  resetCooldownProbeState,
  startCooldownProbe,
  stopCooldownProbe,
} from '../../services/cooldown-probe.js';
import { cooldownDecisionForError } from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';
import type { KeyProbeOutcome } from '../../services/health.js';

const MINUTE = 60_000;

// Distinct keyId per bench: the cooldown store is module-global (memory map +
// DB), so shared ids would leak state across tests.
let keySeq = 910_000;

function bench(
  source: 'heuristic' | 'authoritative' | 'credit' | 'tier',
  opts: { durationMs?: number; modelId?: string; keyId?: number } = {},
): number {
  const keyId = opts.keyId ?? ++keySeq;
  setCooldown('probefake', opts.modelId ?? 'model-a', keyId, opts.durationMs ?? 10 * MINUTE, source);
  return keyId;
}

// A probe that always answers the same thing, wrapped in a spy so tests can
// assert exactly which keys were probed and how often.
const probeReturning = (outcome: KeyProbeOutcome) => vi.fn(async (_keyId: number) => outcome);

// jitter() => 0 makes a first-sighted key probeable on the very next pass,
// which keeps the "seed pass then probe pass" choreography deterministic.
const noJitter = () => 0;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  resetCooldownProbeState();
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
});

describe('probe eligibility', () => {
  it('only heuristic cooldowns are visible to the prober', () => {
    const heuristic = bench('heuristic');
    bench('authoritative');
    bench('credit');
    bench('tier');

    const rows = getProbeableCooldowns();
    expect(rows).toHaveLength(1);
    expect(rows[0].keyId).toBe(heuristic);
  });

  it('never probes authoritative, credit, or tier cooldowns', async () => {
    const heuristic = bench('heuristic');
    const authoritative = bench('authoritative');
    const credit = bench('credit');
    const tier = bench('tier');
    const probe = probeReturning('valid');
    const now = Date.now() + 6 * MINUTE; // past the half-bench ripeness gate

    await runCooldownProbePass({ now, probe, jitter: noJitter }); // seed pass
    const result = await runCooldownProbePass({ now, probe, jitter: noJitter });

    expect(result.probedKeyIds).toEqual([heuristic]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(heuristic);
    // The provider-stated benches stay exactly where they were.
    expect(isOnCooldown('probefake', 'model-a', authoritative)).toBe(true);
    expect(isOnCooldown('probefake', 'model-a', credit)).toBe(true);
    expect(isOnCooldown('probefake', 'model-a', tier)).toBe(true);
  });

  it('does not probe before half the bench has elapsed', async () => {
    bench('heuristic', { durationMs: 10 * MINUTE });
    const probe = probeReturning('valid');
    const early = Date.now() + 2 * MINUTE; // 20% served — not ripe

    await runCooldownProbePass({ now: early, probe, jitter: noJitter });
    await runCooldownProbePass({ now: early, probe, jitter: noJitter });
    expect(probe).not.toHaveBeenCalled();

    const ripe = Date.now() + 6 * MINUTE; // 60% served — ripe
    await runCooldownProbePass({ now: ripe, probe, jitter: noJitter }); // seed
    const result = await runCooldownProbePass({ now: ripe, probe, jitter: noJitter });
    expect(result.probedKeyIds).toHaveLength(1);
  });

  it('skips cooldowns that are about to expire on their own', async () => {
    bench('heuristic', { durationMs: 10 * MINUTE });
    const probe = probeReturning('valid');
    // 9.5 minutes in: past half-bench, but the remaining 30s is less than a
    // scan interval — the probe would cost more than the idle time it saves.
    const now = Date.now() + 9 * MINUTE + 30_000;

    await runCooldownProbePass({ now, probe, jitter: noJitter });
    await runCooldownProbePass({ now, probe, jitter: noJitter });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('successful probe', () => {
  it('clears every heuristic cooldown on the key early, with one probe', async () => {
    const keyId = ++keySeq;
    bench('heuristic', { keyId, modelId: 'model-a' });
    bench('heuristic', { keyId, modelId: 'model-b' });
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(true);
    expect(isOnCooldown('probefake', 'model-b', keyId)).toBe(true);

    const probe = probeReturning('valid');
    const now = Date.now() + 6 * MINUTE;
    await runCooldownProbePass({ now, probe, jitter: noJitter }); // seed
    const result = await runCooldownProbePass({ now, probe, jitter: noJitter });

    // One validate call is the same evidence for both benched models.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.clearedCooldowns).toBe(2);
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(false);
    expect(isOnCooldown('probefake', 'model-b', keyId)).toBe(false);
    expect(getProbeableCooldowns(now)).toHaveLength(0);
  });
});

describe('failed probe', () => {
  function expiryOf(keyId: number): number {
    const row = getDb().prepare(
      "SELECT expires_at_ms FROM rate_limit_cooldowns WHERE key_id = ?",
    ).get(keyId) as { expires_at_ms: number };
    return row.expires_at_ms;
  }

  it('leaves the cooldown exactly as it was — never extends it', async () => {
    const keyId = bench('heuristic', { durationMs: 30 * MINUTE });
    const expiryBefore = expiryOf(keyId);
    const probe = probeReturning('invalid');
    const now = Date.now() + 16 * MINUTE;

    await runCooldownProbePass({ now, probe, jitter: noJitter }); // seed
    const result = await runCooldownProbePass({ now, probe, jitter: noJitter });

    expect(result.probedKeyIds).toEqual([keyId]);
    expect(result.clearedCooldowns).toBe(0);
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(true);
    expect(expiryOf(keyId)).toBe(expiryBefore);
  });

  it('backs off with increasing intervals between probes', async () => {
    const keyId = bench('heuristic', { durationMs: 60 * MINUTE });
    const probe = probeReturning('invalid');
    const t0 = Date.now() + 31 * MINUTE;

    await runCooldownProbePass({ now: t0, probe, jitter: noJitter }); // seed
    await runCooldownProbePass({ now: t0, probe, jitter: noJitter }); // probe #1 fails
    expect(probe).toHaveBeenCalledTimes(1);

    // Within the first 2-minute backoff: no probe.
    await runCooldownProbePass({ now: t0 + 1 * MINUTE, probe, jitter: noJitter });
    expect(probe).toHaveBeenCalledTimes(1);

    // Backoff served: probe #2 fails, backoff doubles to 4 minutes.
    await runCooldownProbePass({ now: t0 + 2 * MINUTE, probe, jitter: noJitter });
    expect(probe).toHaveBeenCalledTimes(2);

    // 3 minutes after probe #2 — still inside the 4-minute backoff.
    await runCooldownProbePass({ now: t0 + 5 * MINUTE, probe, jitter: noJitter });
    expect(probe).toHaveBeenCalledTimes(2);

    // 4 minutes after probe #2: due again.
    await runCooldownProbePass({ now: t0 + 6 * MINUTE, probe, jitter: noJitter });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(true);
  });

  it('treats an inconclusive transport error like a failure', async () => {
    const keyId = bench('heuristic');
    const probe = probeReturning('error');
    const now = Date.now() + 6 * MINUTE;

    await runCooldownProbePass({ now, probe, jitter: noJitter }); // seed
    const result = await runCooldownProbePass({ now, probe, jitter: noJitter });

    expect(result.clearedCooldowns).toBe(0);
    expect(isOnCooldown('probefake', 'model-a', keyId)).toBe(true);
  });
});

describe('stagger and probe budget', () => {
  it('a first-sighted key gets a jittered schedule instead of an instant probe', async () => {
    bench('heuristic', { durationMs: 60 * MINUTE });
    const probe = probeReturning('valid');
    const maxJitter = () => 0.999; // ~45s stagger
    const t0 = Date.now() + 31 * MINUTE;

    await runCooldownProbePass({ now: t0, probe, jitter: maxJitter }); // seed only
    expect(probe).not.toHaveBeenCalled();

    // Still inside the stagger window.
    await runCooldownProbePass({ now: t0 + 30_000, probe, jitter: maxJitter });
    expect(probe).not.toHaveBeenCalled();

    // Stagger served.
    await runCooldownProbePass({ now: t0 + 46_000, probe, jitter: maxJitter });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('caps how many keys one pass may probe', async () => {
    for (let i = 0; i < 5; i++) bench('heuristic');
    const probe = probeReturning('valid');
    const now = Date.now() + 6 * MINUTE;

    await runCooldownProbePass({ now, probe, jitter: noJitter, maxProbes: 2 }); // seed
    const first = await runCooldownProbePass({ now, probe, jitter: noJitter, maxProbes: 2 });
    expect(first.probedKeyIds).toHaveLength(2);

    // The rest are picked up by later passes, not all at once.
    const second = await runCooldownProbePass({ now, probe, jitter: noJitter, maxProbes: 2 });
    expect(second.probedKeyIds).toHaveLength(2);
    expect(probe).toHaveBeenCalledTimes(4);
  });
});

describe('cooldown provenance (cooldownDecisionForError)', () => {
  function fakeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
    const n = ++keySeq;
    return {
      provider: {} as any, modelId: 'fake-model', modelDbId: 910_000 + n, apiKey: 'k',
      keyId: n, platform: 'probefake', displayName: 'Fake Model',
      rpdLimit: null, tpdLimit: null,
      ...overrides,
    };
  }

  it('tags 402 out-of-credits as credit (never probed)', () => {
    const decision = cooldownDecisionForError(fakeRoute(), new Error('402 Payment Required'));
    expect(decision.source).toBe('credit');
  });

  it('tags 403 model-not-on-tier as tier (never probed)', () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    expect(cooldownDecisionForError(fakeRoute(), err).source).toBe('tier');
  });

  it('tags a daily-quota bench as authoritative — the expiry is a reset time, not a guess', () => {
    const err = new Error('You have used up your daily free allocation');
    const decision = cooldownDecisionForError(fakeRoute(), err);
    expect(decision.source).toBe('authoritative');
    expect(decision.durationMs).toBeGreaterThan(0);
  });

  it('tags a plain transient 429 as heuristic (probe-eligible)', () => {
    const decision = cooldownDecisionForError(fakeRoute(), new Error('429 Too Many Requests'));
    expect(decision.source).toBe('heuristic');
    expect(decision.durationMs).toBe(90_000);
  });

  it('a Retry-After that determined the expiry is authoritative; a shorter one is not', () => {
    // Retry-After beyond our 90s transient bench: the provider's word set the
    // expiry, so probing early could never be justified.
    const longRetry = Object.assign(new Error('429 Too Many Requests'), { retryAfterMs: 10 * MINUTE });
    const long = cooldownDecisionForError(fakeRoute(), longRetry);
    expect(long).toEqual({ durationMs: 10 * MINUTE, source: 'authoritative' });

    // Retry-After SHORTER than our bench: everything past the provider's own
    // retry time is our pessimism, so early recovery stays on the table.
    const shortRetry = Object.assign(new Error('429 Too Many Requests'), { retryAfterMs: 1_000 });
    const short = cooldownDecisionForError(fakeRoute(), shortRetry);
    expect(short).toEqual({ durationMs: 90_000, source: 'heuristic' });
  });
});

describe('startCooldownProbe / stopCooldownProbe', () => {
  function makeScheduler() {
    const every: { ms: number; fn: () => void | Promise<void> }[] = [];
    const cancels: ReturnType<typeof vi.fn>[] = [];
    return {
      scheduler: {
        every(ms: number, fn: () => void | Promise<void>) {
          const cancel = vi.fn();
          every.push({ ms, fn });
          cancels.push(cancel);
          return cancel;
        },
        after(_ms: number, _fn: () => void | Promise<void>) {
          return vi.fn();
        },
      },
      every,
      cancels,
    };
  }

  afterEach(() => {
    stopCooldownProbe();
    delete process.env.COOLDOWN_PROBE_DISABLED;
  });

  it('registers one every-minute scan job', () => {
    const { scheduler, every } = makeScheduler();
    startCooldownProbe(scheduler);
    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(60_000);
  });

  it('is idempotent — double-start registers only one job', () => {
    const { scheduler, every } = makeScheduler();
    startCooldownProbe(scheduler);
    startCooldownProbe(scheduler);
    expect(every).toHaveLength(1);
  });

  it('the kill switch registers nothing', () => {
    process.env.COOLDOWN_PROBE_DISABLED = '1';
    const { scheduler, every } = makeScheduler();
    startCooldownProbe(scheduler);
    expect(every).toHaveLength(0);
  });

  it('stop invokes the cancel handle', () => {
    const { scheduler, cancels } = makeScheduler();
    startCooldownProbe(scheduler);
    stopCooldownProbe();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it('the registered job runs a pass without throwing', async () => {
    const { scheduler, every } = makeScheduler();
    startCooldownProbe(scheduler);
    await expect(every[0].fn()).resolves.toBeUndefined();
  });
});
