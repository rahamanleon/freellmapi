import { Router } from 'express';
import type { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { getDb, isMongo, getModelsCollection, getApiKeysCollection, getFallbackConfigCollection, getRequestsCollection } from '../db/index.js';
import { getAllPenalties } from '../services/router.js';

function toObjectId(id: string): any {
  if (/^[0-9a-fA-F]{24}$/.test(id)) return new ObjectId(id);
  return id;
}

export const fallbackRouter = Router();

fallbackRouter.get('/', async (_req: Request, res: Response) => {
  let rows: any[];
  let keyCounts: { platform: string; count: number }[];

  if (isMongo()) {
    const fcCol = getFallbackConfigCollection();
    const modelsCol = getModelsCollection();
    const keysCol = getApiKeysCollection();

    const fallbacks = await fcCol.find().sort({ priority: 1 }).toArray();
    rows = await Promise.all(fallbacks.map(async (fc: any) => {
      const model = await modelsCol.findOne({ _id: toObjectId(fc.model_db_id) });
      if (!model) return null;
      return {
        model_db_id: fc.model_db_id,
        priority: fc.priority,
        enabled: fc.enabled,
        platform: model.platform,
        model_id: model.model_id,
        display_name: model.display_name,
        intelligence_rank: model.intelligence_rank,
        speed_rank: model.speed_rank,
        size_label: model.size_label,
        rpm_limit: model.rpm_limit,
        rpd_limit: model.rpd_limit,
        monthly_token_budget: model.monthly_token_budget,
      };
    }));
    rows = rows.filter(Boolean);

    const keyAgg = await keysCol.aggregate([
      { $match: { enabled: 1 } },
      { $group: { _id: '$platform', count: { $sum: 1 } } },
    ]).toArray();
    keyCounts = keyAgg.map((k: any) => ({ platform: k._id, count: k.count }));
  } else {
    const db = getDb();
    rows = db.prepare(`
      SELECT fc.model_db_id, fc.priority, fc.enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
             m.monthly_token_budget
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      ORDER BY fc.priority ASC
    `).all() as any[];

    keyCounts = db.prepare(`
      SELECT platform, COUNT(*) as count FROM api_keys WHERE enabled = 1 GROUP BY platform
    `).all() as { platform: string; count: number }[];
  }

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));
  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  res.json(rows.map((r: any) => {
    const penalty = penaltyMap.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1 || r.enabled === true,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      monthlyTokenBudget: r.monthly_token_budget,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

fallbackRouter.put('/', async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  if (isMongo()) {
    const col = getFallbackConfigCollection();
    for (const entry of parsed.data) {
      await col.updateOne(
        { model_db_id: entry.modelDbId.toString() },
        { $set: { priority: entry.priority, enabled: entry.enabled ? 1 : 0 } },
      );
    }
  } else {
    const db = getDb();
    const update = db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?');
    const updateAll = db.transaction(() => {
      for (const entry of parsed.data) {
        update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
      }
    });
    updateAll();
  }

  res.json({ success: true });
});

const SORT_PRESETS: Record<string, any> = {
  intelligence: (isMongo() ? { intelligence_rank: 1 } : 'm.intelligence_rank ASC'),
  speed: (isMongo() ? { speed_rank: 1 } : 'm.speed_rank ASC'),
  budget: (isMongo()
    ? { monthly_token_budget: 1 }
    : "CASE m.monthly_token_budget WHEN '~120M' THEN 1 WHEN '~50-100M' THEN 2 WHEN '~30M' THEN 3 WHEN '~18-45M' THEN 4 WHEN '~18M' THEN 5 WHEN '~15M' THEN 6 WHEN '~12M' THEN 7 WHEN '~6M' THEN 8 WHEN '~5-10M' THEN 9 WHEN '~4M' THEN 10 ELSE 11 END ASC"),
};

fallbackRouter.post('/sort/:preset', async (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const orderBy = SORT_PRESETS[preset];
  if (!orderBy) {
    res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
    return;
  }

  if (isMongo()) {
    const modelsCol = getModelsCollection();
    const fcCol = getFallbackConfigCollection();

    const models = await modelsCol.find().sort(orderBy).project({ _id: 1 }).toArray();
    for (let i = 0; i < models.length; i++) {
      await fcCol.updateOne(
        { model_db_id: models[i]._id.toString() },
        { $set: { priority: i + 1 } },
        { upsert: true },
      );
    }
  } else {
    const db = getDb();
    const orderSql = orderBy as string;
    const models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderSql}`).all() as { id: number }[];

    const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
    const reorder = db.transaction(() => {
      for (let i = 0; i < models.length; i++) {
        update.run(i + 1, models[i].id);
      }
    });
    reorder();
  }

  res.json({ success: true, preset });
});

fallbackRouter.get('/token-usage', async (_req: Request, res: Response) => {
  let platforms: { platform: string }[];
  let models: any[];
  let usageRow: any;

  if (isMongo()) {
    const keysCol = getApiKeysCollection();
    const modelsCol = getModelsCollection();
    const fcCol = getFallbackConfigCollection();
    const reqCol = getRequestsCollection();

    const enabledKeys = await keysCol.distinct('platform', { enabled: 1 });
    platforms = enabledKeys.map((p: string) => ({ platform: p }));

    const fallbacks = await fcCol.find().sort({ priority: 1 }).toArray();
    models = [];
    for (const fb of fallbacks) {
      const model = await modelsCol.findOne({ _id: toObjectId(fb.model_db_id), enabled: 1 });
      if (model) {
        models.push({ platform: model.platform, model_id: model.model_id, display_name: model.display_name, monthly_token_budget: model.monthly_token_budget, priority: fb.priority });
      }
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const usageAgg = await reqCol.aggregate([
      { $match: { created_at: { $gte: startOfMonth } } },
      { $group: { _id: null, total_used: { $sum: { $add: ['$input_tokens', '$output_tokens'] } } } },
    ]).toArray();
    usageRow = { total_used: usageAgg[0]?.total_used ?? 0 };
  } else {
    const db = getDb();
    platforms = db.prepare(`
      SELECT DISTINCT ak.platform FROM api_keys ak WHERE ak.enabled = 1
    `).all() as { platform: string }[];

    models = db.prepare(`
      SELECT m.platform, m.model_id, m.display_name, m.monthly_token_budget, fc.priority
      FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.enabled = 1 ORDER BY fc.priority ASC
    `).all() as any[];

    usageRow = db.prepare(`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
      FROM requests WHERE created_at >= datetime('now', 'start of month')
    `).get() as any;
  }

  const platformSet = new Set(platforms.map(p => p.platform));

  function parseBudget(s: string): number {
    const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!m) return 0;
    const high = parseFloat(m[2] ?? m[1]);
    const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
    return high * unit;
  }

  const modelBudgets = models
    .filter((m: any) => platformSet.has(m.platform))
    .map((m: any) => ({
      displayName: m.display_name,
      platform: m.platform,
      budget: parseBudget(m.monthly_token_budget),
    }));

  const totalBudget = modelBudgets.reduce((s: number, m: any) => s + m.budget, 0);

  res.json({
    totalBudget,
    totalUsed: usageRow.total_used,
    models: modelBudgets,
  });
});
