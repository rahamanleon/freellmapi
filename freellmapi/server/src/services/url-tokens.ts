import crypto from 'crypto';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { timingSafeStringEqual } from '../routes/proxy.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface UrlTokenRow {
  id: number;
  label: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function listUrlTokens(): UrlTokenRow[] {
  const rows = getDb().prepare(`
    SELECT id, label, token_prefix, created_at, last_used_at, revoked_at
    FROM url_tokens
    ORDER BY id DESC
  `).all() as Array<{
    id: number;
    label: string;
    token_prefix: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }>;
  return rows.map(row => ({
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }));
}

export function mintUrlToken(label: string): UrlTokenRow & { token: string } {
  const token = `flmurl_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = `${token.slice(0, 12)}…`;
  const result = getDb().prepare(`
    INSERT INTO url_tokens (token_hash, label, token_prefix)
    VALUES (?, ?, ?)
  `).run(hashToken(token), label.trim(), prefix);
  const row = listUrlTokens().find(entry => entry.id === Number(result.lastInsertRowid))!;
  return { ...row, token };
}

export function revokeUrlToken(id: number): boolean {
  return getDb().prepare(`
    UPDATE url_tokens SET revoked_at = datetime('now')
    WHERE id = ? AND revoked_at IS NULL
  `).run(id).changes > 0;
}

export function validateUrlToken(token: string): boolean {
  if (!token || timingSafeStringEqual(token, getUnifiedApiKey())) {
    if (token) {
      console.warn('[URL tokens] Rejected a raw unified API key in a tokenized URL');
    }
    return false;
  }
  const hash = hashToken(token);
  const row = getDb().prepare(`
    SELECT id FROM url_tokens
    WHERE token_hash = ? AND revoked_at IS NULL
  `).get(hash) as { id: number } | undefined;
  if (!row) return false;
  getDb().prepare(
    "UPDATE url_tokens SET last_used_at = datetime('now') WHERE id = ?",
  ).run(row.id);
  return true;
}
