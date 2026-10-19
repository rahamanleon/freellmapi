// Migration: persistent Playground conversations
// Created: 2026-08-20
//
// DOWN: reversible
//
// The Playground transcript used to live only in React state: a reload, a
// navigation away, or the "Clear" button threw the whole conversation away.
// This table gives it a home. One row per conversation, no user scoping —
// this is a single-user dashboard, and the existing `sessions` table is the
// dashboard LOGIN session (token_hash -> user), nothing to do with chats.
//
// messages_json holds the entire ChatMessage[] the page renders, `meta`
// routing info and `reasoning` included, so a restored transcript looks
// exactly like the live one rather than a lossy replay. It is deliberately a
// single opaque blob: the dashboard is the only reader, the shape is the
// client's, and normalising turns into rows would buy nothing but joins.
// The router caps writes well below any practical SQLite limit.
//
// model is the picker selection at the time of the conversation ('auto',
// 'fusion', or a canonical model id) and system_prompt its optional system
// message, so switching conversations restores the whole setup, not just the
// text. Timestamps are epoch milliseconds (like sessions.expires_at_ms)
// because the sidebar renders them as relative times in the browser's clock.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      messages_json TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      system_prompt TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    -- The sidebar's only query: most recently touched first.
    CREATE INDEX IF NOT EXISTS idx_playground_conversations_updated
      ON playground_conversations(updated_at_ms DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_playground_conversations_updated;
    DROP TABLE IF EXISTS playground_conversations;
  `);
}
