import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { down, up } from '../../../db/migrations/20260726_000003_model_source_provenance.js';

// The models.source backfill decides which pre-existing rows catalog-sync is
// allowed to prune. Getting it wrong in the 'catalog' direction deletes
// user-added models on the next sync, so these tests pin the heuristic:
//  - custom platform / key-bound / 'User'/'Custom'-labelled rows -> 'user'
//  - rows the applied catalog (settings.catalog_applied_json) lists -> 'catalog'
//  - rows it does NOT list -> 'user' (sync would have pruned catalog leftovers)
//  - no applied catalog at all -> remaining rows are baseline seeds -> 'catalog'

function seededDb(): Database.Database {
  const db = new Database(':memory:');
  runLegacyBaseline(db);
  return db;
}

function insertModel(
  db: Database.Database,
  platform: string,
  modelId: string,
  over: { keyId?: number | null; sizeLabel?: string } = {},
): void {
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, key_id, enabled)
    VALUES (?, ?, ?, 50, 50, ?, ?, 1)
  `).run(platform, modelId, modelId, over.sizeLabel ?? 'Large', over.keyId ?? null);
}

function sourceOf(db: Database.Database, platform: string, modelId: string): string {
  const row = db
    .prepare('SELECT source FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { source: string };
  return row.source;
}

function setAppliedCatalog(db: Database.Database, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('catalog_applied_json', value);
}

describe('20260726_000003_model_source_provenance backfill', () => {
  it('marks custom-platform, key-bound and User/Custom-labelled rows as user', () => {
    const db = seededDb();
    try {
      insertModel(db, 'custom', 'my-endpoint-model', { sizeLabel: 'Custom' });
      insertModel(db, 'groq', 'key-bound-model', { keyId: 42 });
      insertModel(db, 'groq', 'declarative-default-label', { sizeLabel: 'User' });

      up(db);

      expect(sourceOf(db, 'custom', 'my-endpoint-model')).toBe('user');
      expect(sourceOf(db, 'groq', 'key-bound-model')).toBe('user');
      expect(sourceOf(db, 'groq', 'declarative-default-label')).toBe('user');
    } finally {
      db.close();
    }
  });

  it('keeps baseline seeds as catalog when no catalog was ever applied', () => {
    const db = seededDb();
    try {
      up(db);
      const counts = db.prepare(`
        SELECT SUM(CASE WHEN source = 'user' THEN 1 ELSE 0 END) AS user_rows,
               SUM(CASE WHEN source = 'catalog' THEN 1 ELSE 0 END) AS catalog_rows
          FROM models
      `).get() as { user_rows: number; catalog_rows: number };
      // A fresh install has only bundled-baseline rows: all catalog-owned.
      expect(counts.user_rows).toBe(0);
      expect(counts.catalog_rows).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('marks rows absent from the applied catalog as user, listed rows as catalog', () => {
    const db = seededDb();
    try {
      // Hand-added native-platform model whose size_label does NOT follow the
      // 'User'/'Custom' convention — exactly the row the old prune guard lost.
      insertModel(db, 'groq', 'hand-added-model', { sizeLabel: 'Large' });

      // Applied catalog = every baseline row except the hand-added one.
      const models = db
        .prepare("SELECT platform, model_id FROM models WHERE model_id != 'hand-added-model'")
        .all() as { platform: string; model_id: string }[];
      setAppliedCatalog(db, JSON.stringify({
        version: '2099.01.01',
        tier: 'live',
        models: models.map((m) => ({ platform: m.platform, modelId: m.model_id })),
        quirks: [],
      }));

      up(db);

      expect(sourceOf(db, 'groq', 'hand-added-model')).toBe('user');
      const listed = models[0]!;
      expect(sourceOf(db, listed.platform, listed.model_id)).toBe('catalog');
    } finally {
      db.close();
    }
  });

  it('survives a corrupt cached catalog and still applies the heuristics', () => {
    const db = seededDb();
    try {
      insertModel(db, 'custom', 'corrupt-cache-model', { sizeLabel: 'Custom' });
      setAppliedCatalog(db, 'not json {');

      expect(() => up(db)).not.toThrow();
      expect(sourceOf(db, 'custom', 'corrupt-cache-model')).toBe('user');
    } finally {
      db.close();
    }
  });

  it('down drops the column and up is re-runnable', () => {
    const db = seededDb();
    try {
      up(db);
      down(db);
      const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
      expect(columns.some((c) => c.name === 'source')).toBe(false);
      expect(() => up(db)).not.toThrow();
      expect(() => up(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
