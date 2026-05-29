import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, isMongo, getApiKeysCollection } from '../db/index.js';
import { checkKeyHealth, checkAllKeys } from '../services/health.js';
import { hasProvider } from '../providers/index.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  let platforms: any[];
  let keys: any[];

  if (isMongo()) {
    const col = getApiKeysCollection();
    const agg = await col.aggregate([
      {
        $group: {
          _id: '$platform',
          total_keys: { $sum: 1 },
          healthy_keys: { $sum: { $cond: [{ $eq: ['$status', 'healthy'] }, 1, 0] } },
          rate_limited_keys: { $sum: { $cond: [{ $eq: ['$status', 'rate_limited'] }, 1, 0] } },
          invalid_keys: { $sum: { $cond: [{ $eq: ['$status', 'invalid'] }, 1, 0] } },
          error_keys: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
          unknown_keys: { $sum: { $cond: [{ $eq: ['$status', 'unknown'] }, 1, 0] } },
          enabled_keys: { $sum: { $cond: [{ $eq: ['$enabled', 1] }, 1, 0] } },
        },
      },
    ]).toArray();
    platforms = agg.map((p: any) => ({
      platform: p._id,
      totalKeys: p.total_keys,
      healthyKeys: p.healthy_keys,
      rateLimitedKeys: p.rate_limited_keys,
      invalidKeys: p.invalid_keys,
      errorKeys: p.error_keys,
      unknownKeys: p.unknown_keys,
      enabledKeys: p.enabled_keys,
    }));

    const allKeys = await col.find().sort({ platform: 1, created_at: -1 }).project({ _id: 1, platform: 1, label: 1, status: 1, enabled: 1, created_at: 1, last_checked_at: 1 }).toArray();
    keys = allKeys.map((k: any) => ({
      id: k._id.toString(), platform: k.platform, label: k.label,
      status: k.status, enabled: k.enabled === 1 || k.enabled === true,
      createdAt: k.created_at, lastCheckedAt: k.last_checked_at,
    }));
  } else {
    const db = getDb();
    platforms = db.prepare(`
      SELECT platform, COUNT(*) as total_keys,
             SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) as healthy_keys,
             SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_keys,
             SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid_keys,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_keys,
             SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) as unknown_keys,
             SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled_keys
      FROM api_keys GROUP BY platform
    `).all() as any[];

    keys = db.prepare(`
      SELECT id, platform, label, status, enabled, created_at, last_checked_at
      FROM api_keys ORDER BY platform, created_at DESC
    `).all() as any[];
  }

  res.json({
    platforms: platforms.map((p: any) => ({
      platform: p.platform,
      hasProvider: hasProvider(p.platform),
      totalKeys: p.totalKeys ?? p.total_keys,
      healthyKeys: p.healthyKeys ?? p.healthy_keys,
      rateLimitedKeys: p.rateLimitedKeys ?? p.rate_limited_keys,
      invalidKeys: p.invalidKeys ?? p.invalid_keys,
      errorKeys: p.errorKeys ?? p.error_keys,
      unknownKeys: p.unknownKeys ?? p.unknown_keys,
      enabledKeys: p.enabledKeys ?? p.enabled_keys,
    })),
    keys: keys.map((k: any) => ({
      id: k.id,
      platform: k.platform,
      label: k.label,
      status: k.status,
      enabled: typeof k.enabled === 'number' ? k.enabled === 1 : k.enabled === true,
      createdAt: k.created_at ?? k.createdAt,
      lastCheckedAt: k.last_checked_at ?? k.lastCheckedAt,
    })),
  });
});

healthRouter.post('/check/:keyId', async (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId as string, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const status = await checkKeyHealth(keyId);
  res.json({ keyId, status });
});

healthRouter.post('/check-all', async (_req: Request, res: Response) => {
  await checkAllKeys();
  res.json({ success: true });
});
