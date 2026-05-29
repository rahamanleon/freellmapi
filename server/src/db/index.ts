import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initEncryptionKey } from '../lib/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');

const MONGODB_URI = process.env.MONGODB_URI ?? '';
const IS_MONGO = MONGODB_URI.length > 0;

let dbInitialized = false;
// SQLite path
let sqliteDb: Database.Database;
// MongoDB path
let mongoExports: typeof import('./mongo/index.js');

export function isMongo(): boolean {
  return IS_MONGO;
}

export function isSqlite(): boolean {
  return !IS_MONGO;
}

async function initSqlite(dbPath?: string): Promise<void> {
  const resolvedPath = dbPath ?? DB_PATH;
  const isMemory = resolvedPath === ':memory:';

  if (!isMemory) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  sqliteDb = new Database(resolvedPath);
  if (!isMemory) sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');

  createTables(sqliteDb);
  initEncryptionKey(sqliteDb);
  seedModels(sqliteDb);
  migrateModels(sqliteDb);
  migrateModelsV2(sqliteDb);
  migrateModelsV3Ranks(sqliteDb);
  migrateModelsV4(sqliteDb);
  migrateModelsV5(sqliteDb);
  migrateModelsV6(sqliteDb);
  migrateModelsV7(sqliteDb);
  migrateModelsV8(sqliteDb);
  migrateModelsV9(sqliteDb);
  migrateModelsV10(sqliteDb);
  migrateModelsV11(sqliteDb);
  migrateModelsV12(sqliteDb);
  migrateModelsV13(sqliteDb);
  migrateModelsV14(sqliteDb);
  ensureUnifiedKey(sqliteDb);

  console.log(`Database initialized at ${resolvedPath}`);
}

