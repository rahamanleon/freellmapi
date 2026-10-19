import { getDb } from '../../db/index.js';

// Search engines only ever arrive through the catalog's `searchEngines`
// registry (nothing is bundled), so tests that exercise routing seed the four
// engines the catalog publishes, in its priority order.
const ENGINES = [
  { platform: 'tavily', engineId: 'tavily-search', displayName: 'Tavily Search', quotaLabel: '1,000 credits/month, no card', meta: { creditsPerQuery: 1, features: { news: true, answer: true, fullContent: false } } },
  { platform: 'exa', engineId: 'exa-search', displayName: 'Exa Search', quotaLabel: '$10/month in credits', meta: { creditsPerQuery: null, features: { news: true, answer: false, fullContent: true } } },
  { platform: 'firecrawl', engineId: 'firecrawl-search', displayName: 'Firecrawl Search', quotaLabel: '1,000 credits/month, no card', meta: { creditsPerQuery: 2, features: { news: true, answer: false, fullContent: true } } },
  { platform: 'linkup', engineId: 'linkup-search', displayName: 'Linkup Search', quotaLabel: '€5/month in credits', meta: { creditsPerQuery: 1, features: { news: false, answer: true, fullContent: false } } },
];

export function seedSearchEngines(): void {
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, 'search', ?, 1, ?, ?)
  `);
  ENGINES.forEach((e, i) => insert.run(e.platform, e.engineId, e.displayName, i, e.quotaLabel, JSON.stringify(e.meta)));
}
