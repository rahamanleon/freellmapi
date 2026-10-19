import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  resolveModelGroupCandidates,
  routeRequest,
  refreshStatsCache,
  setRoutingStrategy,
} from '../../services/router.js';
import { encrypt } from '../../lib/crypto.js';

// A slug-only match is a FALLBACK, not an equal candidate (#651). The router
// re-orders whatever chain it is handed by live score, so the tier has to be
// expressed as something orderChain honours as a TIER — otherwise a
// coincidental slug sibling with better recent numbers silently answers a
// request that named a different model literally.

function addKey(platform: string): number {
  const { encrypted, iv, authTag } = encrypt(`${platform}-secret`);
  const r = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, platform, encrypted, iv, authTag);
  return Number(r.lastInsertRowid);
}

function addModel(platform: string, modelId: string): number {
  const r = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
    VALUES (?, ?, ?, 50, 50, 1, 'catalog')
  `).run(platform, modelId, modelId);
  return Number(r.lastInsertRowid);
}

/** Give one (model, key) a spotless record so its bandit score is high. */
function logSuccesses(platform: string, modelId: string, keyId: number, n: number) {
  const stmt = getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, request_type)
    VALUES (?, ?, ?, 'success', 100, 400, 200, 'chat')
  `);
  for (let i = 0; i < n; i++) stmt.run(platform, modelId, keyId);
}

function logFailures(platform: string, modelId: string, keyId: number, n: number) {
  const stmt = getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
    VALUES (?, ?, ?, 'error', 100, 0, 30000, 'upstream timeout', 'chat')
  `);
  for (let i = 0; i < n; i++) stmt.run(platform, modelId, keyId);
}

describe('slug-match demotion survives the router', () => {
  let literalId: number;
  let slugId: number;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    getDb().prepare('DELETE FROM api_keys').run();
    setRoutingStrategy('balanced');

    const groqKey = addKey('groq');
    const cerebrasKey = addKey('cerebras');
    literalId = addModel('groq', 'tier-test-model');
    slugId = addModel('cerebras', 'tier-test-other');

    // The fallback candidate is measurably BETTER than the literal one, so
    // score alone would put it first.
    logFailures('groq', 'tier-test-model', groqKey, 30);
    logSuccesses('cerebras', 'tier-test-other', cerebrasKey, 40);
    refreshStatsCache(getDb(), true);
  });

  it('orders a demoted member behind a literal one despite a better score', () => {
    const chain = resolveModelGroupCandidates([literalId, slugId], new Set([slugId]));
    expect(chain.map(c => c.model_db_id)).toEqual([literalId, slugId]);
  });

  it('still dispatches to the literal model when the router re-sorts the chain', () => {
    // routeRequest runs its own orderChain over the prefetched chain, which is
    // where a tier expressed as mere ordering would be lost.
    const chain = resolveModelGroupCandidates([literalId, slugId], new Set([slugId]));
    const route = routeRequest(1000, undefined, undefined, false, false, undefined, chain);
    expect(route.modelDbId).toBe(literalId);
    route.release?.();
  });

  it('falls through to the demoted member once the literal one is ruled out', () => {
    const chain = resolveModelGroupCandidates([literalId, slugId], new Set([slugId]));
    const route = routeRequest(1000, undefined, undefined, false, false, new Set([literalId]), chain);
    expect(route.modelDbId).toBe(slugId);
    route.release?.();
  });

  it('leaves an untiered chain ordered purely by score', () => {
    const chain = resolveModelGroupCandidates([literalId, slugId]);
    expect(chain.map(c => c.model_db_id)).toEqual([slugId, literalId]);
  });
});
