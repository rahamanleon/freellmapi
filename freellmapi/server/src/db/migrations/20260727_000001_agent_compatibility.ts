import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(entry => entry.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'requests', 'client_agent')) {
    db.prepare('ALTER TABLE requests ADD COLUMN client_agent TEXT').run();
  }
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_requests_client_agent_created ON requests(client_agent, created_at)',
  ).run();

  db.exec(`
    CREATE TABLE IF NOT EXISTS url_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      token_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_url_tokens_active
      ON url_tokens(token_hash, revoked_at);
  `);

  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('ollama_emulation', 'off') ON CONFLICT(key) DO NOTHING",
  ).run();
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('expose_cc_discovery_aliases', '0') ON CONFLICT(key) DO NOTHING",
  ).run();
}

export function down(db: Db): void {
  db.prepare('DROP TABLE IF EXISTS url_tokens').run();
  db.prepare('DROP INDEX IF EXISTS idx_requests_client_agent_created').run();
  if (hasColumn(db, 'requests', 'client_agent')) {
    db.prepare('ALTER TABLE requests DROP COLUMN client_agent').run();
  }
  db.prepare(`
    DELETE FROM settings
    WHERE key IN (
      'ollama_emulation',
      'expose_cc_discovery_aliases',
      'gemini_model_map'
    )
  `).run();
}
