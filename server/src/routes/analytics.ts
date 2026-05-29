import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, isMongo, getRequestsCollection, getModelsCollection } from '../db/index.js';

export const analyticsRouter = Router();

function getSinceTimestamp(range: string): string {
  const now = Date.now();
  switch (range) {
    case '24h': return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    case '30d': return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    case '7d':
    default: return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

async function getSummaryMongo(since: string) {
  const col = getRequestsCollection();
  const sinceDate = new Date(since);
  const match = { created_at: { $gte: sinceDate.toISOString() } };

  const stats = await col.aggregate([
    { $match: { created_at: { $gte: sinceDate.toISOString() } } },
    {
      $group: {
        _id: null,
        total_requests: { $sum: 1 },
        success_count: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
        total_input_tokens: { $sum: { $ifNull: ['$input_tokens', 0] } },
        total_output_tokens: { $sum: { $ifNull: ['$output_tokens', 0] } },
        avg_latency_ms: { $avg: { $ifNull: ['$latency_ms', 0] } },
      },
    },
  ]).toArray();

  return stats[0] ?? { total_requests: 0, success_count: 0, total_input_tokens: 0, total_output_tokens: 0, avg_latency_ms: 0 };
}

analyticsRouter.get('/summary', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);

  let stats: any;
  if (isMongo()) {
    stats = await getSummaryMongo(since);
  } else {
    const db = getDb();
    stats = db.prepare(`
      SELECT COUNT(*) as total_requests,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
             SUM(input_tokens) as total_input_tokens,
             SUM(output_tokens) as total_output_tokens,
             AVG(latency_ms) as avg_latency_ms
      FROM requests WHERE created_at >= ?
    `).get(since) as any;
  }

  const totalRequests = stats.total_requests ?? 0;
  const successRate = totalRequests > 0 ? (stats.success_count / totalRequests) * 100 : 0;
  const totalTokens = (stats.total_input_tokens ?? 0) + (stats.total_output_tokens ?? 0);
  const inputCost = ((stats.total_input_tokens ?? 0) / 1_000_000) * 3;
  const outputCost = ((stats.total_output_tokens ?? 0) / 1_000_000) * 15;

  res.json({
    totalRequests,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens: stats.total_input_tokens ?? 0,
    totalOutputTokens: stats.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(stats.avg_latency_ms ?? 0),
    estimatedCostSavings: Math.round((inputCost + outputCost) * 100) / 100,
  });
});

