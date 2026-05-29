import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, isMongo, getModelsCollection, getApiKeysCollection, getFallbackConfigCollection } from '../db/index.js';
import { hasProvider } from '../providers/index.js';

export const modelsRouter = Router();

modelsRouter.get('/', async (_req: Request, res: Response) => {
  let models: any[];
  let keyCounts: { platform: string; count: number }[];

  if (isMongo()) {
    const modelsCol = getModelsCollection();
    const fallbackCol = getFallbackConfigCollection();
    const keysCol = getApiKeysCollection();

    const fallbacks = await fallbackCol.find().sort({ priority: 1 }).toArray();
    const fbMap = new Map(fallbacks.map((f: any) => [parseInt(f.model_db_id, 10) || f.model_db_id, f]));

    const allModels = await modelsCol.find().toArray();
    models = allModels.map((m: any) => {
      const fb = fbMap.get(m._id.toString()) || fbMap.get(m._id);
      return {
        ...m,
        priority: fb?.priority ?? m.intelligence_rank,
        fallback_enabled: fb?.enabled ?? 1,
      };
    });
    models.sort((a: any, b: any) => (a.priority ?? a.intelligence_rank) - (b.priority ?? b.intelligence_rank));

    const keyAgg = await keysCol.aggregate([
      { $match: { enabled: 1 } },
      { $group: { _id: '$platform', count: { $sum: 1 } } },
    ]).toArray();
    keyCounts = keyAgg.map((k: any) => ({ platform: k._id, count: k.count }));
  } else {
    const db = getDb();
    models = db.prepare(`
      SELECT m.*, fc.priority, fc.enabled as fallback_enabled
      FROM models m
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
    `).all() as any[];

    keyCounts = db.prepare(`
      SELECT platform, COUNT(*) as count FROM api_keys WHERE enabled = 1 GROUP BY platform
    `).all() as { platform: string; count: number }[];
  }

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map((m: any) => ({
    id: m.id ?? m._id?.toString(),
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1 || m.enabled === true,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1 || m.fallback_enabled === true,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});
