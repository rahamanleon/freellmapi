// Migration: decision request log
// Created: 2026-10-16
//
// DOWN: reversible (drops decision_requests)
//
// Decision models live in media_models with modality = 'decision', maintained
// by the catalog's `decisionModels` registry exactly like search engines.
// Nothing is seeded here: the catalog decides which installs get which models.
//
// decision_requests is its own log rather than more `requests` rows, for the
// same reason as search_requests: a decision has no completion tokens, and
// keeping it out of `requests` keeps chat analytics and success rates clean.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      model_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
      latency_ms INTEGER NOT NULL DEFAULT 0,
      question_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      client_agent TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decision_requests_created_at ON decision_requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_decision_requests_model_created ON decision_requests(model_id, created_at);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_decision_requests_model_created;
    DROP INDEX IF EXISTS idx_decision_requests_created_at;
    DROP TABLE IF EXISTS decision_requests;
  `);
}
