// Migration: rename legacy 'Custom' endpoint labels to their host (#704)
// Created: 2026-08-02
//
// DOWN: reversible (see below)
//
// Custom endpoints registered before #705 all took the literal label 'Custom',
// so every panel that identifies a key by its label alone — analytics,
// cooldowns, quota signals, the models list — showed a column of identical
// rows once more than one relay was configured. New endpoints now default to
// the endpoint's host, but that only helped installs starting from scratch:
// an upgrade kept the indistinguishable labels already on record.
//
// Only rows still holding the exact default are touched. A label the operator
// typed (including one they deliberately typed as 'Custom' — indistinguishable
// from the default, and renaming it to the host is the same outcome they would
// get by re-adding the endpoint) is the only ambiguity; anything else they
// named stays untouched.
//
// Data only — no schema change.

import type { Db } from '../types.js';

interface KeyRow { id: number; base_url: string | null }

/** The host of an endpoint URL, or null when there is nothing usable to
 *  rename to. Mirrors defaultCustomEndpointLabel in services/custom-endpoint,
 *  inlined so this migration keeps working if that helper later changes. */
function hostOf(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

export function up(db: Db): void {
  const rows = db.prepare(
    "SELECT id, base_url FROM api_keys WHERE platform = 'custom' AND label = 'Custom'",
  ).all() as KeyRow[];
  const update = db.prepare('UPDATE api_keys SET label = ? WHERE id = ?');
  for (const row of rows) {
    const host = hostOf(row.base_url);
    if (host) update.run(host, row.id);
  }
}

/** Put back the generic label on every custom endpoint that currently carries
 *  exactly its own host, which is the set `up` could have produced. */
export function down(db: Db): void {
  const rows = db.prepare(
    "SELECT id, label, base_url FROM api_keys WHERE platform = 'custom'",
  ).all() as (KeyRow & { label: string | null })[];
  const update = db.prepare("UPDATE api_keys SET label = 'Custom' WHERE id = ?");
  for (const row of rows) {
    if (row.label && row.label === hostOf(row.base_url)) update.run(row.id);
  }
}
