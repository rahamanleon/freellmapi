import { getDb } from '../../db/index.js';

// Decision models only arrive through the catalog's `decisionModels` registry,
// so tests that exercise routing seed the two launch models in catalog order.
export const DECISION_MODELS = [
  { platform: 'cloudflare', modelId: '@cf/cloudflare/clef-flash', displayName: 'Clef Flash', quotaLabel: 'Workers AI free daily neurons', meta: { contextWindow: 24576 } },
  { platform: 'openrouter', modelId: 'inception/mercury-decide:free', displayName: 'Mercury Decide (free)', quotaLabel: 'Free model, 50 or 1,000 requests/day', meta: { contextWindow: 65536 } },
];

export function seedDecisionModels(): void {
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, 'decision', ?, 1, ?, ?)
  `);
  DECISION_MODELS.forEach((m, i) => insert.run(m.platform, m.modelId, m.displayName, i, m.quotaLabel, JSON.stringify(m.meta)));
}
