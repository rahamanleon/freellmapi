import crypto from 'crypto';
import { MongoClient, type Db, type Collection } from 'mongodb';

let client: MongoClient;
let db: Db;

export async function connectMongo(uri: string): Promise<Db> {
  client = new MongoClient(uri);
  await client.connect();
  db = client.db();
  await setupCollections(db);
  await seedIfEmpty(db);
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) await client.close();
}

export function getDb(): Db {
  if (!db) throw new Error('MongoDB not initialized. Call connectMongo() first.');
  return db;
}

// ── Collection accessors ──

export function modelsCol(): Collection {
  return getDb().collection('models');
}
export function apiKeysCol(): Collection {
  return getDb().collection('api_keys');
}
export function requestsCol(): Collection {
  return getDb().collection('requests');
}
export function rateLimitUsageCol(): Collection {
  return getDb().collection('rate_limit_usage');
}
export function rateLimitCooldownsCol(): Collection {
  return getDb().collection('rate_limit_cooldowns');
}
export function fallbackConfigCol(): Collection {
  return getDb().collection('fallback_config');
}
export function settingsCol(): Collection {
  return getDb().collection('settings');
}

// ── Setup ──

async function setupCollections(database: Db): Promise<void> {
  const collections = await database.listCollections().toArray();
  const names = new Set(collections.map(c => c.name));

  const required = ['models', 'api_keys', 'requests', 'rate_limit_usage', 'rate_limit_cooldowns', 'fallback_config', 'settings'];
  for (const name of required) {
    if (!names.has(name)) {
      await database.createCollection(name);
    }
  }

  // Indexes
  await database.collection('models').createIndexes([
    { key: { platform: 1, model_id: 1 }, unique: true },
    { key: { enabled: 1 } },
    { key: { intelligence_rank: 1 } },
  ]);
  await database.collection('api_keys').createIndexes([
    { key: { platform: 1 } },
    { key: { enabled: 1 } },
    { key: { created_at: -1 } },
  ]);
  await database.collection('requests').createIndexes([
    { key: { created_at: -1 } },
    { key: { platform: 1 } },
    { key: { status: 1 } },
    { key: { created_at: 1 } },
  ]);
  await database.collection('rate_limit_usage').createIndexes([
    { key: { platform: 1, model_id: 1, key_id: 1, kind: 1, created_at_ms: 1 } },
    { key: { created_at_ms: 1 }, expireAfterSeconds: 86400 },
  ]);
  await database.collection('rate_limit_cooldowns').createIndexes([
    { key: { platform: 1, model_id: 1, key_id: 1 }, unique: true },
    { key: { expires_at_ms: 1 } },
  ]);
  await database.collection('fallback_config').createIndexes([
    { key: { model_db_id: 1 }, unique: true },
    { key: { priority: 1 } },
  ]);
  await database.collection('settings').createIndexes([
    { key: { key: 1 }, unique: true },
  ]);
}

// ── Seed ──

