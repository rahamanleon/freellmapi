import { describe, it, expect, beforeAll } from 'vitest';

// #592 locality exemption: a key whose base_url points at loopback or an
// RFC1918/private address is a LOCAL inference server (Ollama / llama.cpp /
// LM Studio registered through the 'custom' platform). It has no provider
// quota, so neither the 90s transient bench nor the 2m→24h escalation ladder
// ever applies — the bench is capped at a few seconds, even for a literal 429
// (local servers emit those under concurrent load) and even when a Retry-After
// is attached. Non-local keys (public IPs/hostnames, built-in platforms with
// base_url NULL) keep the full pre-existing behavior.

import { initDb, getDb } from '../../db/index.js';
import { cooldownDecisionForError } from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';

const MINUTE = 60_000;
const TRANSIENT = 90_000;
const LOCAL_CAP_MS = 5_000;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

// Register a custom-platform key row carrying the endpoint, like
// routes/keys.ts POST /custom does, and return its real DB id.
function insertKey(baseUrl: string | null): number {
  const r = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'test-endpoint', 'enc', 'iv', 'tag', 'valid', 1, ?)
  `).run(baseUrl);
  return Number(r.lastInsertRowid);
}

let modelSeq = 0;
function routeForKey(keyId: number): RouteResult {
  const n = ++modelSeq;
  return {
    provider: {} as any, modelId: `local-model-${n}`, modelDbId: 593_000 + n,
    apiKey: 'k', keyId, platform: 'custom', displayName: 'Local Model',
    rpdLimit: null, tpdLimit: null,
  };
}

const real429 = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });
const timeoutErr = () => Object.assign(new Error('Request timeout after 120000ms'), { name: 'TimeoutError' });

describe('local-endpoint cooldown cap (#592)', () => {
  it('loopback base_url: capped short bench even on repeated real 429s', () => {
    const route = routeForKey(insertKey('http://127.0.0.1:11434/v1'));
    for (let i = 0; i < 4; i++) {
      const decision = cooldownDecisionForError(route, real429());
      expect(decision.durationMs).toBe(LOCAL_CAP_MS);
      expect(decision.source).toBe('heuristic');
    }
  });

  it('localhost hostname counts as loopback without DNS', () => {
    const route = routeForKey(insertKey('http://localhost:11434/v1'));
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(LOCAL_CAP_MS);
    expect(cooldownDecisionForError(route, timeoutErr()).durationMs).toBe(LOCAL_CAP_MS);
  });

  it('RFC1918 base_url (LAN box): capped the same way', () => {
    for (const url of ['http://192.168.1.50:8080/v1', 'http://10.0.0.7:11434/v1', 'http://172.16.4.2:5000/v1']) {
      const route = routeForKey(insertKey(url));
      expect(cooldownDecisionForError(route, real429()).durationMs).toBe(LOCAL_CAP_MS);
      expect(cooldownDecisionForError(route, real429()).durationMs).toBe(LOCAL_CAP_MS);
    }
  });

  it('ignores an upstream Retry-After on a local endpoint', () => {
    const route = routeForKey(insertKey('http://127.0.0.1:8080/v1'));
    const err = Object.assign(new Error('429 Too Many Requests'), { status: 429, retryAfterMs: 5 * MINUTE });
    expect(cooldownDecisionForError(route, err).durationMs).toBe(LOCAL_CAP_MS);
  });

  it('public-IP base_url is NOT exempt: transient then ladder on real 429s', () => {
    const route = routeForKey(insertKey('http://203.0.113.10/v1'));
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(TRANSIENT);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(2 * MINUTE);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(10 * MINUTE);
  });

  it('non-literal hostname is treated as non-local (no DNS on the hot path)', () => {
    const route = routeForKey(insertKey('https://inference.example.com/v1'));
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(TRANSIENT);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(2 * MINUTE);
  });

  it('a key with no base_url (built-in platform shape) keeps full behavior', () => {
    const route = routeForKey(insertKey(null));
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(TRANSIENT);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(2 * MINUTE);
  });
});
