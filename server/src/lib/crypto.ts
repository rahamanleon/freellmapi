import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { isMongo } from '../db/index.js';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';

function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

function isDevFallbackAllowed(): boolean {
  return process.env.DEV_MODE === 'true' && process.env.NODE_ENV !== 'production';
}

function missingKeyError(): Error {
  return new Error(
    'ENCRYPTION_KEY is required for API key encryption. ' +
    `Set a ${KEY_HEX_LEN}-char hex key, or set DEV_MODE=true outside production to allow a local DB-stored fallback key.`,
  );
}

function readEnvKey(): boolean {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== PLACEHOLDER_KEY) {
    cachedKey = parseHexKey(envKey, 'env');
    return true;
  }
  return false;
}

export function initEncryptionKey(db?: Database.Database): void {
  // 1. Check env var
  if (readEnvKey()) return;

  if (!isDevFallbackAllowed()) {
    throw missingKeyError();
  }

  // 2. Dev fallback — read from DB
  if (isMongo()) {
    // For MongoDB, the key is seeded in mongo/index.ts seed function.
    // Read it asynchronously would be complex here since initEncryptionKey
    // is called sync from initSqlite. For MongoDB, the env var is required
    // in production. In dev mode with MongoDB, fall back to DB-stored key.
    // This is handled by the async getEncryptionKey in mongo/index.ts.
    // For now, try synchronous access (may work if already cached).
    throw missingKeyError();
  }

  if (!db) {
    throw new Error('SQLite db required for encryption key fallback');
  }

  const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
  if (row) {
    cachedKey = parseHexKey(row.value, 'db');
    return;
  }

  cachedKey = crypto.randomBytes(KEY_BYTES);
  db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(cachedKey.toString('hex'));
}

export async function initEncryptionKeyMongo(): Promise<void> {
  if (readEnvKey()) return;

  if (!isDevFallbackAllowed()) {
    throw missingKeyError();
  }

  const { getEncryptionKey } = await import('../db/mongo/index.js');
  const key = await getEncryptionKey();
  if (key) {
    cachedKey = parseHexKey(key, 'db');
    return;
  }

  const newKey = crypto.randomBytes(KEY_BYTES).toString('hex');
  const { settingsCol } = await import('../db/mongo/index.js');
  await settingsCol().insertOne({ key: 'encryption_key', value: newKey });
  cachedKey = Buffer.from(newKey, 'hex');
}

function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error('Encryption key not initialized. Call initEncryptionKey() first.');
  }
  return cachedKey;
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 4) + '...' + key.slice(-4);
}
