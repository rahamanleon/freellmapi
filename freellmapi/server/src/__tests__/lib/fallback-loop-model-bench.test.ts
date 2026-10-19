import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Model-level failure benching: a model that keeps failing upstream must sink
// out of routing on EVERY key that can serve it, not only on the key that
// happened to fail last — the failure window counts across keys, so a per-key
// bench would leave the siblings feeding the same sick model.

vi.mock('../../services/health.js', () => ({
  checkKeyHealth: vi.fn(),
  // recordUpstreamSuccess touches this on the streak-clearing path.
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  newFallbackState,
  recordRetryableFailure,
  recordUpstreamSuccess,
  MODEL_FAILURE_COOLDOWN_MS,
  MODEL_FAILURE_THRESHOLD,
  MODEL_FAILURE_WINDOW_MS,
  resetModelFailureWindows,
} from '../../lib/fallback-loop.js';
import {
  getActiveCooldownsForKeys,
  isOnCooldown,
  resetKeyLocalityCache,
} from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

const PLATFORM = 'groq';
let keyA = 0;
let keyB = 0;
let modelA: { id: number; model_id: string };
let modelB: { id: number; model_id: string };

function insertKey(label: string): number {
  const { encrypted, iv, authTag } = encrypt(`test-${label}`);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(PLATFORM, label, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

function routeFor(model: { id: number; model_id: string }, keyId: number): RouteResult {
  return {
    provider: {} as any,
    modelId: model.model_id,
    modelDbId: model.id,
    apiKey: 'k',
    keyId,
    platform: PLATFORM,
    displayName: model.model_id,
    rpdLimit: null,
    tpdLimit: null,
  };
}

// A plain 5xx: retryable, no quota signal, so the per-key bench is the short
// transient one (90s) — far below the model bench, which is what makes the
// assertions below able to tell the two apart.
const upstream500 = () => Object.assign(new Error('Groq API error 500: upstream'), { status: 500 });

function failOnce(model: { id: number; model_id: string }, keyId: number, now?: number) {
  // Fresh state per call: each failure stands for a separate request.
  recordRetryableFailure(routeFor(model, keyId), upstream500(), newFallbackState(), now);
}

function cooldownFor(model: { id: number; model_id: string }, keyId: number) {
  return getActiveCooldownsForKeys([keyId])
    .get(keyId)
    ?.find(c => c.platform === PLATFORM && c.modelId === model.model_id);
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  keyA = insertKey('key-a');
  keyB = insertKey('key-b');
  resetKeyLocalityCache();
  const models = db.prepare(
    'SELECT id, model_id FROM models WHERE platform = ? ORDER BY id LIMIT 2'
  ).all(PLATFORM) as { id: number; model_id: string }[];
  expect(models.length).toBe(2);
  [modelA, modelB] = models;
});

beforeEach(() => {
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  // The failure windows are module state and outlive the DB wipe above, so a
  // case would otherwise start partway to the threshold.
  resetModelFailureWindows();
});

describe('model-level failure benching covers every key of the model', () => {
  it('benches BOTH keys once the window trips, even though only one key failed last', () => {
    // Three failures inside the window, spread across the two keys.
    failOnce(modelA, keyA);
    failOnce(modelA, keyB);
    expect(MODEL_FAILURE_THRESHOLD).toBe(3);
    failOnce(modelA, keyA);

    for (const keyId of [keyA, keyB]) {
      expect(isOnCooldown(PLATFORM, modelA.model_id, keyId)).toBe(true);
      const cd = cooldownFor(modelA, keyId);
      expect(cd).toBeDefined();
      // The per-key transient bench is 90s; only the model bench reaches here.
      expect(cd!.remainingMs).toBeGreaterThan(MODEL_FAILURE_COOLDOWN_MS / 2);
    }
  });

  it('starts the streak over after a served request, so the next failure benches nothing extra', () => {
    failOnce(modelB, keyA);
    failOnce(modelB, keyB);
    // A served request is counter-evidence: the two failures above no longer count.
    recordUpstreamSuccess(routeFor(modelB, keyA), 100);
    failOnce(modelB, keyA);

    // Only the short per-key benches, no model-wide one.
    const benchedB = cooldownFor(modelB, keyB);
    expect(benchedB).toBeDefined();
    expect(benchedB!.remainingMs).toBeLessThan(MODEL_FAILURE_COOLDOWN_MS / 2);
    const benchedA = cooldownFor(modelB, keyA);
    expect(benchedA).toBeDefined();
    expect(benchedA!.remainingMs).toBeLessThan(MODEL_FAILURE_COOLDOWN_MS / 2);
  });

  // The window is a SLIDING one, which is only observable if the clock can be
  // moved. Without an injectable `now` this case would have to sleep for 15
  // real minutes, so the behaviour was never pinned.
  it('does not trip when the failures are spread beyond the sliding window', () => {
    const t0 = Date.now();
    failOnce(modelA, keyA, t0);
    failOnce(modelA, keyA, t0 + MODEL_FAILURE_WINDOW_MS + 1);
    failOnce(modelA, keyA, t0 + 2 * (MODEL_FAILURE_WINDOW_MS + 1));

    // Three failures, but never three inside one window: no model-wide bench.
    const benched = cooldownFor(modelA, keyB);
    expect(benched).toBeUndefined();
  });

  it('trips when the same three failures fall inside one window', () => {
    const t0 = Date.now();
    failOnce(modelA, keyA, t0);
    failOnce(modelA, keyA, t0 + 1000);
    failOnce(modelA, keyA, t0 + 2000);

    // keyB never failed, but the model-wide bench covers it.
    const benched = cooldownFor(modelA, keyB);
    expect(benched).toBeDefined();
    expect(benched!.remainingMs).toBeGreaterThan(MODEL_FAILURE_COOLDOWN_MS / 2);
  });
});
