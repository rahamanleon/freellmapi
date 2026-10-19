import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { startHealthChecker, stopHealthChecker, HEALTH_CHECK_INTERVAL_MS } from '../../services/health.js';
import type { Scheduler } from '../../lib/scheduler.js';

function makeScheduler() {
  const after: { ms: number; fn: () => void | Promise<void> }[] = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const scheduler: Scheduler = {
    every(_ms, _fn) {
      return vi.fn();
    },
    after(ms, fn) {
      const cancel = vi.fn();
      after.push({ ms, fn });
      cancels.push(cancel);
      return cancel;
    },
  };
  return { scheduler, after, cancels };
}

describe('startHealthChecker / stopHealthChecker', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    stopHealthChecker();
  });

  // The pass re-arms itself after each run with a fresh jittered delay (#553)
  // instead of sitting on a fixed 5-minute interval, so a fleet's probes don't
  // stay phase-locked to the same instant on every provider.
  it('arms one jittered timer around the 5-minute base interval', () => {
    const { scheduler, after } = makeScheduler();
    startHealthChecker(scheduler);
    expect(after).toHaveLength(1);
    expect(after[0].ms).toBeGreaterThanOrEqual(HEALTH_CHECK_INTERVAL_MS * 0.8);
    expect(after[0].ms).toBeLessThanOrEqual(HEALTH_CHECK_INTERVAL_MS * 1.2);
  });

  it('is idempotent — double-start registers only one job', () => {
    const { scheduler, after } = makeScheduler();
    startHealthChecker(scheduler);
    startHealthChecker(scheduler);
    expect(after).toHaveLength(1);
  });

  it('stop invokes the cancel handle', () => {
    const { scheduler, cancels } = makeScheduler();
    startHealthChecker(scheduler);
    stopHealthChecker();
    expect(cancels[0]).toHaveBeenCalledOnce();
  });

  it('can re-register after stop', () => {
    const { scheduler: s1 } = makeScheduler();
    startHealthChecker(s1);
    stopHealthChecker();

    const { scheduler: s2, after } = makeScheduler();
    startHealthChecker(s2);
    expect(after).toHaveLength(1);
  });

  it('the registered job runs checkAllKeys without throwing', async () => {
    const { scheduler, after } = makeScheduler();
    startHealthChecker(scheduler);
    await expect(after[0].fn()).resolves.toBeUndefined();
  });
});
