import { ObjectId } from 'mongodb';
import { getDb, isMongo, getModelsCollection, getApiKeysCollection, getFallbackConfigCollection } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import type { BaseProvider } from '../providers/base.js';

interface ModelRow {
  id: string;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
}

interface KeyRow {
  id: string;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
}

interface FallbackRow {
  model_db_id: string;
  priority: number;
  enabled: number;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: string;
  apiKey: string;
  keyId: string;
  platform: string;
  displayName: string;
}

const roundRobinIndex = new Map<string, number>();
const rateLimitPenalties = new Map<string, { count: number; lastHit: number; penalty: number }>();
const PENALTY_PER_429 = 3;
const MAX_PENALTY = 10;
const DECAY_INTERVAL_MS = 2 * 60 * 1000;
const DECAY_AMOUNT = 1;

export function recordRateLimitHit(modelDbId: string) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

export function recordSuccess(modelDbId: string) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

function getPenalty(modelDbId: string): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now;
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }
  return entry.penalty;
}

export function getAllPenalties(): Array<{ modelDbId: string; count: number; penalty: number }> {
  const result: Array<{ modelDbId: string; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

async function getFallbackChainMongo(): Promise<FallbackRow[]> {
  const col = getFallbackConfigCollection();
  return col.find().sort({ priority: 1 }).map(doc => ({
    model_db_id: String(doc.model_db_id),
    priority: doc.priority,
    enabled: doc.enabled,
  })).toArray();
}

async function getModelMongo(modelDbId: string): Promise<ModelRow | null> {
  const col = getModelsCollection();
  let filter: any;
  if (/^[0-9a-fA-F]{24}$/.test(modelDbId)) {
    filter = { _id: new ObjectId(modelDbId) };
  } else {
    filter = { _id: modelDbId as any };
  }
  const doc = await col.findOne(filter);
  if (!doc || !doc.enabled) return null;
  return {
    id: String(doc._id),
    platform: doc.platform,
    model_id: doc.model_id,
    display_name: doc.display_name,
    rpm_limit: doc.rpm_limit ?? null,
    rpd_limit: doc.rpd_limit ?? null,
    tpm_limit: doc.tpm_limit ?? null,
    tpd_limit: doc.tpd_limit ?? null,
  };
}

async function getKeysForPlatformMongo(platform: string): Promise<KeyRow[]> {
  const col = getApiKeysCollection();
  const docs = await col.find({ platform, enabled: 1, status: { $in: ['healthy', 'unknown'] } }).toArray();
  return docs.map(d => ({
    id: String(d._id),
    platform: d.platform,
    encrypted_key: d.encrypted_key,
    iv: d.iv,
    auth_tag: d.auth_tag,
    status: d.status,
    enabled: d.enabled,
  }));
}

export async function routeRequest(estimatedTokens = 1000, skipKeys?: Set<string>, preferredModelDbId?: string): Promise<RouteResult> {
  let fallbackChain: FallbackRow[];

  if (isMongo()) {
    fallbackChain = await getFallbackChainMongo();
  } else {
    const db = getDb();
    fallbackChain = db.prepare(`
      SELECT fc.model_db_id, fc.priority, fc.enabled
      FROM fallback_config fc
      ORDER BY fc.priority ASC
    `).all() as FallbackRow[];
    fallbackChain = fallbackChain.map(f => ({ ...f, model_db_id: String(f.model_db_id) }));
  }

  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
  })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  }

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;

    let model: ModelRow | null;
    if (isMongo()) {
      model = await getModelMongo(entry.model_db_id);
    } else {
      const db = getDb();
      const row = db.prepare('SELECT * FROM models WHERE id = ? AND enabled = 1').get(parseInt(entry.model_db_id, 10)) as any;
      if (!row) continue;
      model = {
        id: String(row.id),
        platform: row.platform,
        model_id: row.model_id,
        display_name: row.display_name,
        rpm_limit: row.rpm_limit,
        rpd_limit: row.rpd_limit,
        tpm_limit: row.tpm_limit,
        tpd_limit: row.tpd_limit,
      };
    }
    if (!model) continue;

    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    let keys: KeyRow[];
    if (isMongo()) {
      keys = await getKeysForPlatformMongo(model.platform);
    } else {
      const db = getDb();
      keys = (db.prepare(
        "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')"
      ).all(model.platform) as any[]).map((k: any) => ({
        id: String(k.id),
        platform: k.platform,
        encrypted_key: k.encrypted_key,
        iv: k.iv,
        auth_tag: k.auth_tag,
        status: k.status,
        enabled: k.enabled,
      }));
    }

    if (keys.length === 0) continue;

    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    const rrKey = `${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;

      if (await isOnCooldown(model.platform, model.model_id, key.id)) continue;
      if (!(await canMakeRequest(model.platform, model.model_id, key.id, limits))) continue;
      if (!(await canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits))) continue;

      let decryptedKey: string;
      try {
        decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
      } catch {
        if (!isMongo()) {
          const db = getDb();
          db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?")
            .run(parseInt(String(key.id), 10));
        } else {
          await getApiKeysCollection().updateOne(
            { _id: key.id as any },
            { $set: { status: 'error', last_checked_at: new Date().toISOString() } },
          );
        }
        continue;
      }

      roundRobinIndex.set(rrKey, idx);
      return {
        provider,
        modelId: model.model_id,
        modelDbId: model.id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: model.platform,
        displayName: model.display_name,
      };
    }

    roundRobinIndex.set(rrKey, idx);
  }

  const err = new Error('All models exhausted. Add more API keys or wait for rate limits to reset.') as any;
  err.status = 429;
  throw err;
}
