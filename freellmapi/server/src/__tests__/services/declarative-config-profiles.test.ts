import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { applyDeclarativeConfig } from '../../services/declarative-config.js';
import { resolveRoutingChain } from '../../services/router.js';

/**
 * A model needs a row in BOTH fallback_config and profile_models to be routable:
 * once a profile is active the router reads profile_models. routes/keys.ts calls
 * ensureModelInProfiles after its chain insert; declarative config did not, so an
 * env-configured custom model showed up in the dashboard and was never selected.
 */
describe('declarative config keeps profile membership in sync', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    const db = getDb();
    // Children first: fallback_config and profile_models both reference models.id.
    db.prepare("DELETE FROM profile_models WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
    db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
    db.prepare('DELETE FROM api_keys').run();
  });

  function profileRowCount(modelDbId: number): number {
    return (getDb().prepare(
      'SELECT COUNT(*) AS n FROM profile_models WHERE model_db_id = ?',
    ).get(modelDbId) as { n: number }).n;
  }

  it('adds a declaratively-registered custom model to every profile', () => {
    const db = getDb();
    const profileCount = (db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n;
    expect(profileCount).toBeGreaterThan(0);

    applyDeclarativeConfig({
      customProviders: [{
        baseUrl: 'http://127.0.0.1:9124/v1',
        apiKey: 'local-key',
        label: 'Profile sync',
        models: [{ model: 'profile-sync-chat', displayName: 'Profile Sync Chat' }],
      }],
    });

    const model = db.prepare(
      "SELECT id FROM models WHERE platform = 'custom' AND model_id = 'profile-sync-chat'",
    ).get() as { id: number } | undefined;
    expect(model).toBeDefined();

    // Present in the chain...
    const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(model!.id);
    expect(inChain).toBeDefined();
    // ...and in every profile, which is what the router actually reads.
    expect(profileRowCount(model!.id)).toBe(profileCount);
  });

  it('makes the model reachable through the active profile chain', () => {
    const db = getDb();
    const profile = db.prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').get() as { id: number };
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(profile.id));

    applyDeclarativeConfig({
      customProviders: [{
        baseUrl: 'http://127.0.0.1:9125/v1',
        apiKey: 'local-key',
        label: 'Reachable',
        models: [{ model: 'reachable-chat', displayName: 'Reachable Chat' }],
      }],
    });

    // resolveRoutingChain('auto') goes through the same active-profile lookup the
    // proxy uses, so this asserts real reachability rather than table contents.
    const { chain } = resolveRoutingChain('auto');
    expect(chain.some(entry => entry.model_id === 'reachable-chat')).toBe(true);

    // The model must also be in the ACTIVE profile specifically, not just some profile.
    const model = db.prepare(
      "SELECT id FROM models WHERE platform = 'custom' AND model_id = 'reachable-chat'",
    ).get() as { id: number };
    const inActiveProfile = db.prepare(
      'SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?',
    ).get(profile.id, model.id);
    expect(inActiveProfile).toBeDefined();

    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
  });

  it('is idempotent — re-applying does not duplicate profile rows', () => {
    const config = {
      customProviders: [{
        baseUrl: 'http://127.0.0.1:9126/v1',
        apiKey: 'local-key',
        label: 'Idempotent',
        models: [{ model: 'idempotent-chat', displayName: 'Idempotent Chat' }],
      }],
    };

    applyDeclarativeConfig(config);
    applyDeclarativeConfig(config);

    const model = getDb().prepare(
      "SELECT id FROM models WHERE platform = 'custom' AND model_id = 'idempotent-chat'",
    ).get() as { id: number };
    const profileCount = (getDb().prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n;

    expect(profileRowCount(model.id)).toBe(profileCount);
  });
});
