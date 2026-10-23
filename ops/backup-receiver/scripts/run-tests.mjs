// Test/verification runner for the backup receiver.
//
// Loads ops/backup-receiver/local.env into process.env WITHOUT printing any
// value, generating a BACKUP_TOKEN on first run if none is present, then
// hands off to vitest. This keeps the Atlas URI and the bearer token out of
// shell history, out of the command line, and out of CI logs.
//
//   node scripts/run-tests.mjs              run every suite
//   node scripts/run-tests.mjs core        run one suite by filename fragment
//
// Exits non-zero if MONGODB_URI is missing, because a run without it would
// silently skip the two suites that actually prove anything. That is the
// "green means something" guarantee.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const here = import.meta.dirname;
const root = path.resolve(here, '..');
const envFile = path.join(root, 'local.env');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Only strip a leading quote if the value has a matching trailing one, so
    // a password that legitimately ends in a quote is not mangled.
    let value = trimmed.slice(eq + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

const fromFile = loadEnvFile(envFile);
for (const [k, v] of Object.entries(fromFile)) {
  if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
}

// Generate a token on first run. 32 random bytes hex = 64 chars, comfortably
// above the 16-character floor in config.js. Written back to local.env so the
// same token can be installed as the Wrangler secret and as the gateway's
// FREEAPI_DB_BACKUP_TOKEN - they MUST match or every request is a 401.
if (!process.env.BACKUP_TOKEN) {
  process.env.BACKUP_TOKEN = crypto.randomBytes(32).toString('hex');
  const next = [
    '# Local-only secrets. Git-ignored. Never printed by any script.',
    '# The same MONGODB_URI and BACKUP_TOKEN must be installed as Wrangler',
    '# secrets and as FREEAPI_DB_BACKUP_TOKEN on the gateway.',
    `MONGODB_URI=${process.env.MONGODB_URI ?? ''}`,
    `BACKUP_TOKEN=${process.env.BACKUP_TOKEN}`,
    '',
  ].join('\n');
  fs.writeFileSync(envFile, next, { mode: 0o600 });
  console.log('generated BACKUP_TOKEN in local.env (value not printed)');
}

if (!process.env.MONGODB_URI) {
  console.error(
    '\nMONGODB_URI is not set.\n' +
      `  Copy local.env.example to local.env and fill it in, or export MONGODB_URI.\n` +
      '  Without it, the REAL-Atlas suites are skipped and a green run proves nothing.\n',
  );
  process.exit(2);
}

const filter = process.argv[2];
const args = ['vitest', 'run'];
if (filter) args.push(filter);

console.log(`running: ${args.join(' ')}  (Atlas URI and token loaded, values withheld)\n`);
const result = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), ...args.slice(1)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
