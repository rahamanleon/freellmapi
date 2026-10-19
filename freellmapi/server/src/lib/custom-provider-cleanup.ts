import type { Db } from '../db/types.js';

function boundModelCount(db: Db, keyId: number): number {
  const chat = db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'custom' AND key_id = ?").get(keyId) as { n: number };
  const embeddings = db.prepare("SELECT COUNT(*) AS n FROM embedding_models WHERE platform = 'custom' AND key_id = ?").get(keyId) as { n: number };
  const media = db.prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform = 'custom' AND key_id = ?").get(keyId) as { n: number };
  return chat.n + embeddings.n + media.n;
}

/** Everything still registered against an endpoint, across every key of its pool. */
function endpointModelCount(db: Db, baseUrl: string): number {
  const count = (table: string) => (db.prepare(`
    SELECT COUNT(*) AS n
      FROM ${table} m
      JOIN api_keys k ON k.id = m.key_id
     WHERE m.platform = 'custom' AND k.platform = 'custom' AND k.base_url = ?
  `).get(baseUrl) as { n: number }).n;
  return count('models') + count('embedding_models') + count('media_models');
}

/**
 * Drop the api_keys row(s) of a custom endpoint that nothing is registered
 * against any more, called after a custom model is deleted.
 *
 * The unit of "unused" is the ENDPOINT, not the single key. An endpoint holds a
 * pool of credentials (#619) and each model binds to just one of them, so a key
 * with nothing bound to it is usually a spare the operator added for rotation,
 * not dead weight. Reaping on the key's own count deleted such a spare as soon
 * as the model it happened to arrive with was removed (#702).
 */
export function deleteUnusedCustomEndpointKey(db: Db, keyId: number | null | undefined) {
  if (keyId == null) return;

  const row = db.prepare("SELECT base_url FROM api_keys WHERE id = ? AND platform = 'custom'")
    .get(keyId) as { base_url: string | null } | undefined;

  // No base_url means no pool to belong to, so the key answers for itself.
  if (!row?.base_url) {
    if (boundModelCount(db, keyId) > 0) return;
    db.prepare("DELETE FROM api_keys WHERE id = ? AND platform = 'custom'").run(keyId);
    return;
  }

  if (endpointModelCount(db, row.base_url) > 0) return;

  db.prepare("DELETE FROM api_keys WHERE platform = 'custom' AND base_url = ?").run(row.base_url);
}