async function seedIfEmpty(database: Db): Promise<void> {
  const modelCount = await database.collection('models').countDocuments();
  if (modelCount > 0) return;

  const models = getSeedModels();
  const seen = new Set<string>();
  const unique = models.filter(m => {
    const key = `${m.platform}:${m.model_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await database.collection('models').insertMany(unique, { ordered: false });

  // Fallback config
  const allModels = await database.collection('models').find().sort({ intelligence_rank: 1 }).toArray();
  const fallbacks = allModels.map((m, i) => ({
    model_db_id: m._id.toString(),
    priority: i + 1,
    enabled: 1,
  }));
  await database.collection('fallback_config').insertMany(fallbacks);

  // Encryption key
  const encryptionKey = crypto.randomBytes(32).toString('hex');
  await database.collection('settings').insertOne({ key: 'encryption_key', value: encryptionKey });
  console.log(`\n  Encryption key: ${encryptionKey}\n`);

  // Unified API key
  const unifiedKey = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  await database.collection('settings').insertOne({ key: 'unified_api_key', value: unifiedKey });
  console.log(`\n  Your unified API key: ${unifiedKey}\n`);

  // Migration version
  await database.collection('settings').insertOne({ key: 'schema_version', value: 14 });
  await applyMongoMigrations(database);

  console.log(`Seeded ${models.length} models and fallback config`);
}

async function applyMongoMigrations(database: Db): Promise<void> {
  const models = database.collection('models');
  const fallback = database.collection('fallback_config');
  const settings = database.collection('settings');

  const versionDoc = await settings.findOne({ key: 'schema_version' });
  let version = versionDoc?.value ?? 0;

  // Incremental migrations (matching SQLite V1-V14 logic for fresh seeds)
  // For fresh seeds, data is already up to date from getSeedModels().
  // For existing databases, run deltas:
  const migrations: Array<() => Promise<void>> = [];

  for (let i = version + 1; i <= 14; i++) {
    const fn = migrations[i - 1];
    if (fn) await fn();
  }

  await settings.updateOne(
    { key: 'schema_version' },
    { $set: { value: 14 } },
    { upsert: true },
  );
}

let cachedEncryptionKey: string | null = null;

export async function getEncryptionKey(): Promise<string | null> {
  if (cachedEncryptionKey) return cachedEncryptionKey;
  const doc = await db.collection('settings').findOne({ key: 'encryption_key' });
  cachedEncryptionKey = doc?.value ?? null;
  return cachedEncryptionKey;
}

export async function getUnifiedApiKey(): Promise<string> {
  const doc = await settingsCol().findOne({ key: 'unified_api_key' });
  if (!doc) {
    const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
    await settingsCol().insertOne({ key: 'unified_api_key', value: key });
    return key;
  }
  return doc.value;
}

export async function regenerateUnifiedKey(): Promise<string> {
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  await settingsCol().updateOne(
    { key: 'unified_api_key' },
    { $set: { value: key } },
    { upsert: true },
  );
  return key;
}

// ── Seed data ──

function getSeedModels() {
  return [
    { platform: 'google', model_id: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', intelligence_rank: 1, speed_rank: 8, size_label: 'Frontier', rpm_limit: 5, rpd_limit: 100, tpm_limit: 250000, tpd_limit: null, monthly_token_budget: '~12M', context_window: 1048576, enabled: 1 },
    { platform: 'google', model_id: 'gemini-2.5-flash', display_name: 'Gemini 2.5 Flash', intelligence_rank: 4, speed_rank: 5, size_label: 'Large', rpm_limit: 10, rpd_limit: 20, tpm_limit: 250000, tpd_limit: null, monthly_token_budget: '~3M', context_window: 1048576, enabled: 1 },
    { platform: 'google', model_id: 'gemini-2.5-flash-lite', display_name: 'Gemini 2.5 Flash-Lite', intelligence_rank: 8, speed_rank: 3, size_label: 'Medium', rpm_limit: 15, rpd_limit: 1000, tpm_limit: 250000, tpd_limit: null, monthly_token_budget: '~120M', context_window: 1048576, enabled: 1 },
    { platform: 'openrouter', model_id: 'minimax/minimax-m2.5:free', display_name: 'MiniMax M2.5 (free)', intelligence_rank: 1, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'qwen/qwen3-coder:free', display_name: 'Qwen3 Coder (free)', intelligence_rank: 2, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 1048576, enabled: 1 },
    { platform: 'openrouter', model_id: 'qwen/qwen3-next-80b-a3b-instruct:free', display_name: 'Qwen3-Next 80B (free)', intelligence_rank: 3, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'cerebras', model_id: 'qwen-3-235b-a22b-instruct-2507', display_name: 'Qwen3 235B', intelligence_rank: 6, speed_rank: 1, size_label: 'Large', rpm_limit: 5, rpd_limit: 2400, tpm_limit: 30000, tpd_limit: 1000000, monthly_token_budget: '~30M', context_window: 131072, enabled: 0 },
    { platform: 'cerebras', model_id: 'gpt-oss-120b', display_name: 'GPT-OSS 120B (Cerebras)', intelligence_rank: 6, speed_rank: 1, size_label: 'Large', rpm_limit: 5, rpd_limit: 2400, tpm_limit: 30000, tpd_limit: 1000000, monthly_token_budget: '~30M', context_window: 131072, enabled: 1 },
    { platform: 'cerebras', model_id: 'zai-glm-4.7', display_name: 'GLM-4.7 (Cerebras)', intelligence_rank: 7, speed_rank: 1, size_label: 'Frontier', rpm_limit: 10, rpd_limit: 100, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3M', context_window: 8192, enabled: 0 },
    { platform: 'cerebras', model_id: 'llama3.1-8b', display_name: 'Llama 3.1 8B (Cerebras)', intelligence_rank: 28, speed_rank: 1, size_label: 'Small', rpm_limit: 5, rpd_limit: 2400, tpm_limit: 30000, tpd_limit: 1000000, monthly_token_budget: '~30M', context_window: 131072, enabled: 0 },
    { platform: 'groq', model_id: 'llama-3.3-70b-versatile', display_name: 'Llama 3.3 70B', intelligence_rank: 16, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 12000, tpd_limit: 100000, monthly_token_budget: '~15M', context_window: 131072, enabled: 1 },
    { platform: 'groq', model_id: 'meta-llama/llama-4-scout-17b-16e-instruct', display_name: 'Llama 4 Scout', intelligence_rank: 18, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 30000, tpd_limit: 500000, monthly_token_budget: '~30M', context_window: 131072, enabled: 1 },
    { platform: 'groq', model_id: 'openai/gpt-oss-120b', display_name: 'GPT-OSS 120B (Groq)', intelligence_rank: 6, speed_rank: 2, size_label: 'Large', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 8000, tpd_limit: 200000, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'groq', model_id: 'openai/gpt-oss-20b', display_name: 'GPT-OSS 20B (Groq)', intelligence_rank: 18, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 8000, tpd_limit: 200000, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'groq', model_id: 'qwen/qwen3-32b', display_name: 'Qwen3 32B (Groq)', intelligence_rank: 19, speed_rank: 2, size_label: 'Medium', rpm_limit: 60, rpd_limit: 1000, tpm_limit: 6000, tpd_limit: 500000, monthly_token_budget: '~15M', context_window: 131072, enabled: 1 },
    { platform: 'groq', model_id: 'llama-3.1-8b-instant', display_name: 'Llama 3.1 8B Instant', intelligence_rank: 28, speed_rank: 2, size_label: 'Small', rpm_limit: 30, rpd_limit: 14400, tpm_limit: 6000, tpd_limit: 500000, monthly_token_budget: '~15M', context_window: 131072, enabled: 1 },
    { platform: 'groq', model_id: 'groq/compound', display_name: 'Compound (Groq)', intelligence_rank: 6, speed_rank: 2, size_label: 'Large', rpm_limit: 30, rpd_limit: 250, tpm_limit: 70000, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'groq', model_id: 'groq/compound-mini', display_name: 'Compound Mini (Groq)', intelligence_rank: 18, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 250, tpm_limit: 70000, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'groq', model_id: 'openai/gpt-oss-safeguard-20b', display_name: 'GPT-OSS Safeguard 20B (Groq)', intelligence_rank: 18, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 8000, tpd_limit: 200000, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'sambanova', model_id: 'DeepSeek-V3.1', display_name: 'DeepSeek V3.1', intelligence_rank: 5, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 20, tpm_limit: null, tpd_limit: 200000, monthly_token_budget: '~3M', context_window: 131072, enabled: 1 },
    { platform: 'sambanova', model_id: 'DeepSeek-V3.2', display_name: 'DeepSeek V3.2', intelligence_rank: 4, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 20, tpm_limit: null, tpd_limit: 200000, monthly_token_budget: '~3M', context_window: 32768, enabled: 1 },
    { platform: 'sambanova', model_id: 'Llama-4-Maverick-17B-128E-Instruct', display_name: 'Llama 4 Maverick', intelligence_rank: 11, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 20, tpm_limit: null, tpd_limit: 200000, monthly_token_budget: '~3M', context_window: 8192, enabled: 1 },
    { platform: 'sambanova', model_id: 'gpt-oss-120b', display_name: 'GPT-OSS 120B (SambaNova)', intelligence_rank: 6, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 20, tpm_limit: null, tpd_limit: 200000, monthly_token_budget: '~3M', context_window: 131072, enabled: 1 },
    { platform: 'sambanova', model_id: 'Meta-Llama-3.3-70B-Instruct', display_name: 'Llama 3.3 70B', intelligence_rank: 16, speed_rank: 9, size_label: 'Medium', rpm_limit: 20, rpd_limit: 20, tpm_limit: null, tpd_limit: 200000, monthly_token_budget: '~3M', context_window: 8192, enabled: 1 },
    { platform: 'sambanova', model_id: 'gemma-3-12b-it', display_name: 'Gemma 3 12B (SambaNova)', intelligence_rank: 22, speed_rank: 9, size_label: 'Medium', rpm_limit: 20, rpd_limit: 20, tpm_limit: null, tpd_limit: 200000, monthly_token_budget: '~3M', context_window: 131072, enabled: 1 },
    { platform: 'nvidia', model_id: 'meta/llama-3.1-70b-instruct', display_name: 'Llama 3.1 70B (NV)', intelligence_rank: 16, speed_rank: 6, size_label: 'Large', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3M (credits)', context_window: 131072, enabled: 1 },
    { platform: 'nvidia', model_id: 'meta/llama-3.3-70b-instruct', display_name: 'Llama 3.3 70B (NV)', intelligence_rank: 16, speed_rank: 6, size_label: 'Large', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3M (credits)', context_window: 131072, enabled: 1 },
    { platform: 'nvidia', model_id: 'meta/llama-4-maverick-17b-128e-instruct', display_name: 'Llama 4 Maverick (NV)', intelligence_rank: 11, speed_rank: 6, size_label: 'Large', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3M (credits)', context_window: 131072, enabled: 1 },
    { platform: 'nvidia', model_id: 'deepseek-ai/deepseek-v4-pro', display_name: 'DeepSeek V4 Pro (NV)', intelligence_rank: 3, speed_rank: 9, size_label: 'Frontier', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2M (credits)', context_window: 131072, enabled: 1 },
    { platform: 'nvidia', model_id: 'mistralai/mistral-large-3-675b-instruct-2512', display_name: 'Mistral Large 3 675B (NV)', intelligence_rank: 3, speed_rank: 9, size_label: 'Frontier', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2M (credits)', context_window: 131072, enabled: 1 },
    { platform: 'nvidia', model_id: 'minimaxai/minimax-m2.7', display_name: 'MiniMax M2.7 (NV)', intelligence_rank: 3, speed_rank: 9, size_label: 'Frontier', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2M (credits)', context_window: 196608, enabled: 1 },
    { platform: 'nvidia', model_id: 'nvidia/nemotron-3-super-120b-a12b', display_name: 'Nemotron 3 Super 120B (NV)', intelligence_rank: 22, speed_rank: 9, size_label: 'Frontier', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2M (credits)', context_window: 262144, enabled: 1 },
    { platform: 'nvidia', model_id: 'nvidia/nemotron-3-nano-30b-a3b', display_name: 'Nemotron 3 Nano 30B (NV)', intelligence_rank: 22, speed_rank: 9, size_label: 'Medium', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3M (credits)', context_window: 262144, enabled: 1 },
    { platform: 'nvidia', model_id: 'google/gemma-4-31b-it', display_name: 'Gemma 4 31B (NV)', intelligence_rank: 19, speed_rank: 9, size_label: 'Medium', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3M (credits)', context_window: 262144, enabled: 1 },
    { platform: 'nvidia', model_id: 'moonshotai/kimi-k2.6', display_name: 'Kimi K2.6 (NV)', intelligence_rank: 3, speed_rank: 9, size_label: 'Frontier', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2M (credits)', context_window: 131072, enabled: 1 },
    { platform: 'nvidia', model_id: 'deepseek-ai/deepseek-v4-flash', display_name: 'DeepSeek V4 Flash (NV)', intelligence_rank: 4, speed_rank: 9, size_label: 'Frontier', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3M (credits)', context_window: 131072, enabled: 1 },
    { platform: 'nvidia', model_id: 'z-ai/glm-5.1', display_name: 'GLM-5.1 (NV, slow cold-start)', intelligence_rank: 5, speed_rank: 9, size_label: 'Frontier', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3M (credits)', context_window: 200000, enabled: 1 },
    { platform: 'nvidia', model_id: 'qwen/qwen3-coder-480b-a35b-instruct', display_name: 'Qwen3-Coder 480B (NV)', intelligence_rank: 2, speed_rank: 9, size_label: 'Frontier', rpm_limit: 40, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3M (credits)', context_window: 262144, enabled: 1 },
    { platform: 'mistral', model_id: 'mistral-large-latest', display_name: 'Mistral Large 3', intelligence_rank: 14, speed_rank: 8, size_label: 'Large', rpm_limit: 2, rpd_limit: null, tpm_limit: 500000, tpd_limit: null, monthly_token_budget: '~50-100M', context_window: 262144, enabled: 1 },
    { platform: 'mistral', model_id: 'magistral-medium-latest', display_name: 'Magistral Medium', intelligence_rank: 14, speed_rank: 8, size_label: 'Large', rpm_limit: 2, rpd_limit: null, tpm_limit: 500000, tpd_limit: null, monthly_token_budget: '~50-100M', context_window: 131072, enabled: 1 },
    { platform: 'mistral', model_id: 'codestral-latest', display_name: 'Codestral', intelligence_rank: 16, speed_rank: 6, size_label: 'Medium', rpm_limit: 2, rpd_limit: null, tpm_limit: 500000, tpd_limit: null, monthly_token_budget: '~50-100M', context_window: 256000, enabled: 1 },
    { platform: 'mistral', model_id: 'devstral-latest', display_name: 'Devstral', intelligence_rank: 16, speed_rank: 8, size_label: 'Medium', rpm_limit: 2, rpd_limit: null, tpm_limit: 500000, tpd_limit: null, monthly_token_budget: '~50-100M', context_window: 262144, enabled: 1 },
    { platform: 'mistral', model_id: 'mistral-medium-latest', display_name: 'Mistral Medium 3.5', intelligence_rank: 14, speed_rank: 8, size_label: 'Large', rpm_limit: 2, rpd_limit: null, tpm_limit: 500000, tpd_limit: null, monthly_token_budget: '~50-100M', context_window: 131072, enabled: 1 },
    { platform: 'mistral', model_id: 'mistral-small-latest', display_name: 'Mistral Small 4', intelligence_rank: 14, speed_rank: 8, size_label: 'Medium', rpm_limit: 2, rpd_limit: null, tpm_limit: 500000, tpd_limit: null, monthly_token_budget: '~50-100M', context_window: 262144, enabled: 1 },
    { platform: 'mistral', model_id: 'ministral-8b-latest', display_name: 'Ministral 3 8B', intelligence_rank: 28, speed_rank: 8, size_label: 'Small', rpm_limit: 2, rpd_limit: null, tpm_limit: 500000, tpd_limit: null, monthly_token_budget: '~50-100M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'z-ai/glm-4.5-air:free', display_name: 'GLM-4.5 Air (free)', intelligence_rank: 7, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'openrouter', model_id: 'openai/gpt-oss-120b:free', display_name: 'GPT-OSS 120B (free)', intelligence_rank: 6, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'openrouter', model_id: 'openai/gpt-oss-20b:free', display_name: 'GPT-OSS 20B (free)', intelligence_rank: 18, speed_rank: 9, size_label: 'Medium', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'openrouter', model_id: 'meta-llama/llama-3.3-70b-instruct:free', display_name: 'Llama 3.3 70B (free)', intelligence_rank: 16, speed_rank: 9, size_label: 'Medium', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'openrouter', model_id: 'nvidia/nemotron-3-super-120b-a12b:free', display_name: 'Nemotron 3 Super 120B (free)', intelligence_rank: 22, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 1000000, enabled: 1 },
    { platform: 'openrouter', model_id: 'inclusionai/ling-2.6-flash:free', display_name: 'Ling 2.6 Flash (free)', intelligence_rank: 7, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'nvidia/nemotron-3-nano-30b-a3b:free', display_name: 'Nemotron 3 Nano 30B (free)', intelligence_rank: 22, speed_rank: 9, size_label: 'Medium', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'nousresearch/hermes-3-llama-3.1-405b:free', display_name: 'Hermes 3 405B (free)', intelligence_rank: 17, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'openrouter', model_id: 'google/gemma-4-31b-it:free', display_name: 'Gemma 4 31B (free)', intelligence_rank: 19, speed_rank: 9, size_label: 'Medium', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'liquid/lfm-2.5-1.2b-instruct:free', display_name: 'Liquid LFM 2.5 1.2B (free)', intelligence_rank: 30, speed_rank: 10, size_label: 'Small', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 32768, enabled: 1 },
    { platform: 'openrouter', model_id: 'inclusionai/ling-2.6-1t:free', display_name: 'Ling 2.6 1T (free)', intelligence_rank: 4, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'tencent/hy3-preview:free', display_name: 'Tencent HY3 Preview (free)', intelligence_rank: 7, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'poolside/laguna-m.1:free', display_name: 'Poolside Laguna M.1 (free)', intelligence_rank: 13, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'openrouter', model_id: 'google/gemma-4-26b-a4b-it:free', display_name: 'Gemma 4 26B-A4B (free)', intelligence_rank: 22, speed_rank: 9, size_label: 'Medium', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', display_name: 'Nemotron 3 Nano 30B Reasoning (free)', intelligence_rank: 23, speed_rank: 9, size_label: 'Medium', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'poolside/laguna-xs.2:free', display_name: 'Poolside Laguna XS.2 (free)', intelligence_rank: 26, speed_rank: 10, size_label: 'Medium', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'openrouter', model_id: 'nvidia/nemotron-nano-9b-v2:free', display_name: 'Nemotron Nano 9B v2 (free)', intelligence_rank: 28, speed_rank: 10, size_label: 'Medium', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 128000, enabled: 1 },
    { platform: 'openrouter', model_id: 'liquid/lfm-2.5-1.2b-thinking:free', display_name: 'Liquid LFM 2.5 1.2B Thinking (free)', intelligence_rank: 30, speed_rank: 10, size_label: 'Small', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 32768, enabled: 1 },
    { platform: 'openrouter', model_id: 'arcee-ai/trinity-large-thinking:free', display_name: 'Trinity Large Thinking (free)', intelligence_rank: 5, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 262144, enabled: 1 },
    { platform: 'openrouter', model_id: 'baidu/cobuddy:free', display_name: 'CoBuddy (free)', intelligence_rank: 6, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'openrouter', model_id: 'openrouter/owl-alpha', display_name: 'Owl Alpha (OR-house)', intelligence_rank: 5, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 1048576, enabled: 1 },
    { platform: 'openrouter', model_id: 'nousresearch/hermes-3-llama-3.1-405b:free', display_name: 'Hermes 3 405B (free)', intelligence_rank: 17, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~6M', context_window: 131072, enabled: 1 },
    { platform: 'github', model_id: 'gpt-4o', display_name: 'GPT-4o', intelligence_rank: 21, speed_rank: 7, size_label: 'Large', rpm_limit: 10, rpd_limit: 50, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~18M', context_window: 8000, enabled: 1 },
    { platform: 'github', model_id: 'openai/gpt-4.1', display_name: 'GPT-4.1 (GitHub)', intelligence_rank: 20, speed_rank: 7, size_label: 'Large', rpm_limit: 10, rpd_limit: 50, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~9M', context_window: 128000, enabled: 1 },
    { platform: 'cohere', model_id: 'command-r-plus-08-2024', display_name: 'Command R+ (08-2024)', intelligence_rank: 23, speed_rank: 11, size_label: 'Large', rpm_limit: 20, rpd_limit: 33, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~1-2M', context_window: 131072, enabled: 1 },
    { platform: 'cohere', model_id: 'command-a-03-2025', display_name: 'Command-A (03-2025)', intelligence_rank: 22, speed_rank: 11, size_label: 'Large', rpm_limit: 20, rpd_limit: 33, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~1-2M', context_window: 131072, enabled: 1 },
    { platform: 'cohere', model_id: 'command-a-reasoning-08-2025', display_name: 'Command A Reasoning (08-2025)', intelligence_rank: 13, speed_rank: 11, size_label: 'Large', rpm_limit: 20, rpd_limit: 33, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~1-2M', context_window: 256000, enabled: 1 },
    { platform: 'cohere', model_id: 'command-r-08-2024', display_name: 'Command R (08-2024)', intelligence_rank: 25, speed_rank: 11, size_label: 'Medium', rpm_limit: 20, rpd_limit: 33, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~1-2M', context_window: 131072, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', display_name: 'Llama 3.3 70B fp8-fast (CF)', intelligence_rank: 16, speed_rank: 11, size_label: 'Medium', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~18-45M', context_window: 24000, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/qwen/qwen3-30b-a3b-fp8', display_name: 'Qwen3 30B-A3B fp8 (CF)', intelligence_rank: 7, speed_rank: 11, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~18-45M', context_window: 131072, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', display_name: 'DeepSeek R1 Distill Qwen 32B (CF)', intelligence_rank: 9, speed_rank: 11, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~3-5M', context_window: 131072, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/openai/gpt-oss-120b', display_name: 'GPT-OSS 120B (CF)', intelligence_rank: 6, speed_rank: 11, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~18-45M', context_window: 131072, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/zai-org/glm-4.7-flash', display_name: 'GLM-4.7 Flash (CF)', intelligence_rank: 10, speed_rank: 11, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~18-45M', context_window: 131072, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/meta/llama-4-scout-17b-16e-instruct', display_name: 'Llama 4 Scout (CF)', intelligence_rank: 12, speed_rank: 11, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~18-45M', context_window: 131072, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/moonshotai/kimi-k2.6', display_name: 'Kimi K2.6 (CF)', intelligence_rank: 2, speed_rank: 11, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~10-20M', context_window: 262144, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/ibm-granite/granite-4.0-h-micro', display_name: 'Granite 4.0 H Micro (CF)', intelligence_rank: 29, speed_rank: 11, size_label: 'Small', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~5-10M', context_window: 131072, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/nvidia/nemotron-3-120b-a12b', display_name: 'Nemotron 3 120B (CF)', intelligence_rank: 9, speed_rank: 11, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~5-10M', context_window: 262144, enabled: 1 },
    { platform: 'cloudflare', model_id: '@cf/google/gemma-4-26b-a4b-it', display_name: 'Gemma 4 26B-A4B it (CF)', intelligence_rank: 22, speed_rank: 11, size_label: 'Medium', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~10-20M', context_window: 262144, enabled: 1 },
    { platform: 'google', model_id: 'gemini-3.1-flash-lite-preview', display_name: 'Gemini 3.1 Flash-Lite Preview', intelligence_rank: 18, speed_rank: 3, size_label: 'Medium', rpm_limit: 15, rpd_limit: 20, tpm_limit: 250000, tpd_limit: null, monthly_token_budget: '~3M', context_window: 1048576, enabled: 1 },
    { platform: 'google', model_id: 'gemini-3-flash-preview', display_name: 'Gemini 3 Flash Preview', intelligence_rank: 11, speed_rank: 5, size_label: 'Large', rpm_limit: 10, rpd_limit: 20, tpm_limit: 250000, tpd_limit: null, monthly_token_budget: '~3M', context_window: 1048576, enabled: 1 },
    { platform: 'google', model_id: 'gemini-3.1-pro-preview', display_name: 'Gemini 3.1 Pro Preview', intelligence_rank: 1, speed_rank: 8, size_label: 'Frontier', rpm_limit: 5, rpd_limit: 20, tpm_limit: 250000, tpd_limit: null, monthly_token_budget: '~3M', context_window: 1048576, enabled: 0 },
    { platform: 'google', model_id: 'gemini-3.5-flash', display_name: 'Gemini 3.5 Flash', intelligence_rank: 3, speed_rank: 5, size_label: 'Large', rpm_limit: 10, rpd_limit: 20, tpm_limit: 250000, tpd_limit: null, monthly_token_budget: '~3M', context_window: 1048576, enabled: 1 },
    { platform: 'zhipu', model_id: 'glm-4.5-flash', display_name: 'GLM-4.5 Flash', intelligence_rank: 24, speed_rank: 4, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: 1000000, monthly_token_budget: '~30M', context_window: 131072, enabled: 1 },
    { platform: 'zhipu', model_id: 'glm-4.7-flash', display_name: 'GLM-4.7 Flash', intelligence_rank: 18, speed_rank: 4, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: 1000000, monthly_token_budget: '~30M', context_window: 131072, enabled: 1 },
    { platform: 'ollama', model_id: 'qwen3-coder:480b', display_name: 'Qwen3-Coder 480B (Ollama)', intelligence_rank: 2, speed_rank: 9, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~5-10M', context_window: 262144, enabled: 1 },
    { platform: 'ollama', model_id: 'mistral-large-3:675b', display_name: 'Mistral Large 3 675B (Ollama)', intelligence_rank: 3, speed_rank: 9, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~5-10M', context_window: 131072, enabled: 0 },
    { platform: 'ollama', model_id: 'deepseek-v3.2', display_name: 'DeepSeek V3.2 (Ollama)', intelligence_rank: 4, speed_rank: 9, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~5-10M', context_window: 131072, enabled: 0 },
    { platform: 'ollama', model_id: 'cogito-2.1:671b', display_name: 'Cogito 2.1 671B (Ollama)', intelligence_rank: 4, speed_rank: 9, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~5-10M', context_window: 131072, enabled: 1 },
    { platform: 'ollama', model_id: 'kimi-k2-thinking', display_name: 'Kimi K2 Thinking (Ollama)', intelligence_rank: 5, speed_rank: 9, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~5-10M', context_window: 131072, enabled: 0 },
    { platform: 'ollama', model_id: 'glm-4.7', display_name: 'GLM-4.7 (Ollama)', intelligence_rank: 6, speed_rank: 9, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~5-10M', context_window: 131072, enabled: 1 },
    { platform: 'ollama', model_id: 'gpt-oss:120b', display_name: 'GPT-OSS 120B (Ollama)', intelligence_rank: 6, speed_rank: 9, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~10-20M', context_window: 131072, enabled: 1 },
    { platform: 'ollama', model_id: 'devstral-2:123b', display_name: 'Devstral 2 123B (Ollama)', intelligence_rank: 8, speed_rank: 10, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~10-20M', context_window: 131072, enabled: 1 },
    { platform: 'ollama', model_id: 'gpt-oss:20b', display_name: 'GPT-OSS 20B (Ollama)', intelligence_rank: 18, speed_rank: 10, size_label: 'Medium', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~20-30M', context_window: 131072, enabled: 1 },
    { platform: 'ollama', model_id: 'gemma4:31b', display_name: 'Gemma 4 31B (Ollama)', intelligence_rank: 22, speed_rank: 10, size_label: 'Medium', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~20-30M', context_window: 131072, enabled: 1 },
    { platform: 'ollama', model_id: 'qwen3-coder-next', display_name: 'Qwen3-Coder Next (Ollama)', intelligence_rank: 3, speed_rank: 9, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~10-20M', context_window: 262144, enabled: 1 },
    { platform: 'kilo', model_id: 'nvidia/nemotron-3-super-120b-a12b:free', display_name: 'Nemotron 3 Super 120B (Kilo)', intelligence_rank: 22, speed_rank: 9, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2-3M (200/hr)', context_window: 262144, enabled: 1 },
    { platform: 'pollinations', model_id: 'openai-fast', display_name: 'GPT-OSS 20B (Pollinations)', intelligence_rank: 18, speed_rank: 10, size_label: 'Medium', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~? (anon)', context_window: 131072, enabled: 1 },
    { platform: 'llm7', model_id: 'gpt-oss-20b', display_name: 'GPT-OSS 20B (LLM7)', intelligence_rank: 18, speed_rank: 10, size_label: 'Medium', rpm_limit: 100, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2-3M (100/hr)', context_window: 131072, enabled: 1 },
    { platform: 'llm7', model_id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', display_name: 'Llama 3.1 8B Turbo (LLM7)', intelligence_rank: 28, speed_rank: 10, size_label: 'Small', rpm_limit: 100, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2-3M (100/hr)', context_window: 131072, enabled: 1 },
    { platform: 'llm7', model_id: 'codestral-latest', display_name: 'Codestral (LLM7)', intelligence_rank: 16, speed_rank: 8, size_label: 'Medium', rpm_limit: 100, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2-3M (100/hr)', context_window: 32000, enabled: 1 },
    { platform: 'llm7', model_id: 'ministral-8b-2512', display_name: 'Ministral 8B (LLM7)', intelligence_rank: 28, speed_rank: 10, size_label: 'Small', rpm_limit: 100, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2-3M (100/hr)', context_window: 131072, enabled: 1 },
    { platform: 'llm7', model_id: 'GLM-4.6V-Flash', display_name: 'GLM-4.6V Flash (LLM7)', intelligence_rank: 15, speed_rank: 9, size_label: 'Large', rpm_limit: 100, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~2-3M (100/hr)', context_window: 131072, enabled: 1 },
    { platform: 'huggingface', model_id: 'deepseek-ai/DeepSeek-V4-Flash', display_name: 'DeepSeek V4 Flash (HF)', intelligence_rank: 4, speed_rank: 9, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~1-3M', context_window: 131072, enabled: 1 },
    { platform: 'huggingface', model_id: 'moonshotai/Kimi-K2.6', display_name: 'Kimi K2.6 (HF)', intelligence_rank: 3, speed_rank: 9, size_label: 'Frontier', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~1-3M', context_window: 262144, enabled: 1 },
    { platform: 'huggingface', model_id: 'Qwen/Qwen3-Coder-Next', display_name: 'Qwen3-Coder Next (HF)', intelligence_rank: 3, speed_rank: 9, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, tpd_limit: null, monthly_token_budget: '~1-3M', context_window: 262144, enabled: 1 },
  ];
}
