// Preflight validation of a FreeLLMAPI declarative config file.
//
// Validates against the REAL upstream loader (server/dist/services/declarative-config.js)
// by applying the config to a throwaway SQLite database. This catches:
//   - malformed JSON
//   - unknown top-level keys (the upstream schema is .strict())
//   - unknown provider platforms
//   - type/range violations on every nested field
//   - missing provider keys for keyed platforms
//
// Your live database is never touched.
//
// Usage:
//   node ops/scripts/validate-config.mjs [configPath]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const repo = path.join(root, 'freellmapi');
// Resolve to an absolute path: the child process below runs with cwd = repo,
// so a relative path would be re-interpreted against the wrong directory.
const configPath = path.resolve(process.argv[2] ?? path.join(root, 'ops', 'freellmapi.config.json'));

// ---------------------------------------------------------------------------
// Child mode: run the real loader against a throwaway DB.
// ---------------------------------------------------------------------------
if (process.env.__FLA_VALIDATE_CHILD === '1') {
  const dist = (...p) => pathToFileURL(path.join(repo, 'server', 'dist', ...p)).href;
  const { initDb } = await import(dist('db', 'index.js'));
  const { applyDeclarativeConfig } = await import(dist('services', 'declarative-config.js'));

  initDb();
  const raw = fs.readFileSync(configPath, 'utf8');
  const result = applyDeclarativeConfig(JSON.parse(raw), 'preflight');
  process.stdout.write(`__RESULT__${JSON.stringify(result)}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent mode
// ---------------------------------------------------------------------------
if (!fs.existsSync(configPath)) {
  console.error(`FAIL  config not found: ${configPath}`);
  process.exit(2);
}

// 1. JSON syntax
let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`FAIL  invalid JSON: ${err.message}`);
  process.exit(1);
}
console.log(`config : ${configPath}`);
console.log(`top-level keys : ${Object.keys(parsed).join(', ')}`);

// 2. Full schema + registry validation on a throwaway DB
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fla-validate-'));
const tmpDb = path.join(tmpDir, 'validate.db');
const dummyKey = 'a'.repeat(64);

const child = spawnSync(process.execPath, [import.meta.filename, configPath], {
  cwd: repo,
  encoding: 'utf8',
  env: {
    ...process.env,
    __FLA_VALIDATE_CHILD: '1',
    FREEAPI_DB_PATH: tmpDb,
    ENCRYPTION_KEY: dummyKey,
    // NOT 'development': initDb() skips migrations in dev and exits when the
    // schema is absent. 'test' runs migrations but still permits a throwaway key.
    NODE_ENV: 'test',
    FREEAPI_CONFIG_PATH: '',
    FREEAPI_CONFIG_JSON: '',
  },
});

const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
const match = out.match(/__RESULT__(\{.*\})/);

// Clean up the throwaway database (plus WAL/SHM sidecars)
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

if (!match) {
  console.error('\nFAIL  the upstream loader rejected this config.\n');
  // Surface the loader's own error text, minus the throwaway paths.
  for (const line of out.split(/\r?\n/)) {
    const clean = line.replaceAll(tmpDir, '<tmp>').replaceAll(repo, '<repo>');
    if (clean.trim() && !clean.startsWith('__RESULT__')) console.error(`  ${clean}`);
  }
  process.exit(1);
}

const result = JSON.parse(match[1]);
console.log('\nPASS  upstream loader accepted the config');
console.log(`  keys applied      : ${result.keys}`);
console.log(`  custom models     : ${result.customModels}`);
console.log(`  model edits       : ${result.models}`);
console.log(`  fallback rows     : ${result.fallback}`);
console.log(`  routing applied   : ${result.routing}`);
console.log(`  admin created     : ${result.admin}`);

if (result.warnings?.length) {
  console.log('\n  WARNINGS (entries skipped rather than fatal):');
  for (const w of result.warnings) console.log(`    - ${w}`);
}
process.exit(0);
