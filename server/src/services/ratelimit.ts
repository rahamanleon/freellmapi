import { getDb, isMongo, getRateLimitUsageCollection, getRateLimitCooldownsCollection } from '../db/index.js';

interface Window {
  timestamps: number[];
  tokenCount: number;
  tokenTimestamps: { ts: number; tokens: number }[];
}

const windows = new Map<string, Window>();

function getWindow(key: string): Window {
  let w = windows.get(key);
  if (!w) {
    w = { timestamps: [], tokenCount: 0, tokenTimestamps: [] };
    windows.set(key, w);
  }
  return w;
}

function pruneTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter(ts => ts > cutoff);
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

async function recordUsageMongo(platform: string, modelId: string, keyId: string | number, kind: 'request' | 'tokens', tokens: number, now: number) {
  try {
    const col = getRateLimitUsageCollection();
    await col.insertOne({ platform, model_id: modelId, key_id: keyId, kind, tokens, created_at_ms: now });
    await col.deleteMany({ created_at_ms: { $lte: now - DAY } });
  } catch { /* best-effort */ }
}

function recordUsageSqlite(platform: string, modelId: string, keyId: string | number, kind: 'request' | 'tokens', tokens: number, now: number) {
  try {
    const db = getDb();
    const kid = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    db.prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, kid, kind, tokens, now);
    db.prepare('DELETE FROM rate_limit_usage WHERE created_at_ms <= ?').run(now - DAY);
  } catch { /* best-effort */ }
}

function countPersistedRequestsSqlite(platform: string, modelId: string, keyId: string | number, windowMs: number, now: number): number | undefined {
  try {
    const db = getDb();
    const kid = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    const row = db.prepare(`
      SELECT COUNT(*) AS used FROM rate_limit_usage
       WHERE platform = ? AND model_id = ? AND key_id = ? AND kind = 'request' AND created_at_ms > ?
    `).get(platform, modelId, kid, now - windowMs) as { used: number };
    return row.used;
  } catch {
    return undefined;
  }
}

async function countPersistedRequestsMongo(platform: string, modelId: string, keyId: string | number, windowMs: number, now: number): Promise<number | undefined> {
  try {
    const col = getRateLimitUsageCollection();
    return await col.countDocuments({
      platform, model_id: modelId, key_id: keyId, kind: 'request',
      created_at_ms: { $gt: now - windowMs },
    });
  } catch {
    return undefined;
  }
}

function sumPersistedTokensSqlite(platform: string, modelId: string, keyId: string | number, windowMs: number, now: number): number | undefined {
  try {
    const db = getDb();
    const kid = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    const row = db.prepare(`
      SELECT COALESCE(SUM(tokens), 0) AS used FROM rate_limit_usage
       WHERE platform = ? AND model_id = ? AND key_id = ? AND kind = 'tokens' AND created_at_ms > ?
    `).get(platform, modelId, kid, now - windowMs) as { used: number };
    return row.used;
  } catch {
    return undefined;
  }
}

async function sumPersistedTokensMongo(platform: string, modelId: string, keyId: string | number, windowMs: number, now: number): Promise<number | undefined> {
  try {
    const col = getRateLimitUsageCollection();
    const agg = await col.aggregate([
      { $match: { platform, model_id: modelId, key_id: keyId, kind: 'tokens', created_at_ms: { $gt: now - windowMs } } },
      { $group: { _id: null, used: { $sum: '$tokens' } } },
    ]).toArray();
    return agg.length > 0 ? agg[0].used : 0;
  } catch {
    return undefined;
  }
}

function memoryRequestCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.timestamps = pruneTimestamps(w.timestamps, windowMs, now);
  return w.timestamps.length;
}

function memoryTokenCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - windowMs);
  return w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
}

