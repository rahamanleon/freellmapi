// Migration: switch back on LLMTR keys the old key-validation probe disabled
// Created: 2026-10-17
//
// DOWN: reversible (the ids it switched on are kept in settings)
//
// Before v0.13.3 (#1390/#1416) LLMTR's 403 "automated API key validation tools
// are not supported" was read as an invalid key, and three of them in a row
// auto-disabled it (enabled = 0, status = 'invalid'). LLMTR answers every
// probe that way, so every LLMTR key added back then was switched off whether
// it worked or not. Later releases stopped probing LLMTR (#1459) but never
// switched those keys back on, so they could never serve the first request
// that now marks an LLMTR key healthy.
//
// Only that exact state is undone: an LLMTR key that is off AND marked
// invalid. A key the operator switched off while it was healthy, unchecked or
// erroring keeps its switch.

import type { Db } from '../types.js';

const SETTING_KEY = 'migration_llmtr_reenabled_key_ids';

export function up(db: Db): void {
  const ids = (db.prepare(`
    SELECT id FROM api_keys WHERE platform = 'llmtr' AND enabled = 0 AND status = 'invalid'
  `).all() as { id: number }[]).map(r => r.id);

  const reenable = db.prepare(`
    UPDATE api_keys SET enabled = 1, status = 'unknown', last_health_error = NULL WHERE id = ?
  `);
  for (const id of ids) reenable.run(id);

  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(SETTING_KEY, JSON.stringify(ids));
}

export function down(db: Db): void {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  const ids: number[] = row ? JSON.parse(row.value) : [];
  const disable = db.prepare("UPDATE api_keys SET enabled = 0, status = 'invalid' WHERE id = ? AND platform = 'llmtr'");
  for (const id of ids) disable.run(id);
  db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_KEY);
}
