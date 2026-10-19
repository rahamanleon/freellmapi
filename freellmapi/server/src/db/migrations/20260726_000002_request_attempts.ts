// Migration: per-attempt routing traces (request_attempts)
// Created: 2026-07-26
//
// DOWN: reversible
//
// When a request walks the failover ladder (groq 429 → google timeout →
// cerebras ok), the `requests` table records isolated rows with no linkage,
// ordering, or per-attempt timing — the journey that explains "why was this
// slow/failed" is invisible. `request_attempts` stores one row per dispatched
// attempt (including the successful final one), keyed to the TERMINAL
// `requests` row of the ladder: provider, model, per-request key ordinal
// (never the internal key id), outcome class, start offset from the ladder's
// start, and duration.
//
// ON DELETE CASCADE ties child rows to the requests retention prune
// (services/request-retention.ts): the connection opens with
// PRAGMA foreign_keys = ON (db/index.ts), so pruning a parent removes its
// attempts with no extra query and no unbounded growth.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_ordinal INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      start_offset_ms INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_request_attempts_request_id
      ON request_attempts(request_id, ordinal);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_request_attempts_request_id;
    DROP TABLE IF EXISTS request_attempts;
  `);
}