async function requestCount(platform: string, modelId: string, keyId: string | number, windowMs: number, now: number): Promise<number> {
  if (isMongo()) {
    const persisted = await countPersistedRequestsMongo(platform, modelId, keyId, windowMs, now);
    if (persisted !== undefined) return persisted;
  } else {
    const persisted = countPersistedRequestsSqlite(platform, modelId, keyId, windowMs, now);
    if (persisted !== undefined) return persisted;
  }
  const type = windowMs === MINUTE ? 'rpm' : 'rpd';
  return memoryRequestCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

async function tokenCount(platform: string, modelId: string, keyId: string | number, windowMs: number, now: number): Promise<number> {
  if (isMongo()) {
    const persisted = await sumPersistedTokensMongo(platform, modelId, keyId, windowMs, now);
    if (persisted !== undefined) return persisted;
  } else {
    const persisted = sumPersistedTokensSqlite(platform, modelId, keyId, windowMs, now);
    if (persisted !== undefined) return persisted;
  }
  const type = windowMs === MINUTE ? 'tpm' : 'tpd';
  return memoryTokenCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

export async function canMakeRequest(
  platform: string,
  modelId: string,
  keyId: string | number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): Promise<boolean> {
  const now = Date.now();

  if (limits.rpm !== null) {
    if (await requestCount(platform, modelId, keyId, MINUTE, now) >= limits.rpm) return false;
  }

  if (limits.rpd !== null) {
    if (await requestCount(platform, modelId, keyId, DAY, now) >= limits.rpd) return false;
  }

  return true;
}

export async function canUseTokens(
  platform: string,
  modelId: string,
  keyId: string | number,
  estimatedTokens: number,
  limits: { tpm: number | null; tpd: number | null },
): Promise<boolean> {
  const now = Date.now();

  if (limits.tpm !== null) {
    const used = await tokenCount(platform, modelId, keyId, MINUTE, now);
    if (used + estimatedTokens > limits.tpm) return false;
  }

  if (limits.tpd !== null) {
    const used = await tokenCount(platform, modelId, keyId, DAY, now);
    if (used + estimatedTokens > limits.tpd) return false;
  }

  return true;
}

export async function recordRequest(platform: string, modelId: string, keyId: string | number) {
  const now = Date.now();

  const rpmKey = `${platform}:${modelId}:${keyId}:rpm`;
  getWindow(rpmKey).timestamps.push(now);

  const rpdKey = `${platform}:${modelId}:${keyId}:rpd`;
  getWindow(rpdKey).timestamps.push(now);

  if (isMongo()) {
    await recordUsageMongo(platform, modelId, keyId, 'request', 0, now);
  } else {
    recordUsageSqlite(platform, modelId, keyId, 'request', 0, now);
  }
}

export async function recordTokens(platform: string, modelId: string, keyId: string | number, tokens: number) {
  const now = Date.now();

  const tpmKey = `${platform}:${modelId}:${keyId}:tpm`;
  getWindow(tpmKey).tokenTimestamps.push({ ts: now, tokens });

  const tpdKey = `${platform}:${modelId}:${keyId}:tpd`;
  getWindow(tpdKey).tokenTimestamps.push({ ts: now, tokens });

  if (isMongo()) {
    await recordUsageMongo(platform, modelId, keyId, 'tokens', tokens, now);
  } else {
    recordUsageSqlite(platform, modelId, keyId, 'tokens', tokens, now);
  }
}

// Cooldown
const cooldowns = new Map<string, number>();
const cooldownHits = new Map<string, number[]>();
const HOUR = 60 * MINUTE;
const COOLDOWN_DURATIONS = [
  2 * MINUTE,
  10 * MINUTE,
  HOUR,
  DAY,
];

export function getNextCooldownDuration(platform: string, modelId: string, keyId: string | number): number {
  const key = `${platform}:${modelId}:${keyId}`;
  const now = Date.now();
  const hits = (cooldownHits.get(key) ?? []).filter(t => t > now - DAY);
  hits.push(now);
  cooldownHits.set(key, hits);
  const idx = Math.min(hits.length - 1, COOLDOWN_DURATIONS.length - 1);
  return COOLDOWN_DURATIONS[idx]!;
}

async function persistedCooldownExpiryMongo(platform: string, modelId: string, keyId: string | number): Promise<number | null> {
  try {
    const col = getRateLimitCooldownsCollection();
    const doc = await col.findOne({ platform, model_id: modelId, key_id: keyId });
    return doc?.expires_at_ms ?? null;
  } catch {
    return null;
  }
}

function persistedCooldownExpirySqlite(platform: string, modelId: string, keyId: string | number): number | null {
  try {
    const db = getDb();
    const kid = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    const row = db.prepare(`
      SELECT expires_at_ms FROM rate_limit_cooldowns
       WHERE platform = ? AND model_id = ? AND key_id = ?
    `).get(platform, modelId, kid) as { expires_at_ms: number } | undefined;
    return row?.expires_at_ms ?? null;
  } catch {
    return null;
  }
}

async function persistCooldownMongo(platform: string, modelId: string, keyId: string | number, expiresAtMs: number) {
  try {
    const col = getRateLimitCooldownsCollection();
    await col.updateOne(
      { platform, model_id: modelId, key_id: keyId },
      { $set: { platform, model_id: modelId, key_id: keyId, expires_at_ms: expiresAtMs } },
      { upsert: true },
    );
  } catch { /* best-effort */ }
}

function persistCooldownSqlite(platform: string, modelId: string, keyId: string | number, expiresAtMs: number) {
  try {
    const db = getDb();
    const kid = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    db.prepare(`
      INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, model_id, key_id)
      DO UPDATE SET expires_at_ms = excluded.expires_at_ms
    `).run(platform, modelId, kid, expiresAtMs);
  } catch { /* best-effort */ }
}

async function clearPersistedCooldownMongo(platform: string, modelId: string, keyId: string | number) {
  try {
    const col = getRateLimitCooldownsCollection();
    await col.deleteOne({ platform, model_id: modelId, key_id: keyId });
  } catch { /* best-effort */ }
}

function clearPersistedCooldownSqlite(platform: string, modelId: string, keyId: string | number) {
  try {
    const db = getDb();
    const kid = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    db.prepare('DELETE FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?')
      .run(platform, modelId, kid);
  } catch { /* best-effort */ }
}

export async function setCooldown(platform: string, modelId: string, keyId: string | number, durationMs = 60_000) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiresAtMs = Date.now() + durationMs;
  cooldowns.set(key, expiresAtMs);

  if (isMongo()) {
    await persistCooldownMongo(platform, modelId, keyId, expiresAtMs);
  } else {
    persistCooldownSqlite(platform, modelId, keyId, expiresAtMs);
  }
}

export async function isOnCooldown(platform: string, modelId: string, keyId: string | number): Promise<boolean> {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const now = Date.now();

  let persistedExpiry: number | null = null;
  if (isMongo()) {
    persistedExpiry = await persistedCooldownExpiryMongo(platform, modelId, keyId);
  } else {
    persistedExpiry = persistedCooldownExpirySqlite(platform, modelId, keyId);
  }

  if (persistedExpiry !== null) {
    if (now > persistedExpiry) {
      cooldowns.delete(key);
      if (isMongo()) {
        await clearPersistedCooldownMongo(platform, modelId, keyId);
      } else {
        clearPersistedCooldownSqlite(platform, modelId, keyId);
      }
      return false;
    }
    cooldowns.set(key, persistedExpiry);
    return true;
  }

  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (now > expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export async function getRateLimitStatus(
  platform: string,
  modelId: string,
  keyId: string | number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();

  return {
    rpm: { used: await requestCount(platform, modelId, keyId, MINUTE, now), limit: limits.rpm },
    rpd: { used: await requestCount(platform, modelId, keyId, DAY, now), limit: limits.rpd },
    tpm: { used: await tokenCount(platform, modelId, keyId, MINUTE, now), limit: limits.tpm },
  };
}
