import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { runFallbackLoop, newFallbackState } from '../../lib/fallback-loop.js';
import { acquireLease, releaseLease, resetLeases, inFlightForKey } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

/**
 * The loop must free a route's in-flight lease on every exit path. A leak would
 * leave the key's concurrency budget permanently short (until the age-out
 * backstop), so this covers each way an iteration can end.
 */
function leasedRoute(keyId: number): RouteResult {
  const id = acquireLease('groq', 'llama-3.3-70b', keyId, 100);
  return {
    provider: {} as any,
    modelId: 'llama-3.3-70b',
    modelDbId: 1,
    apiKey: 'test-key',
    keyId,
    platform: 'groq',
    displayName: 'Llama 3.3 70B',
    rpdLimit: null,
    tpdLimit: null,
    release: () => releaseLease(id),
  };
}

function hooks(overrides: Record<string, unknown> = {}) {
  return {
    state: newFallbackState(),
    attemptLog: [],
    route: () => leasedRoute(1),
    dispatch: async () => 'done' as const,
    logFailure: () => undefined,
    onFatal: () => undefined,
    onRoutingExhausted: () => undefined,
    onExhausted: () => undefined,
    ...overrides,
  } as any;
}

describe('fallback loop releases in-flight leases', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetLeases();
    vi.restoreAllMocks();
  });

  it('releases after a successful dispatch', async () => {
    await runFallbackLoop(hooks());
    expect(inFlightForKey('groq', 1)).toBe(0);
  });

  it('releases after a committed stream', async () => {
    await runFallbackLoop(hooks({ dispatch: async () => 'committed' as const }));
    expect(inFlightForKey('groq', 1)).toBe(0);
  });

  it('releases every attempt when retryable failures exhaust the budget', async () => {
    let dispatched = 0;
    await runFallbackLoop(hooks({
      maxRetries: 4,
      dispatch: async () => {
        dispatched++;
        throw Object.assign(new Error('Groq API error 429: rate limit'), { status: 429 });
      },
    }));

    expect(dispatched).toBe(4);
    // Four leases were taken across the four attempts; none may survive.
    expect(inFlightForKey('groq', 1)).toBe(0);
  });

  it('releases on an auth failure that rotates the key', async () => {
    await runFallbackLoop(hooks({
      maxRetries: 2,
      dispatch: async () => {
        throw Object.assign(new Error('Groq API error 401: Invalid API Key'), { status: 401 });
      },
    }));
    expect(inFlightForKey('groq', 1)).toBe(0);
  });

  it('releases on a non-retryable fatal error', async () => {
    const onFatal = vi.fn();
    await runFallbackLoop(hooks({
      onFatal,
      dispatch: async () => { throw Object.assign(new Error('boom'), { status: 418 }); },
    }));
    expect(onFatal).toHaveBeenCalled();
    expect(inFlightForKey('groq', 1)).toBe(0);
  });

  it('releases when dispatch violates the outcome contract', async () => {
    const onFatal = vi.fn();
    await runFallbackLoop(hooks({ onFatal, dispatch: async () => 'nonsense' as any }));
    expect(onFatal).toHaveBeenCalled();
    expect(inFlightForKey('groq', 1)).toBe(0);
  });

  it('does not mask the provider error if release itself throws', async () => {
    const onFatal = vi.fn();
    const bad = {
      ...leasedRoute(1),
      release: () => { throw new Error('release exploded'); },
    };
    await runFallbackLoop(hooks({
      route: () => bad,
      onFatal,
      dispatch: async () => { throw Object.assign(new Error('real provider failure'), { status: 418 }); },
    })).catch(() => undefined);

    // onFatal must have seen the provider error, not the release error.
    expect(onFatal).toHaveBeenCalled();
    const err = onFatal.mock.calls[0]![1] as Error;
    expect(err.message).toContain('real provider failure');
  });

  it('tolerates a route with no release function', async () => {
    const noRelease = { ...leasedRoute(2) } as RouteResult;
    delete (noRelease as { release?: unknown }).release;
    await expect(runFallbackLoop(hooks({ route: () => noRelease }))).resolves.toBeUndefined();
  });
});
