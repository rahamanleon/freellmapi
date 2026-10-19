import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// #592: the null-limits exhaustion heuristic (getCooldownDecisionForLimit) must
// only fire on an actual provider quota signal (a real 429 / rate-limit-classified
// error). Before the fix, ANY retryable failure — a timeout on a slow local
// generation, a 5xx blip — fed the "2+ hits in an hour = daily-exhausted"
// counter and escalated the bench 2m→10m→1h→24h, 429-ing every request on what
// is often the user's only route. Also covers the cooldownHits ladder decay on
// success: two back-to-back failures used to keep their ladder step for 24h
// even after successful requests proved the quota alive.

import { initDb } from '../../db/index.js';
import { cooldownDecisionForError } from '../../lib/fallback-loop.js';
import {
  getNextCooldownDuration,
  recordRequest,
  recentHitCount,
} from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

const MINUTE = 60_000;
const TRANSIENT = 90_000;

// Distinct keyId AND modelDbId per fake route: the cooldown/ladder maps are
// module-global, so shared ids would leak state across tests.
let keySeq = 640_000;
function nullLimitRoute(): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: `null-limit-model-${n}`, modelDbId: 592_000 + n,
    apiKey: 'k', keyId: n, platform: 'ollama', displayName: 'Null-Limit Model',
    rpdLimit: null, tpdLimit: null,
  };
}

const timeoutErr = () => Object.assign(
  new Error('Request timeout after 120000ms'), { name: 'TimeoutError' },
);
const serverErr = () => Object.assign(
  new Error('Ollama API error 500: Internal Server Error'), { status: 500 },
);
const real429 = () => Object.assign(
  new Error('429 Too Many Requests'), { status: 429 },
);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

let route: RouteResult;
beforeEach(() => { route = nullLimitRoute(); });

describe('null-limits heuristic only fires on quota signals (#592)', () => {
  it('repeated timeouts stay on the short transient bench — no ladder', () => {
    for (let i = 0; i < 4; i++) {
      const decision = cooldownDecisionForError(route, timeoutErr());
      expect(decision.durationMs).toBe(TRANSIENT);
      expect(decision.source).toBe('heuristic');
    }
    // No hits recorded → the heuristic counter never sees a timeout.
    expect(recentHitCount(route.platform, route.modelId, route.keyId, Date.now())).toBe(0);
  });

  it('repeated 5xx stay on the short transient bench — no ladder', () => {
    for (let i = 0; i < 4; i++) {
      expect(cooldownDecisionForError(route, serverErr()).durationMs).toBe(TRANSIENT);
    }
    expect(recentHitCount(route.platform, route.modelId, route.keyId, Date.now())).toBe(0);
  });

  it('a timeout does not inherit escalation started by real 429s', () => {
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(TRANSIENT);
    // 2nd real 429 crosses the heuristic threshold → ladder (2m).
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(2 * MINUTE);
    // A timeout right after must NOT climb to the next ladder step (10m):
    // it is not a quota signal, so it neither records a hit nor escalates.
    expect(cooldownDecisionForError(route, timeoutErr()).durationMs).toBe(TRANSIENT);
    // Hit count still only reflects the two genuine 429s.
    expect(recentHitCount(route.platform, route.modelId, route.keyId, Date.now())).toBe(2);
  });

  it('real 429s still escalate — the Ollama-Cloud opaque-quota protection holds', () => {
    // 1st 429 → transient (no signal yet), then the ladder: 2m, 10m. This route
    // publishes no RPD/TPD, so escalation stops at the unknown-limit 10m cap
    // rather than climbing to the 1h/24h quarantine on an inferred verdict.
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(TRANSIENT);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(2 * MINUTE);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(10 * MINUTE);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(10 * MINUTE);
  });
});

describe('cooldownHits ladder decays on success (#592)', () => {
  it('a successful request resets the escalation ladder', () => {
    const { platform, modelId, keyId } = nullLimitRoute();
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(2 * MINUTE);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(10 * MINUTE);
    // A served request proves the quota is alive — ladder starts over.
    recordRequest(platform, modelId, keyId);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(2 * MINUTE);
  });

  it('without a success the ladder keeps escalating (documented contract intact)', () => {
    const { platform, modelId, keyId } = nullLimitRoute();
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(2 * MINUTE);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(10 * MINUTE);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(60 * MINUTE);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(24 * 60 * MINUTE);
  });
});
