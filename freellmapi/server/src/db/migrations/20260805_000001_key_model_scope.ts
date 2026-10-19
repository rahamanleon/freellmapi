import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/** Optional per-key model scope (#657): a JSON array of model_id strings the
 *  key may serve. NULL = the key serves every model of its platform. */
export function up(db: Db): void {
  if (!hasColumn(db, 'api_keys', 'model_scope_json')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN model_scope_json TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'api_keys', 'model_scope_json')) {
    db.prepare('ALTER TABLE api_keys DROP COLUMN model_scope_json').run();
  }
}
