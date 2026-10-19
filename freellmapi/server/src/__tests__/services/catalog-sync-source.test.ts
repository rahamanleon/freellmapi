import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { applyDeclarativeConfig } from '../../services/declarative-config.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// models.source is the provenance column that lets catalog-sync tell its own
// rows apart from rows the user created. These tests pin the whole contract:
// every write path stamps source honestly, sync still prunes stale catalog
// rows, and sync never deletes or clobbers a source='user' row — including on
// a platform:model_id collision, where the user row wins and the catalog
// entry is skipped.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

function baseModel(over: Partial<AnyCatalog['models'][number]> = {}): AnyCatalog['models'][number] {
  return {
    platform: 'groq',
    modelId: 'test-model',
    displayName: 'Test Model',
    intelligenceRank: 10,
    speedRank: 5,
    sizeLabel: 'Medium',
    limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
    monthlyTokenBudget: '~1M',
    contextWindow: 8192,
    enabled: true,
    supportsVision: false,
    supportsTools: true,
    ...over,
  };
}

function catalogOf(models: AnyCatalog['models']): AnyCatalog {
  return {
    version: '2099.01.01',
    generatedAt: new Date().toISOString(),
    tier: 'live',
    models,
    quirks: [],
  };
}

/** Snapshot every catalog-owned model as catalog entries so applyCatalog keeps them. */
function existingAsCatalogModels(): AnyCatalog['models'] {
  const rows = getDb()
    .prepare(
      `SELECT platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
              rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
              enabled, supports_vision, supports_tools
         FROM models WHERE source = 'catalog'`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) =>
    baseModel({
      platform: r.platform as string,
      modelId: r.model_id as string,
      displayName: r.display_name as string,
      intelligenceRank: r.intelligence_rank as number,
      speedRank: r.speed_rank as number,
      sizeLabel: r.size_label as string,
      limits: {
        rpm: r.rpm_limit as number | null,
        rpd: r.rpd_limit as number | null,
        tpm: r.tpm_limit as number | null,
        tpd: r.tpd_limit as number | null,
      },
      monthlyTokenBudget: r.monthly_token_budget as string,
      contextWindow: r.context_window as number | null,
      enabled: (r.enabled as number) === 1,
      supportsVision: (r.supports_vision as number) === 1,
      supportsTools: (r.supports_tools as number) === 1,
    }),
  );
}

function modelRow(platform: string, modelId: string): { id: number; display_name: string; source: string } | undefined {
  return getDb()
    .prepare('SELECT id, display_name, source FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number; display_name: string; source: string } | undefined;
}

describe('models.source provenance', () => {
  let app: Express;
  let dashToken = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  async function request(method: string, path: string, body?: unknown) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: data as any };
  }

  it('backfilled the bundled baseline as catalog-owned', () => {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS n FROM models WHERE source = 'catalog'")
      .get() as { n: number };
    expect(row.n).toBeGreaterThan(0);
  });

  it('catalog sync inserts new models with source=catalog', () => {
    const models = existingAsCatalogModels();
    models.push(baseModel({ modelId: 'provenance-new-model' }));
    applyCatalog(getDb(), catalogOf(models));
    expect(modelRow('groq', 'provenance-new-model')?.source).toBe('catalog');
  });

  it('declarative config stamps source=user on models it creates', () => {
    applyDeclarativeConfig({
      customProviders: [{
        baseUrl: 'http://127.0.0.1:9321/v1',
        apiKey: 'local-key',
        label: 'Prov Local',
        models: ['prov-local-chat'],
      }],
      models: [{
        platform: 'groq',
        modelId: 'prov-declarative-model',
        displayName: 'Declared By Hand',
        sizeLabel: 'Large', // deliberately NOT the 'User' convention
      }],
    });
    expect(modelRow('custom', 'prov-local-chat')?.source).toBe('user');
    expect(modelRow('groq', 'prov-declarative-model')?.source).toBe('user');
  });

  it('declarative patch of an existing catalog model keeps it catalog-owned', () => {
    const target = getDb()
      .prepare("SELECT platform, model_id FROM models WHERE source = 'catalog' AND platform = 'groq' ORDER BY id LIMIT 1")
      .get() as { platform: string; model_id: string };
    applyDeclarativeConfig({
      models: [{ platform: target.platform, modelId: target.model_id, displayName: 'Patched Name' }],
    });
    expect(modelRow(target.platform, target.model_id)?.source).toBe('catalog');
  });

  it('POST /api/keys/custom stamps source=user', async () => {
    const res = await request('POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:9322/v1',
      apiKey: 'k-' + 'a'.repeat(8),
      model: 'prov-endpoint-model',
    });
    expect(res.status).toBe(201);
    expect(modelRow('custom', 'prov-endpoint-model')?.source).toBe('user');
  });

  it('GET /api/models reports user rows as custom-sourced, catalog rows as catalog', async () => {
    const res = await request('GET', '/api/models');
    expect(res.status).toBe(200);
    const list = res.body as Array<{ platform: string; modelId: string; source: string }>;
    const declared = list.find((m) => m.modelId === 'prov-declarative-model');
    expect(declared?.source).toBe('custom');
    const catalogRow = list.find((m) => m.modelId === 'provenance-new-model');
    expect(catalogRow?.source).toBe('catalog');
  });

  it('sync prunes stale catalog rows but never user rows', () => {
    // The catalog no longer lists provenance-new-model, and it never listed the
    // user's rows. Only the catalog-owned row may be pruned.
    const models = existingAsCatalogModels().filter((m) => m.modelId !== 'provenance-new-model');
    const counts = applyCatalog(getDb(), catalogOf(models));

    expect(modelRow('groq', 'provenance-new-model')).toBeUndefined();
    expect(counts.removed).toBeGreaterThanOrEqual(1);
    // The declaratively-added native-platform model survives even though its
    // size_label ('Large') would have failed the old heuristic guard.
    expect(modelRow('groq', 'prov-declarative-model')?.source).toBe('user');
    expect(modelRow('custom', 'prov-local-chat')?.source).toBe('user');
    expect(modelRow('custom', 'prov-endpoint-model')?.source).toBe('user');
  });

  it('a user row colliding with a catalog id is not clobbered (user wins)', () => {
    const models = existingAsCatalogModels();
    // The catalog starts shipping the same platform:model_id the user declared.
    models.push(baseModel({ modelId: 'prov-declarative-model', displayName: 'Catalog Name', contextWindow: 999 }));
    applyCatalog(getDb(), catalogOf(models));

    const row = getDb()
      .prepare("SELECT display_name, context_window, source FROM models WHERE platform = 'groq' AND model_id = 'prov-declarative-model'")
      .get() as { display_name: string; context_window: number | null; source: string };
    expect(row.source).toBe('user');
    expect(row.display_name).toBe('Declared By Hand');
    expect(row.context_window).not.toBe(999);

    // And when the colliding entry leaves the catalog again, the user row stays.
    applyCatalog(getDb(), catalogOf(existingAsCatalogModels()));
    expect(modelRow('groq', 'prov-declarative-model')?.source).toBe('user');
  });
});
