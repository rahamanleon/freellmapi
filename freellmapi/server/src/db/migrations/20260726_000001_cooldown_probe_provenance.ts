// Migration: cooldown provenance for probe-based early recovery
// Created: 2026-07-26
//
// DOWN: reversible
//
// The cooldown-probe recovery job (services/cooldown-probe.ts) may only probe
// cooldowns that are OUR OWN guesses. A cooldown backed by an authoritative
// retry time (explicit Retry-After, daily-quota reset) is a fact the provider
// told us; probing those wastes validate calls and can never legitimately clear
// them early. `source` records that provenance at setCooldown time; `set_at_ms`
// records when the bench started, so the prober can wait out a fraction of the
// bench before the first probe instead of probing a seconds-old cooldown.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'rate_limit_cooldowns', 'source')) {
    // Pre-existing rows default to 'heuristic' (probe-eligible): before this
    // migration every cooldown kind was mixed together, and a spurious probe on
    // an old authoritative row costs one cheap validate call at worst.
    db.prepare("ALTER TABLE rate_limit_cooldowns ADD COLUMN source TEXT NOT NULL DEFAULT 'heuristic'").run();
  }
  if (!hasColumn(db, 'rate_limit_cooldowns', 'set_at_ms')) {
    // Nullable: rows written before this migration have an unknown start time,
    // which the prober treats as "old enough to probe".
    db.prepare('ALTER TABLE rate_limit_cooldowns ADD COLUMN set_at_ms INTEGER').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'rate_limit_cooldowns', 'source')) {
    db.prepare('ALTER TABLE rate_limit_cooldowns DROP COLUMN source').run();
  }
  if (hasColumn(db, 'rate_limit_cooldowns', 'set_at_ms')) {
    db.prepare('ALTER TABLE rate_limit_cooldowns DROP COLUMN set_at_ms').run();
  }
}