analyticsRouter.get('/by-model', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);

  let rows: any[];
  if (isMongo()) {
    const col = getRequestsCollection();
    const modelsCol = getModelsCollection();
    const sinceDate = since;
    const agg = await col.aggregate([
      { $match: { created_at: { $gte: sinceDate } } },
      {
        $group: {
          _id: { platform: '$platform', model_id: '$model_id' },
          requests: { $sum: 1 },
          success_count: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          avg_latency_ms: { $avg: { $ifNull: ['$latency_ms', 0] } },
          total_input_tokens: { $sum: { $ifNull: ['$input_tokens', 0] } },
          total_output_tokens: { $sum: { $ifNull: ['$output_tokens', 0] } },
        },
      },
      { $sort: { requests: -1 } },
    ]).toArray();

    rows = await Promise.all(agg.map(async (r: any) => {
      const model = await modelsCol.findOne({ platform: r._id.platform, model_id: r._id.model_id });
      return {
        platform: r._id.platform,
        model_id: r._id.model_id,
        display_name: model?.display_name ?? r._id.model_id,
        requests: r.requests,
        success_rate: (r.success_count / r.requests) * 100,
        avg_latency_ms: r.avg_latency_ms,
        total_input_tokens: r.total_input_tokens,
        total_output_tokens: r.total_output_tokens,
      };
    }));
  } else {
    const db = getDb();
    rows = db.prepare(`
      SELECT r.platform, r.model_id, m.display_name,
             COUNT(*) as requests,
             SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
             AVG(r.latency_ms) as avg_latency_ms,
             SUM(r.input_tokens) as total_input_tokens,
             SUM(r.output_tokens) as total_output_tokens
      FROM requests r
      LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
      WHERE r.created_at >= ?
      GROUP BY r.platform, r.model_id
      ORDER BY requests DESC
    `).all(since) as any[];
  }

  res.json(rows.map((r: any) => ({
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

analyticsRouter.get('/by-platform', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);

  let rows: any[];
  if (isMongo()) {
    const col = getRequestsCollection();
    const agg = await col.aggregate([
      { $match: { created_at: { $gte: since } } },
      {
        $group: {
          _id: '$platform',
          requests: { $sum: 1 },
          success_count: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          avg_latency_ms: { $avg: { $ifNull: ['$latency_ms', 0] } },
          total_input_tokens: { $sum: { $ifNull: ['$input_tokens', 0] } },
          total_output_tokens: { $sum: { $ifNull: ['$output_tokens', 0] } },
        },
      },
      { $sort: { requests: -1 } },
    ]).toArray();
    rows = agg.map((r: any) => ({
      platform: r._id,
      requests: r.requests,
      success_rate: (r.success_count / r.requests) * 100,
      avg_latency_ms: r.avg_latency_ms,
      total_input_tokens: r.total_input_tokens,
      total_output_tokens: r.total_output_tokens,
    }));
  } else {
    const db = getDb();
    rows = db.prepare(`
      SELECT platform, COUNT(*) as requests,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
             AVG(latency_ms) as avg_latency_ms,
             SUM(input_tokens) as total_input_tokens,
             SUM(output_tokens) as total_output_tokens
      FROM requests WHERE created_at >= ?
      GROUP BY platform ORDER BY requests DESC
    `).all(since) as any[];
  }

  res.json(rows.map((r: any) => ({
    platform: r.platform,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

analyticsRouter.get('/timeline', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const interval = (req.query.interval as string) ?? (range === '24h' ? 'hour' : 'day');
  const since = getSinceTimestamp(range);

  let rows: any[];
  if (isMongo()) {
    const col = getRequestsCollection();
    const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';
    const groupId: any = interval === 'hour'
      ? { $dateToString: { format: '%Y-%m-%dT%H:00:00', date: { $dateFromString: { dateString: '$created_at' } } } }
      : { $dateToString: { format: '%Y-%m-%d', date: { $dateFromString: { dateString: '$created_at' } } } };
    const agg = await col.aggregate([
      { $match: { created_at: { $gte: since } } },
      { $group: { _id: groupId, requests: { $sum: 1 }, success_count: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } }, failure_count: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    rows = agg.map((r: any) => ({ timestamp: r._id, requests: r.requests, success_count: r.success_count, failure_count: r.failure_count }));
  } else {
    const db = getDb();
    const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';
    rows = db.prepare(`
      SELECT strftime('${dateFormat}', created_at) as timestamp,
             COUNT(*) as requests,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
             SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failure_count
      FROM requests WHERE created_at >= ?
      GROUP BY strftime('${dateFormat}', created_at) ORDER BY timestamp ASC
    `).all(since) as any[];
  }

  res.json(rows.map((r: any) => ({
    timestamp: r.timestamp,
    requests: r.requests,
    successCount: r.success_count,
    failureCount: r.failure_count,
  })));
});

analyticsRouter.get('/error-distribution', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);

  let byCategory: any[];
  let byPlatform: any[];
  let detailed: any[];

  if (isMongo()) {
    const col = getRequestsCollection();
    const match = { status: 'error', created_at: { $gte: since } };

    const errorMap = [
      { pattern: '429', label: 'Rate Limited (429)' },
      { pattern: 'rate limit', label: 'Rate Limited (429)' },
      { pattern: 'too many', label: 'Rate Limited (429)' },
      { pattern: 'quota', label: 'Rate Limited (429)' },
      { pattern: '401', label: 'Auth Error (401)' },
      { pattern: 'unauthorized', label: 'Auth Error (401)' },
      { pattern: 'invalid.*key', label: 'Auth Error (401)' },
      { pattern: '403', label: 'Forbidden (403)' },
      { pattern: 'forbidden', label: 'Forbidden (403)' },
      { pattern: '404', label: 'Not Found (404)' },
      { pattern: 'not found', label: 'Not Found (404)' },
      { pattern: 'timeout', label: 'Timeout/Connection' },
      { pattern: 'etimedout', label: 'Timeout/Connection' },
      { pattern: 'econnrefused', label: 'Timeout/Connection' },
      { pattern: '500', label: 'Server Error (500)' },
      { pattern: 'internal server', label: 'Server Error (500)' },
      { pattern: '503', label: 'Unavailable (503)' },
      { pattern: 'unavailable', label: 'Unavailable (503)' },
    ];

    const errors = await col.find(match).project({ platform: 1, model_id: 1, error: 1 }).toArray();
    const categorized = errors.map((e: any) => {
      const errLower = (e.error ?? '').toLowerCase();
      const cat = errorMap.find(em => errLower.includes(em.pattern));
      return { ...e, category: cat?.label ?? 'Other' };
    });

    const catMap = new Map<string, number>();
    const platMap = new Map<string, number>();
    for (const c of categorized) {
      catMap.set(c.category, (catMap.get(c.category) ?? 0) + 1);
      platMap.set(c.platform, (platMap.get(c.platform) ?? 0) + 1);
    }
    byCategory = [...catMap.entries()].map(([category, count]) => ({ category, count }));
    byPlatform = [...platMap.entries()].map(([platform, count]) => ({ platform, count }));
    detailed = categorized.map((c: any) => ({ platform: c.platform, model_id: c.model_id, error: c.error, error_category: c.category }));
  } else {
    const db = getDb();
    byCategory = db.prepare(`
      SELECT CASE WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
                  WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
                  WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
                  WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
                  WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
                  WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
                  WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
                  ELSE 'Other' END as category, COUNT(*) as count
      FROM requests WHERE status = 'error' AND created_at >= ?
      GROUP BY category ORDER BY count DESC
    `).all(since) as any[];

    byPlatform = db.prepare(`
      SELECT platform, COUNT(*) as count FROM requests
      WHERE status = 'error' AND created_at >= ? GROUP BY platform ORDER BY count DESC
    `).all(since) as any[];

    detailed = db.prepare(`
      SELECT platform, model_id, error,
             CASE WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
                  WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
                  WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
                  WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
                  WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
                  WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
                  WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
                  ELSE 'Other' END as error_category
      FROM requests WHERE status = 'error' AND created_at >= ?
      ORDER BY created_at DESC
    `).all(since) as any[];
  }

  res.json({ byCategory, byPlatform, detailed });
});

analyticsRouter.get('/errors', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);

  let rows: any[];
  if (isMongo()) {
    const col = getRequestsCollection();
    const docs = await col.find({ status: 'error', created_at: { $gte: since } })
      .sort({ created_at: -1 })
      .limit(50)
      .project({ _id: 1, platform: 1, model_id: 1, error: 1, latency_ms: 1, created_at: 1 })
      .toArray();
    rows = docs.map((d: any) => ({ id: d._id.toString(), platform: d.platform, model_id: d.model_id, error: d.error, latency_ms: d.latency_ms, created_at: d.created_at }));
  } else {
    const db = getDb();
    rows = db.prepare(`
      SELECT id, platform, model_id, error, latency_ms, created_at
      FROM requests WHERE status = 'error' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 50
    `).all(since) as any[];
  }

  res.json(rows.map((r: any) => ({
    id: r.id, platform: r.platform, modelId: r.model_id,
    error: r.error, latencyMs: r.latency_ms, createdAt: r.created_at,
  })));
});
