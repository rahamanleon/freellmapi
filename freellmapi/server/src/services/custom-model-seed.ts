import { tierValue, TIER_VALUE } from './scoring.js';
import type { Db } from '../db/types.js';

// ── Seeding a custom model's routing ranks (#488) ───────────────────────────
//
// A model registered against a user's own endpoint carries no catalog metadata:
// nobody has benchmarked "whatever bynara.id is proxying today". The old
// defaults answered that with the FLOOR — size_label 'Custom' (not a tier, so
// intelligenceComposite scores it below every real model) plus rank 50 — and
// the bandit's intelligence axis duly handed it 0. Every routing strategy
// except Manual then ignored the endpoint completely, which is exactly the
// complaint in #488: "all of the added models by custom providers have the same
// default weights … this makes them literally unusable with Routing Strategies".
//
// "Unknown" is not "worst", it is "no opinion", so seed at the catalog MEDIAN
// on each axis instead. A new custom model starts mid-pack, gets explored like
// anything else, and the bandit's own reliability/speed evidence moves it from
// there within a handful of requests. The operator can still tune the ranks by
// hand afterwards — re-registering the model never rewrites them.
//
// This is measured against the operator's LOCAL models table only. It reads no
// remote catalog and refreshes nothing: purely a starting point for the user's
// own endpoint.

export interface CustomModelSeed {
  sizeLabel: string;
  intelligenceRank: number;
  speedRank: number;
}

/** Used when there is no catalog to measure (fresh install, catalog cleared).
 *  Mid-tier and mid-rank, matching the historical numeric defaults but with a
 *  size_label the router can actually score. */
export const FALLBACK_CUSTOM_SEED: CustomModelSeed = {
  sizeLabel: 'Medium',
  intelligenceRank: 50,
  speedRank: 50,
};

/** Lower median: on an even-sized sample take the smaller of the two middles so
 *  the seed never over-claims a tier the catalog only half supports. */
function lowerMedian<T>(values: T[], rank: (value: T) => number): T | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => rank(a) - rank(b));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

interface CatalogRankRow {
  size_label: string;
  intelligence_rank: number;
  speed_rank: number;
}

/**
 * The intelligence/speed/tier a newly registered custom model should start at:
 * the median of the operator's catalog models. Custom rows are excluded so the
 * seed can't drift toward previously seeded custom models, and size labels the
 * router doesn't recognize are ignored when picking the median tier.
 */
export function customModelSeed(db: Db): CustomModelSeed {
  const rows = db.prepare(`
    SELECT size_label, intelligence_rank, speed_rank
      FROM models
     WHERE platform != 'custom'
  `).all() as CatalogRankRow[];

  if (rows.length === 0) return FALLBACK_CUSTOM_SEED;

  const tiered = rows.filter(r => r.size_label in TIER_VALUE);
  const medianTier = lowerMedian(tiered, r => tierValue(r.size_label));
  const medianIntelligence = lowerMedian(rows, r => r.intelligence_rank);
  const medianSpeed = lowerMedian(rows, r => r.speed_rank);

  return {
    sizeLabel: medianTier?.size_label ?? FALLBACK_CUSTOM_SEED.sizeLabel,
    intelligenceRank: medianIntelligence?.intelligence_rank ?? FALLBACK_CUSTOM_SEED.intelligenceRank,
    speedRank: medianSpeed?.speed_rank ?? FALLBACK_CUSTOM_SEED.speedRank,
  };
}
