import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, hasOtherUsableKey, setRoutingStrategy } from '../../services/router.js';

// Per-key model scopes (#657): a key whose model_scope_json is set must only
// ever serve the models it lists, and must not count as a usable sibling for
// models outside it. NULL scope is today's behavior, verbatim.
describe('Router model scope (#657)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    // Deterministic manual order, same pinning the base router tests use.
    setRoutingStrategy('priority');
    db.prepare('DELETE FROM api_keys').run();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    const models = db.prepare('SELECT id FROM models ORDER BY intelligence_rank ASC').all() as any[];
    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });

  function insertKey(platform: string, secret: string, scope: string[] | string | null): number {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt(secret);
    const scopeJson = scope == null ? null : typeof scope === 'string' ? scope : JSON.stringify(scope);
    const result = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
      VALUES (?, ?, ?, ?, ?, 'healthy', 1, ?)
    `).run(platform, 'test', encrypted, iv, authTag, scopeJson);
    return Number(result.lastInsertRowid);
  }

  function googleModels(): { id: number; model_id: string }[] {
    return getDb().prepare(
      'SELECT id, model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY intelligence_rank ASC',
    ).all('google') as { id: number; model_id: string }[];
  }

  it('a NULL scope serves every model of the platform (regression)', () => {
    insertKey('google', 'unscoped-key', null);
    const result = routeRequest();
    expect(result.platform).toBe('google');
    expect(result.apiKey).toBe('unscoped-key');
    expect(result.modelId).toBe(googleModels()[0]!.model_id);
  });

  it('excludes a model whose only key is scoped to other models', () => {
    insertKey('google', 'scoped-away', ['some-model-this-platform-does-not-have']);
    insertKey('groq', 'groq-key', null);
    // Google outranks Groq in the manual order, but its only key cannot serve
    // any Google model — the router must fall through instead of burning an
    // attempt on a guaranteed 403.
    const result = routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('routes a scoped key only to the model in its scope', () => {
    const [top, second] = googleModels();
    expect(second).toBeDefined();
    insertKey('google', 'scoped-key', [second!.model_id]);
    const result = routeRequest();
    expect(result.platform).toBe('google');
    expect(result.modelId).toBe(second!.model_id);
    expect(result.modelId).not.toBe(top!.model_id);
  });

  it('treats an empty or corrupt stored scope as unscoped', () => {
    insertKey('google', 'empty-scope', '[]');
    expect(routeRequest().modelId).toBe(googleModels()[0]!.model_id);

    getDb().prepare('DELETE FROM api_keys').run();
    insertKey('google', 'corrupt-scope', 'not json');
    expect(routeRequest().modelId).toBe(googleModels()[0]!.model_id);
  });

  describe('hasOtherUsableKey', () => {
    it('does not count a sibling scoped away from the model', () => {
      const top = googleModels()[0]!;
      const failedKeyId = insertKey('google', 'failed-key', null);
      insertKey('google', 'scoped-sibling', ['some-other-model']);
      // The only sibling can never serve this model, so the model IS exhausted
      // and the model-level penalty must not be suppressed (#454 gate).
      expect(hasOtherUsableKey(top.id, failedKeyId)).toBe(false);
    });

    it('counts a sibling whose scope includes the model', () => {
      const top = googleModels()[0]!;
      const failedKeyId = insertKey('google', 'failed-key', null);
      insertKey('google', 'in-scope-sibling', [top.model_id]);
      expect(hasOtherUsableKey(top.id, failedKeyId)).toBe(true);
    });

    it('counts an unscoped sibling (regression)', () => {
      const top = googleModels()[0]!;
      const failedKeyId = insertKey('google', 'failed-key', null);
      insertKey('google', 'unscoped-sibling', null);
      expect(hasOtherUsableKey(top.id, failedKeyId)).toBe(true);
    });
  });
});