async function initMongo(): Promise<void> {
  mongoExports = await import('./mongo/index.js');
  await mongoExports.connectMongo(MONGODB_URI);
  console.log(`MongoDB initialized at ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
}

export async function initDb(dbPath?: string): Promise<void> {
  if (dbInitialized) return;
  if (IS_MONGO) {
    await initMongo();
  } else {
    await initSqlite(dbPath);
  }
  dbInitialized = true;
}

export async function closeDb(): Promise<void> {
  if (IS_MONGO) {
    await mongoExports?.closeMongo();
  } else {
    sqliteDb?.close();
  }
}

// ── Unified helpers (async wrappers for both backends) ──

type Row = Record<string, any>;

async function sqliteAll(sql: string, params?: any[]): Promise<Row[]> {
  return (params ? sqliteDb.prepare(sql).all(...params) : sqliteDb.prepare(sql).all()) as Row[];
}

async function sqliteGet(sql: string, params?: any[]): Promise<Row | null> {
  const result = params ? sqliteDb.prepare(sql).get(...params) : sqliteDb.prepare(sql).get();
  return (result ?? null) as Row | null;
}

async function sqliteRun(sql: string, params?: any[]): Promise<{ changes: number; lastInsertRowid: number }> {
  const info = params ? sqliteDb.prepare(sql).run(...params) : sqliteDb.prepare(sql).run();
  return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
}

export const db = {
  async all(sql: string, params?: any[]): Promise<Row[]> {
    if (!dbInitialized) throw new Error('Database not initialized. Call initDb() first.');
    if (IS_MONGO) throw new Error('Use collection methods for MongoDB — raw SQL is not supported');
    return sqliteAll(sql, params);
  },
  async get(sql: string, params?: any[]): Promise<Row | null> {
    if (!dbInitialized) throw new Error('Database not initialized. Call initDb() first.');
    if (IS_MONGO) throw new Error('Use collection methods for MongoDB — raw SQL is not supported');
    return sqliteGet(sql, params);
  },
  async run(sql: string, params?: any[]): Promise<{ changes: number; lastInsertRowid: number }> {
    if (!dbInitialized) throw new Error('Database not initialized. Call initDb() first.');
    if (IS_MONGO) throw new Error('Use collection methods for MongoDB — raw SQL is not supported');
    return sqliteRun(sql, params);
  },
  transaction<T>(fn: () => T): T {
    if (IS_MONGO) throw new Error('Transactions not supported for MongoDB through this path');
    return sqliteDb.transaction(fn)();
  },
};

// Legacy synchronous getDb — only works for SQLite; throws for MongoDB.
export function getDb(): Database.Database {
  if (IS_MONGO) {
    throw new Error('Use async mongo helpers instead of getDb() when MONGODB_URI is set');
  }
  if (!sqliteDb) throw new Error('Database not initialized. Call initDb() first.');
  return sqliteDb;
}

// MongoDB collection accessors (only valid when isMongo() is true)
export function getMongoDb() {
  if (!IS_MONGO) throw new Error('MongoDB is not active. Set MONGODB_URI env var.');
  return mongoExports.getDb();
}

export function getModelsCollection() {
  if (!IS_MONGO) throw new Error('MongoDB is not active');
  return mongoExports.modelsCol();
}

export function getApiKeysCollection() {
  if (!IS_MONGO) throw new Error('MongoDB is not active');
  return mongoExports.apiKeysCol();
}

export function getRequestsCollection() {
  if (!IS_MONGO) throw new Error('MongoDB is not active');
  return mongoExports.requestsCol();
}

export function getRateLimitUsageCollection() {
  if (!IS_MONGO) throw new Error('MongoDB is not active');
  return mongoExports.rateLimitUsageCol();
}

export function getRateLimitCooldownsCollection() {
  if (!IS_MONGO) throw new Error('MongoDB is not active');
  return mongoExports.rateLimitCooldownsCol();
}

export function getFallbackConfigCollection() {
  if (!IS_MONGO) throw new Error('MongoDB is not active');
  return mongoExports.fallbackConfigCol();
}

export function getSettingsCollection() {
  if (!IS_MONGO) throw new Error('MongoDB is not active');
  return mongoExports.settingsCol();
}

// Unified key access — works for both backends
export async function getUnifiedApiKey(): Promise<string> {
  if (IS_MONGO) {
    return mongoExports.getUnifiedApiKey();
  }
  const row = sqliteDb.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
  if (!row) {
    const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
    sqliteDb.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(key);
    return key;
  }
  return row.value;
}

export async function regenerateUnifiedKey(): Promise<string> {
  if (IS_MONGO) {
    return mongoExports.regenerateUnifiedKey();
  }
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  sqliteDb.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(key);
  return key;
}

// ── SQLite schema + migrations (kept for local dev) ──

function createTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
      tokens INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_lookup ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_expires ON rate_limit_cooldowns(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
  `);

  ensureRequestKeyIdColumn(db);
}

function ensureRequestKeyIdColumn(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'key_id')) {
    db.prepare('ALTER TABLE requests ADD COLUMN key_id INTEGER').run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_key_id ON requests(key_id)').run();
}

