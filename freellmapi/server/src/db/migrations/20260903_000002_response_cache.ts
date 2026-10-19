// Migration: persistent response cache
// Created: 2026-09-03
//
// DOWN: reversible
//
// The response cache (services/cache.ts) is a pure in-memory LRU today: a
// restart drops every entry, so the daily quota-reset re-run pattern (same
// tasks re-executed after UTC midnight) never benefits. This table gives the
// cache a durable backing store while keeping the in-memory LRU as the hot
// path: storeCachedResponse writes through, startup reloads unexpired rows.
//
// Note this puts PLAINTEXT model responses on disk, which the memory-only cache
// never did. It is therefore tied to the cache master switch (off by default)
// and separately disableable with RESPONSE_CACHE_PERSIST=false.
//
// cache_key is the canonical SHA-256 from computeCacheKey (PK).
// body_json is the full OpenAI-shaped completion, replayed verbatim on a hit.
// hit_count / last_hit_at_ms carry the savings stats: a store writes them and
// every hit updates the row, so the dashboard numbers survive a restart. Both
// writes are queued off the proxy hot path (services/cache.ts drains them on
// the next tick) because better-sqlite3 is synchronous.
// created_at_ms anchors TTL checks; expires_at_ms is a denormalized
// created_at_ms + TTL for cheap startup purges and index scans.
// Rows are dropped whenever their memory entry goes (TTL expiry, LRU eviction,
// DELETE /api/cache) plus a startup sweep, so the table stays LRU-bounded.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS response_cache (
      cache_key TEXT PRIMARY KEY,
      body_json TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      last_hit_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );

    -- Startup purge and expiry sweeps scan by TTL.
    CREATE INDEX IF NOT EXISTS idx_response_cache_expires
      ON response_cache(expires_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_response_cache_expires;
    DROP TABLE IF EXISTS response_cache;
  `);
}
