import { getDb, isMongo, getApiKeysCollection } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;

const failureCount = new Map<number, number>();

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  let row: any;

  if (isMongo()) {
    const col = getApiKeysCollection();
    const doc = await col.findOne({ _id: keyId as any });
    if (!doc) return 'error';
    row = { id: doc._id, platform: doc.platform, encrypted_key: doc.encrypted_key, iv: doc.iv, auth_tag: doc.auth_tag };
  } else {
    const db = getDb();
    row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
    if (!row) return 'error';
  }

  const provider = getProvider(row.platform as Platform);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const isValid = await provider.validateKey(apiKey);

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    if (isMongo()) {
      const col = getApiKeysCollection();
      await col.updateOne(
        { _id: row.id as any },
        { $set: { status, last_checked_at: new Date().toISOString() } },
      );
    } else {
      const db = getDb();
      db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
        .run(status, keyId);
    }

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);

      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        if (isMongo()) {
          await getApiKeysCollection().updateOne({ _id: keyId as any }, { $set: { enabled: 0 } });
        } else {
          const db = getDb();
          db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').run(keyId);
        }
        console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
      }
    }

    return status;
  } catch (err: any) {
    console.error(`[Health] Key ${keyId} transport error:`, err.message);
    if (isMongo()) {
      await getApiKeysCollection().updateOne(
        { _id: keyId as any },
        { $set: { status: 'error', last_checked_at: new Date().toISOString() } },
      );
    } else {
      const db = getDb();
      db.prepare("UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?")
        .run('error', keyId);
    }
    return 'error';
  }
}

export async function checkAllKeys(): Promise<void> {
  let keys: { id: number; platform: string }[];

  if (isMongo()) {
    const col = getApiKeysCollection();
    const docs = await col.find({ enabled: 1 }).project({ _id: 1, platform: 1 }).toArray();
    keys = docs.map(d => ({ id: d._id.toString(), platform: d.platform }));
  } else {
    const db = getDb();
    keys = db.prepare('SELECT id, platform FROM api_keys WHERE enabled = 1').all() as { id: number; platform: string }[];
  }

  console.log(`[Health] Checking ${keys.length} keys...`);

  for (const key of keys) {
    await checkKeyHealth(isMongo() ? key.id as any : key.id);
  }

  console.log(`[Health] Check complete.`);
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startHealthChecker(): void {
  if (intervalId) return;
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  intervalId = setInterval(() => {
    checkAllKeys().catch(err => console.error('[Health] Check failed:', err));
  }, CHECK_INTERVAL_MS);
}

export function stopHealthChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
