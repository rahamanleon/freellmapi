// List the model IDs the gateway exposes to clients (GET /v1/models).
// Reads the unified key from SQLite; never prints it.
//
// Usage:
//   node ops/scripts/list-models.mjs [baseUrl] [filter]

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const dbPath = path.join(root, 'freellmapi', 'server', 'data', 'freeapi.db');
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3001';
const filter = process.argv[3];

const db = new DatabaseSync(dbPath, { readOnly: true });
const key = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get()?.value;
db.close();

const res = await fetch(`${baseUrl}/v1/models`, {
  headers: { authorization: `Bearer ${key}` },
});
console.log(`HTTP ${res.status}`);
const body = await res.json();
let list = body.data ?? [];
if (filter) list = list.filter((m) => m.id.includes(filter));
console.log(`models: ${list.length}${filter ? ` (filtered by "${filter}")` : ''}\n`);
for (const m of list) {
  const bits = [];
  if (m.owned_by) bits.push(m.owned_by);
  if (m.context_window) bits.push(`ctx=${m.context_window}`);
  console.log(`  ${m.id}${bits.length ? `   [${bits.join(', ')}]` : ''}`);
}
