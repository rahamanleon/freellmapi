// Migration: search request log (#1174)
// Created: 2026-10-13
//
// DOWN: reversible (drops search_requests)
//
// Search engines live in media_models with modality = 'search' and
// model_id = the engine id, maintained by the catalog's `searchEngines`
// registry exactly like video rows. Nothing is seeded here on purpose: new
// engines reach Premium installs first and Free installs 30 days later through
// the catalog, so a bundled baseline would hand every install all of them on
// day one and then have the free catalog's sync take them away again.
//
// search_requests is its own log rather than more `requests` rows: a search
// has no tokens or model, and keeping it out of `requests` keeps the chat
// analytics, success rates and request log free of search traffic.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      engine_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
      latency_ms INTEGER NOT NULL DEFAULT 0,
      result_count INTEGER NOT NULL DEFAULT 0,
      client_agent TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_search_requests_created_at ON search_requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_search_requests_engine_created ON search_requests(engine_id, created_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_search_requests_engine_created;
    DROP INDEX IF EXISTS idx_search_requests_created_at;
    DROP TABLE IF EXISTS search_requests;
  `);
}
