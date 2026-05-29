import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, isMongo, getApiKeysCollection } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';

export const keysRouter = Router();

const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'huggingface',
] as const;

const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().min(1),
  label: z.string().optional(),
});

keysRouter.get('/', async (_req: Request, res: Response) => {
  let rows: any[];
  if (isMongo()) {
    const col = getApiKeysCollection();
    rows = await col.find().sort({ created_at: -1 }).toArray();
  } else {
    const db = getDb();
    rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];
  }

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id ?? row._id?.toString(),
      platform: row.platform,
      label: row.label,
      maskedKey,
      status: row.status,
      enabled: row.enabled === 1 || row.enabled === true,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

keysRouter.post('/', async (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, key, label } = parsed.data;
  const { encrypted, iv, authTag } = encrypt(key);

  let id: any;
  if (isMongo()) {
    const col = getApiKeysCollection();
    const result = await col.insertOne({
      platform, label: label ?? '', encrypted_key: encrypted, iv, auth_tag: authTag,
      status: 'unknown', enabled: 1, created_at: new Date().toISOString(), last_checked_at: null,
    });
    id = result.insertedId.toString();
  } else {
    const db = getDb();
    const result = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, 'unknown', 1)
    `).run(platform, label ?? '', encrypted, iv, authTag);
    id = result.lastInsertRowid;
  }

  res.status(201).json({
    id, platform, label: label ?? '', maskedKey: maskKey(key), status: 'unknown', enabled: true,
  });
});

keysRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  let changes = 0;
  if (isMongo()) {
    const col = getApiKeysCollection();
    const result = await col.deleteOne({ _id: id as any });
    changes = result.deletedCount;
  } else {
    const db = getDb();
    const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    changes = result.changes;
  }

  if (changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true });
});

keysRouter.patch('/platform/:platform', async (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  let changes = 0;
  if (isMongo()) {
    const col = getApiKeysCollection();
    const result = await col.updateMany({ platform }, { $set: { enabled: enabled ? 1 : 0 } });
    changes = result.modifiedCount;
  } else {
    const db = getDb();
    const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);
    changes = result.changes;
  }

  res.json({ success: true, enabled, updatedKeys: changes });
});

keysRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  let changes = 0;
  if (isMongo()) {
    const col = getApiKeysCollection();
    const result = await col.updateOne({ _id: id as any }, { $set: { enabled: enabled ? 1 : 0 } });
    if (result.matchedCount === 0) changes = 0;
    else changes = 1;
  } else {
    const db = getDb();
    const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    changes = result.changes;
  }

  if (changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true, enabled });
});
