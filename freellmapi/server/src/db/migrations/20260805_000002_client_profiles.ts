// Migration: per-client API keys with server-enforced system prompts (#411)
// Created: 2026-08-05
//
// DOWN: reversible
//
// One row per downstream client/product. Auth lookups go through token_hash
// (SHA-256 of the full `sk-cp-...` key) so the plaintext credential is never
// queried; encrypted_key/iv/auth_tag hold an AES-256-GCM copy (same crypto
// layer as api_keys — lib/crypto.ts) used only to render the masked key in
// the dashboard. system_prompt is the prompt the proxy prepends server-side
// for requests authenticated with this profile's key; NULL/empty means the
// key authenticates without injecting anything. Disabled rows are rejected
// at auth exactly like unknown keys.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      system_prompt TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS client_profiles;');
}