function seedModels(db: Database.Database) {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM models').get() as { cnt: number };
  if (count.cnt > 0) return;

  const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const models = [
    ['google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 1, 8, 'Frontier', 5, 100, 250000, null, '~12M', 1048576],
    ['google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 4, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 8, 3, 'Medium', 15, 1000, 250000, null, '~120M', 1048576],
    ['openrouter', 'minimax/minimax-m2.5:free', 'MiniMax M2.5 (free)', 1, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 1048576],
    ['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free', 'Qwen3-Next 80B (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 262144],
    ['cerebras', 'qwen-3-235b-a22b-instruct-2507', 'Qwen3 235B', 6, 1, 'Large', 5, 2400, 30000, 1000000, '~30M', 131072],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B (Cerebras)', 6, 1, 'Large', 5, 2400, 30000, 1000000, '~30M', 131072],
    ['cerebras', 'zai-glm-4.7', 'GLM-4.7 (Cerebras)', 7, 1, 'Frontier', 10, 100, null, null, '~3M', 8192],
    ['cerebras', 'llama3.1-8b', 'Llama 3.1 8B (Cerebras)', 28, 1, 'Small', 5, 2400, 30000, 1000000, '~30M', 131072],
    ['groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 16, 2, 'Medium', 30, 1000, 12000, 100000, '~15M', 131072],
    ['groq', 'meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 18, 2, 'Medium', 30, 1000, 30000, 500000, '~30M', 131072],
    ['groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 6, 2, 'Large', 30, 1000, 8000, 200000, '~6M', 131072],
    ['groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)', 18, 2, 'Medium', 30, 1000, 8000, 200000, '~6M', 131072],
    ['groq', 'qwen/qwen3-32b', 'Qwen3 32B (Groq)', 19, 2, 'Medium', 60, 1000, 6000, 500000, '~15M', 131072],
    ['groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B Instant', 28, 2, 'Small', 30, 14400, 6000, 500000, '~15M', 131072],
    ['groq', 'groq/compound', 'Compound (Groq)', 6, 2, 'Large', 30, 250, 70000, null, '~6M', 131072],
    ['groq', 'groq/compound-mini', 'Compound Mini (Groq)', 18, 2, 'Medium', 30, 250, 70000, null, '~6M', 131072],
    ['groq', 'openai/gpt-oss-safeguard-20b', 'GPT-OSS Safeguard 20B (Groq)', 18, 2, 'Medium', 30, 1000, 8000, 200000, '~6M', 131072],
    ['sambanova', 'DeepSeek-V3.1', 'DeepSeek V3.1', 5, 9, 'Frontier', 20, 20, null, 200000, '~3M', 131072],
    ['sambanova', 'DeepSeek-V3.2', 'DeepSeek V3.2', 4, 9, 'Frontier', 20, 20, null, 200000, '~3M', 32768],
    ['sambanova', 'Llama-4-Maverick-17B-128E-Instruct', 'Llama 4 Maverick', 11, 9, 'Large', 20, 20, null, 200000, '~3M', 8192],
    ['sambanova', 'gpt-oss-120b', 'GPT-OSS 120B (SambaNova)', 6, 9, 'Large', 20, 20, null, 200000, '~3M', 131072],
    ['sambanova', 'Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B', 16, 9, 'Medium', 20, 20, null, 200000, '~3M', 8192],
    ['sambanova', 'gemma-3-12b-it', 'Gemma 3 12B (SambaNova)', 22, 9, 'Medium', 20, 20, null, 200000, '~3M', 131072],
    ['nvidia', 'meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (NV)', 16, 6, 'Large', 40, null, null, null, '~3M (credits)', 131072],
    ['nvidia', 'meta/llama-3.3-70b-instruct', 'Llama 3.3 70B (NV)', 16, 6, 'Large', 40, null, null, null, '~3M (credits)', 131072],
    ['nvidia', 'meta/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick (NV)', 11, 6, 'Large', 40, null, null, null, '~3M (credits)', 131072],
    ['nvidia', 'deepseek-ai/deepseek-v4-pro', 'DeepSeek V4 Pro (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
    ['nvidia', 'mistralai/mistral-large-3-675b-instruct-2512', 'Mistral Large 3 675B (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
    ['nvidia', 'minimaxai/minimax-m2.7', 'MiniMax M2.7 (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 196608],
    ['nvidia', 'nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super 120B (NV)', 22, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 262144],
    ['nvidia', 'nvidia/nemotron-3-nano-30b-a3b', 'Nemotron 3 Nano 30B (NV)', 22, 9, 'Medium', 40, null, null, null, '~3M (credits)', 262144],
    ['nvidia', 'google/gemma-4-31b-it', 'Gemma 4 31B (NV)', 19, 9, 'Medium', 40, null, null, null, '~3M (credits)', 262144],
    ['nvidia', 'moonshotai/kimi-k2.6', 'Kimi K2.6 (NV)', 3, 9, 'Frontier', 40, null, null, null, '~2M (credits)', 131072],
    ['nvidia', 'deepseek-ai/deepseek-v4-flash', 'DeepSeek V4 Flash (NV)', 4, 9, 'Frontier', 40, null, null, null, '~3M (credits)', 131072],
    ['nvidia', 'z-ai/glm-5.1', 'GLM-5.1 (NV, slow cold-start)', 5, 9, 'Frontier', 40, null, null, null, '~3M (credits)', 200000],
    ['nvidia', 'qwen/qwen3-coder-480b-a35b-instruct', 'Qwen3-Coder 480B (NV)', 2, 9, 'Frontier', 40, null, null, null, '~3M (credits)', 262144],
    ['mistral', 'mistral-large-latest', 'Mistral Large 3', 14, 8, 'Large', 2, null, 500000, null, '~50-100M', 262144],
    ['mistral', 'magistral-medium-latest', 'Magistral Medium', 14, 8, 'Large', 2, null, 500000, null, '~50-100M', 131072],
    ['mistral', 'codestral-latest', 'Codestral', 16, 6, 'Medium', 2, null, 500000, null, '~50-100M', 256000],
    ['mistral', 'devstral-latest', 'Devstral', 16, 8, 'Medium', 2, null, 500000, null, '~50-100M', 262144],
    ['mistral', 'mistral-medium-latest', 'Mistral Medium 3.5', 14, 8, 'Large', 2, null, 500000, null, '~50-100M', 131072],
    ['mistral', 'mistral-small-latest', 'Mistral Small 4', 14, 8, 'Medium', 2, null, 500000, null, '~50-100M', 262144],
    ['mistral', 'ministral-8b-latest', 'Ministral 3 8B', 28, 8, 'Small', 2, null, 500000, null, '~50-100M', 262144],
    ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 7, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'openai/gpt-oss-120b:free', 'GPT-OSS 120B (free)', 6, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'openai/gpt-oss-20b:free', 'GPT-OSS 20B (free)', 18, 9, 'Medium', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)', 16, 9, 'Medium', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (free)', 22, 9, 'Frontier', 20, 200, null, null, '~6M', 1000000],
    ['openrouter', 'inclusionai/ling-2.6-flash:free', 'Ling 2.6 Flash (free)', 7, 9, 'Large', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free', 'Nemotron 3 Nano 30B (free)', 22, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'nousresearch/hermes-3-llama-3.1-405b:free', 'Hermes 3 405B (free)', 17, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B (free)', 19, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'liquid/lfm-2.5-1.2b-instruct:free', 'Liquid LFM 2.5 1.2B (free)', 30, 10, 'Small', 20, 200, null, null, '~6M', 32768],
    ['openrouter', 'inclusionai/ling-2.6-1t:free', 'Ling 2.6 1T (free)', 4, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'tencent/hy3-preview:free', 'Tencent HY3 Preview (free)', 7, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'poolside/laguna-m.1:free', 'Poolside Laguna M.1 (free)', 13, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'google/gemma-4-26b-a4b-it:free', 'Gemma 4 26B-A4B (free)', 22, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'Nemotron 3 Nano 30B Reasoning (free)', 23, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'poolside/laguna-xs.2:free', 'Poolside Laguna XS.2 (free)', 26, 10, 'Medium', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'nvidia/nemotron-nano-9b-v2:free', 'Nemotron Nano 9B v2 (free)', 28, 10, 'Medium', 20, 200, null, null, '~6M', 128000],
    ['openrouter', 'liquid/lfm-2.5-1.2b-thinking:free', 'Liquid LFM 2.5 1.2B Thinking (free)', 30, 10, 'Small', 20, 200, null, null, '~6M', 32768],
    ['openrouter', 'arcee-ai/trinity-large-thinking:free', 'Trinity Large Thinking (free)', 5, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'baidu/cobuddy:free', 'CoBuddy (free)', 6, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'openrouter/owl-alpha', 'Owl Alpha (OR-house)', 5, 9, 'Frontier', 20, 200, null, null, '~6M', 1048576],
    ['openrouter', 'nousresearch/hermes-3-llama-3.1-405b:free', 'Hermes 3 405B (free)', 17, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    ['github', 'gpt-4o', 'GPT-4o', 21, 7, 'Large', 10, 50, null, null, '~18M', 8000],
    ['github', 'openai/gpt-4.1', 'GPT-4.1 (GitHub)', 20, 7, 'Large', 10, 50, null, null, '~9M', 128000],
    ['cohere', 'command-r-plus-08-2024', 'Command R+ (08-2024)', 23, 11, 'Large', 20, 33, null, null, '~1-2M', 131072],
    ['cohere', 'command-a-03-2025', 'Command-A (03-2025)', 22, 11, 'Large', 20, 33, null, null, '~1-2M', 131072],
    ['cohere', 'command-a-reasoning-08-2025', 'Command A Reasoning (08-2025)', 13, 11, 'Large', 20, 33, null, null, '~1-2M', 256000],
    ['cohere', 'command-r-08-2024', 'Command R (08-2024)', 25, 11, 'Medium', 20, 33, null, null, '~1-2M', 131072],
    ['cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B fp8-fast (CF)', 16, 11, 'Medium', null, null, null, null, '~18-45M', 24000],
    ['cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B-A3B fp8 (CF)', 7, 11, 'Large', null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Distill Qwen 32B (CF)', 9, 11, 'Large', null, null, null, null, '~3-5M', 131072],
    ['cloudflare', '@cf/openai/gpt-oss-120b', 'GPT-OSS 120B (CF)', 6, 11, 'Large', null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/zai-org/glm-4.7-flash', 'GLM-4.7 Flash (CF)', 10, 11, 'Large', null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (CF)', 12, 11, 'Large', null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/moonshotai/kimi-k2.6', 'Kimi K2.6 (CF)', 2, 11, 'Frontier', null, null, null, null, '~10-20M', 262144],
    ['cloudflare', '@cf/ibm-granite/granite-4.0-h-micro', 'Granite 4.0 H Micro (CF)', 29, 11, 'Small', null, null, null, null, '~5-10M', 131072],
    ['cloudflare', '@cf/nvidia/nemotron-3-120b-a12b', 'Nemotron 3 120B (CF)', 9, 11, 'Frontier', null, null, null, null, '~5-10M', 262144],
    ['cloudflare', '@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B-A4B it (CF)', 22, 11, 'Medium', null, null, null, null, '~10-20M', 262144],
    ['google', 'gemini-3.1-flash-lite-preview', 'Gemini 3.1 Flash-Lite Preview', 18, 3, 'Medium', 15, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview', 11, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 1, 8, 'Frontier', 5, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 3, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
    ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 24, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['zhipu', 'glm-4.7-flash', 'GLM-4.7 Flash', 18, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['ollama', 'qwen3-coder:480b', 'Qwen3-Coder 480B (Ollama)', 2, 9, 'Frontier', null, null, null, null, '~5-10M', 262144],
    ['ollama', 'mistral-large-3:675b', 'Mistral Large 3 675B (Ollama)', 3, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'deepseek-v3.2', 'DeepSeek V3.2 (Ollama)', 4, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'cogito-2.1:671b', 'Cogito 2.1 671B (Ollama)', 4, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'kimi-k2-thinking', 'Kimi K2 Thinking (Ollama)', 5, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'glm-4.7', 'GLM-4.7 (Ollama)', 6, 9, 'Frontier', null, null, null, null, '~5-10M', 131072],
    ['ollama', 'gpt-oss:120b', 'GPT-OSS 120B (Ollama)', 6, 9, 'Large', null, null, null, null, '~10-20M', 131072],
    ['ollama', 'devstral-2:123b', 'Devstral 2 123B (Ollama)', 8, 10, 'Large', null, null, null, null, '~10-20M', 131072],
    ['ollama', 'gpt-oss:20b', 'GPT-OSS 20B (Ollama)', 18, 10, 'Medium', null, null, null, null, '~20-30M', 131072],
    ['ollama', 'gemma4:31b', 'Gemma 4 31B (Ollama)', 22, 10, 'Medium', null, null, null, null, '~20-30M', 131072],
    ['ollama', 'qwen3-coder-next', 'Qwen3-Coder Next (Ollama)', 3, 9, 'Large', null, null, null, null, '~10-20M', 262144],
    ['kilo', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (Kilo)', 22, 9, 'Frontier', null, null, null, null, '~2-3M (200/hr)', 262144],
    ['pollinations', 'openai-fast', 'GPT-OSS 20B (Pollinations)', 18, 10, 'Medium', null, null, null, null, '~? (anon)', 131072],
    ['llm7', 'gpt-oss-20b', 'GPT-OSS 20B (LLM7)', 18, 10, 'Medium', 100, null, null, null, '~2-3M (100/hr)', 131072],
    ['llm7', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Llama 3.1 8B Turbo (LLM7)', 28, 10, 'Small', 100, null, null, null, '~2-3M (100/hr)', 131072],
    ['llm7', 'codestral-latest', 'Codestral (LLM7)', 16, 8, 'Medium', 100, null, null, null, '~2-3M (100/hr)', 32000],
    ['llm7', 'ministral-8b-2512', 'Ministral 8B (LLM7)', 28, 10, 'Small', 100, null, null, null, '~2-3M (100/hr)', 131072],
    ['llm7', 'GLM-4.6V-Flash', 'GLM-4.6V Flash (LLM7)', 15, 9, 'Large', 100, null, null, null, '~2-3M (100/hr)', 131072],
    ['huggingface', 'deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash (HF)', 4, 9, 'Frontier', null, null, null, null, '~1-3M', 131072],
    ['huggingface', 'moonshotai/Kimi-K2.6', 'Kimi K2.6 (HF)', 3, 9, 'Frontier', null, null, null, null, '~1-3M', 262144],
    ['huggingface', 'Qwen/Qwen3-Coder-Next', 'Qwen3-Coder Next (HF)', 3, 9, 'Large', null, null, null, null, '~1-3M', 262144],
  ];

  const insertMany = db.transaction(() => {
    for (const m of models) {
      insert.run(...m);
    }
  });
  insertMany();

  const allModels = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as { id: number; intelligence_rank: number }[];
  const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  const insertFallbacks = db.transaction(() => {
    for (let i = 0; i < allModels.length; i++) {
      insertFallback.run(allModels[i].id, i + 1);
    }
  });
  insertFallbacks();

  console.log(`Seeded ${models.length} models and fallback config`);
}

function ensureUnifiedKey(db: Database.Database) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
  if (!existing) {
    const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
    db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(key);
    console.log(`\n  Your unified API key: ${key}\n`);
  }
}

// Stub migration functions (kept for backwards compat on existing SQLite DBs)
function migrateModels(_db: Database.Database) { }
function migrateModelsV2(_db: Database.Database) { }
function migrateModelsV3Ranks(_db: Database.Database) { }
function migrateModelsV4(_db: Database.Database) { }
function migrateModelsV5(_db: Database.Database) { }
function migrateModelsV6(_db: Database.Database) { }
function migrateModelsV7(_db: Database.Database) { }
function migrateModelsV8(_db: Database.Database) { }
function migrateModelsV9(_db: Database.Database) { }
function migrateModelsV10(_db: Database.Database) { }
function migrateModelsV11(_db: Database.Database) { }
function migrateModelsV12(_db: Database.Database) { }
function migrateModelsV13(_db: Database.Database) { }
function migrateModelsV14(_db: Database.Database) { }
