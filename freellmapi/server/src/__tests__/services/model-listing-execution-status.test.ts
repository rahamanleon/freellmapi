import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { buildModelListing } from '../../services/model-listing.js';
import { setCooldown } from '../../services/ratelimit.js';

// #1100: /v1/models gains a per-model execution_status (ready / needsKey /
// exhausted) derived from whether the router could actually dispatch to the
// model right now, so agents can filter ?execution_status=ready and route
// around exhausted models instead of 429ing.

function seedModel(platform: string, modelId: string, enabled = 1) {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled)
    VALUES (?, ?, ?, 5, 5, 'Medium', NULL, NULL, NULL, NULL, '', ?)
  `).run(platform, modelId, modelId, enabled);
}

let keySeq = 0;
function seedKey(platform: string, status: string, enabled = 1, scope: string[] | null = null) {
  keySeq += 1;
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
    VALUES (?, ?, 'x', 'x', 'x', ?, ?, ?)
  `).run(platform, `${platform}-${status}-${keySeq}`, status, enabled, scope ? JSON.stringify(scope) : null).lastInsertRowid);
}

function statusFor(modelId: string) {
  const m = buildModelListing().models.find(x => x.id === modelId);
  return m?.executionStatus;
}

describe('buildModelListing execution_status (#1100)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.UNIFY_MODELS = 'false';
    initDb(':memory:');
  });

  it('marks a model ready when a healthy enabled key exists', () => {
    seedModel('groq', 'ready-model');
    seedKey('groq', 'healthy');
    expect(statusFor('ready-model')).toBe('ready');
  });

  it('treats an unprobed (unknown) key as ready, not exhausted', () => {
    seedModel('groq', 'unknown-model');
    seedKey('groq', 'unknown');
    expect(statusFor('unknown-model')).toBe('ready');
  });

  it('marks a model needsKey when no enabled key exists', () => {
    seedModel('groq', 'nokey-model');
    expect(statusFor('nokey-model')).toBe('needsKey');
  });

  it('marks a model exhausted when every candidate key is rate-limited or invalid', () => {
    seedModel('groq', 'exhausted-model');
    seedKey('groq', 'rate_limited');
    seedKey('groq', 'invalid');
    expect(statusFor('exhausted-model')).toBe('exhausted');
  });

  it('stays ready when at least one of several keys is healthy', () => {
    seedModel('groq', 'mixed-model');
    seedKey('groq', 'rate_limited');
    seedKey('groq', 'healthy');
    expect(statusFor('mixed-model')).toBe('ready');
  });

  it('marks a disabled model needsKey regardless of keys', () => {
    seedModel('groq', 'disabled-model', 0);
    seedKey('groq', 'healthy');
    expect(statusFor('disabled-model')).toBe('needsKey');
  });

  // A live 429 never writes api_keys.status: it writes a per-key cooldown row.
  // Reading status alone therefore called a cooling-down model ready.
  it('marks a model exhausted when its only key is on cooldown', () => {
    seedModel('groq', 'cooling-model');
    const keyId = seedKey('groq', 'healthy');
    setCooldown('groq', 'cooling-model', keyId, 60_000, 'header');
    expect(statusFor('cooling-model')).toBe('exhausted');
  });

  it('stays ready when a sibling key is not on cooldown', () => {
    seedModel('groq', 'sibling-model');
    const cooling = seedKey('groq', 'healthy');
    seedKey('groq', 'healthy');
    setCooldown('groq', 'sibling-model', cooling, 60_000, 'header');
    expect(statusFor('sibling-model')).toBe('ready');
  });

  // #657: a key scoped to other models cannot serve this one, so it must not
  // make the model look ready.
  it('ignores a key scoped away from the model', () => {
    seedModel('groq', 'scoped-out-model');
    seedKey('groq', 'healthy', 1, ['some-other-model']);
    expect(statusFor('scoped-out-model')).toBe('exhausted');
  });

  it('counts a key scoped to the model itself', () => {
    seedModel('groq', 'scoped-in-model');
    seedKey('groq', 'healthy', 1, ['scoped-in-model']);
    expect(statusFor('scoped-in-model')).toBe('ready');
  });
});
