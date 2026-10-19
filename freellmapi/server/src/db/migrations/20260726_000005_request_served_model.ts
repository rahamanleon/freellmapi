// Migration: requests.served_model — upstream-reported model when it drifts
// Created: 2026-07-26
//
// DOWN: reversible
//
// The proxy overwrites the upstream `model` field with the routed id before
// the caller sees it (the gateway contract), which also destroyed the only
// evidence when a provider silently serves a DIFFERENT model than requested
// (#534 — verified live: kilo-auto/small serving Gemma). The served-model
// guard (lib/served-model.ts) now captures the raw upstream value before the
// overwrite; this column persists it — but ONLY when it genuinely differs
// from the routed model id after cosmetic normalization (case, provider
// prefix, ":free"-style tier suffixes). NULL means "matched (or upstream
// reported nothing usable)", which keeps the column empty in the healthy case
// and makes drifted rows trivially queryable:
//   SELECT ... FROM requests WHERE served_model IS NOT NULL;

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'requests', 'served_model')) {
    db.prepare('ALTER TABLE requests ADD COLUMN served_model TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'requests', 'served_model')) {
    db.prepare('ALTER TABLE requests DROP COLUMN served_model').run();
  }
}
