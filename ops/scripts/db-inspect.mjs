// Read-only inspection of the FreeLLMAPI SQLite database.
// Never prints secret material (api keys, unified key, encryption key).
//
// Usage:
//   node ops/scripts/db-inspect.mjs [dbPath]

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

/** Short fingerprint of a secret. Lets two runs be compared without either
 *  run ever revealing the secret itself. */
const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

const root = path.resolve(import.meta.dirname, '..', '..');
const dbPath = process.argv[2] ?? path.join(root, 'freellmapi', 'server', 'data', 'freeapi.db');

const db = new DatabaseSync(dbPath, { readOnly: true });
const q = (sql, ...args) => db.prepare(sql).all(...args);

console.log(`db: ${dbPath}\n`);

// ---- platforms with keys (never the key material itself) --------------------
console.log('=== provider keys ===');
const keys = q(`
  SELECT platform, label, enabled, status, base_url IS NOT NULL AS is_custom
    FROM api_keys
   ORDER BY platform, id
`);
if (keys.length === 0) console.log('  (none)');
for (const k of keys) {
  const where = k.is_custom ? ' [custom endpoint]' : '';
  console.log(`  ${String(k.platform).padEnd(12)} label=${String(k.label).padEnd(10)} enabled=${k.enabled} status=${k.status}${where}`);
}

// ---- model catalog by platform ---------------------------------------------
console.log('\n=== enabled models per platform ===');
const perPlate = q(`
  SELECT platform, SUM(enabled) AS on_count, COUNT(*) AS total
    FROM models GROUP BY platform ORDER BY on_count DESC, platform
`);
for (const r of perPlate) {
  console.log(`  ${String(r.platform).padEnd(14)} enabled=${String(r.on_count).padStart(3)} / ${r.total}`);
}

// ---- the fallback chain, in route order ------------------------------------
console.log('\n=== fallback chain (priority order) ===');
const chain = q(`
  SELECT fc.priority, fc.enabled, m.platform, m.model_id, m.display_name
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
   ORDER BY fc.priority
`);
if (chain.length === 0) console.log('  (empty)');
for (const c of chain) {
  console.log(`  ${String(c.priority).padStart(3)} ${c.enabled ? 'on ' : 'off'} ${String(c.platform).padEnd(12)} ${c.model_id}`);
}

// ---- routing settings ------------------------------------------------------
console.log('\n=== routing settings ===');
const settings = q(`
  SELECT key, value FROM settings
   WHERE key LIKE '%routing%' OR key LIKE '%strategy%' OR key LIKE '%weight%' OR key LIKE '%unified%'
   ORDER BY key
`);
for (const s of settings) {
  // Redact anything that could be a credential, but keep a stable fingerprint
  // so a value can be compared across runs (e.g. before/after a restore).
  const isSecret = /unified|key|secret|token/i.test(s.key);
  console.log(`  ${s.key} = ${isSecret ? `<redacted, ${String(s.value).length} chars, sha256:${fingerprint(s.value)}>` : s.value}`);
}

// ---- dashboard accounts ----------------------------------------------------
console.log('\n=== dashboard accounts ===');
const users = q('SELECT email FROM users ORDER BY id');
if (users.length === 0) console.log('  (none — setup code flow armed)');
for (const u of users) console.log(`  ${u.email}`);

db.close();
