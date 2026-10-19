import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { customModelSeed, FALLBACK_CUSTOM_SEED } from '../../services/custom-model-seed.js';

// #488: a freshly registered custom model used to land at size_label 'Custom'
// (tier 0 — below every catalog tier) and rank 50, so the bandit's intelligence
// axis scored it 0 and it lost every auto-route. Seed at the catalog MEDIAN
// instead: we know nothing about the model, so start it in the middle.

function seedCatalog(rows: Array<{ label: string; intel: number; speed: number }>) {
  const db = getDb();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM models').run();
  const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled)
    VALUES ('groq', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '', 1)
  `);
  rows.forEach((r, i) => insert.run(`m${i}`, `M${i}`, r.intel, r.speed, r.label));
}

describe('customModelSeed (#488)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('seeds at the catalog median on every axis', () => {
    seedCatalog([
      { label: 'Small', intel: 1, speed: 1 },
      { label: 'Medium', intel: 5, speed: 3 },
      { label: 'Large', intel: 9, speed: 7 },
      { label: 'Frontier', intel: 20, speed: 40 },
      { label: 'Frontier', intel: 30, speed: 50 },
    ]);
    expect(customModelSeed(getDb())).toEqual({ sizeLabel: 'Large', intelligenceRank: 9, speedRank: 7 });
  });

  it('takes the lower median on an even-sized catalog so it never over-claims', () => {
    seedCatalog([
      { label: 'Small', intel: 2, speed: 2 },
      { label: 'Medium', intel: 4, speed: 4 },
      { label: 'Large', intel: 6, speed: 6 },
      { label: 'Frontier', intel: 8, speed: 8 },
    ]);
    expect(customModelSeed(getDb())).toEqual({ sizeLabel: 'Medium', intelligenceRank: 4, speedRank: 4 });
  });

  it('ignores custom rows so the seed cannot drift toward itself', () => {
    seedCatalog([
      { label: 'Large', intel: 10, speed: 10 },
      { label: 'Large', intel: 10, speed: 10 },
      { label: 'Large', intel: 10, speed: 10 },
    ]);
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                          rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled)
      VALUES ('custom', 'relay-x', 'relay-x', 999, 999, 'Custom', NULL, NULL, NULL, NULL, '', 1)
    `).run();
    expect(customModelSeed(getDb())).toEqual({ sizeLabel: 'Large', intelligenceRank: 10, speedRank: 10 });
  });

  it('ignores unrecognized size labels when picking the median tier', () => {
    seedCatalog([
      { label: 'Mystery', intel: 3, speed: 3 },
      { label: 'Mystery', intel: 3, speed: 3 },
      { label: 'Small', intel: 3, speed: 3 },
    ]);
    expect(customModelSeed(getDb()).sizeLabel).toBe('Small');
  });

  it('falls back to a neutral seed with no catalog to measure', () => {
    getDb().prepare('DELETE FROM fallback_config').run();
    getDb().prepare('DELETE FROM models').run();
    expect(customModelSeed(getDb())).toEqual(FALLBACK_CUSTOM_SEED);
  });
});
