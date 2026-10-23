// Add or update ONE provider key in ops/freellmapi.config.json - safely.
//
// WHY THIS EXISTS
// ---------------
// Hand-editing the config has three failure modes this repo has already hit or
// is one typo away from:
//
//   1. a platform name that is not in the upstream registry (silently disables
//      a provider; only the preflight catches it),
//   2. a shape the loader rejects at boot (the container exits, Render shows a
//      slow log instead of a working service),
//   3. a key that never leaves this file, because the single-line copy Render
//      reads (ops/secrets/config-oneline.json) was not regenerated.
//
// So: build the candidate, validate it against the REAL upstream loader, swap
// it in only on success, then publish the single-line copy. A failure leaves
// the existing config untouched.
//
// Usage:
//   node ops/scripts/add-key.mjs <platform> "<key>" [--label main] [--disabled]
//
// Examples:
//   node ops/scripts/add-key.mjs cloudflare "<account_id>:<API_token>"
//   node ops/scripts/add-key.mjs groq "gsk_..." --label main
//
// Cloudflare (Workers AI image models) expects "account_id:token" - see
// RUNBOOK.md section 5.4.
//
// Custom OpenAI-compatible endpoints are NOT keys in this sense (they need a
// base URL plus a model row); register those from the dashboard instead:
// POST /api/media/custom.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..', '..');
const configPath = path.join(root, 'ops', 'freellmapi.config.json');
const candidatePath = path.join(root, 'ops', 'freellmapi.config.candidate.json');
const validateScript = path.join(root, 'ops', 'scripts', 'validate-config.mjs');
const publishScript = path.join(root, 'ops', 'scripts', 'publish-config.mjs');

function usage(message) {
  if (message) console.error(`FAIL  ${message}\n`);
  console.error('usage: node ops/scripts/add-key.mjs <platform> "<key>" [--label main] [--disabled]');
  process.exit(2);
}

// --- arguments -------------------------------------------------------------
const positional = [];
let label = 'main';
let enabled = true;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--disabled') {
    enabled = false;
  } else if (arg === '--label') {
    label = argv[++i];
    if (!label) usage('--label needs a value');
  } else if (arg.startsWith('--label=')) {
    label = arg.slice('--label='.length);
  } else if (arg.startsWith('--')) {
    usage(`unknown flag ${arg}`);
  } else {
    positional.push(arg);
  }
}

const [platform, key] = positional;
if (!platform) usage('missing <platform>');
if (!key) usage('missing "<key>"');

// --- platform-specific shape checks ---------------------------------------
// These are the mistakes that validate fine but fail every request at runtime.
if (platform === 'cloudflare') {
  const sep = key.indexOf(':');
  if (sep === -1) {
    usage(
      'cloudflare needs "account_id:API_token" (one colon).\n'
      + '        account id : Cloudflare dashboard -> Workers & Pages -> Account ID (32 hex chars)\n'
      + '        token      : My Profile -> API Tokens -> Create Token -> permission "Workers AI: Read"',
    );
  }
  const accountId = key.slice(0, sep);
  if (!/^[0-9a-f]{32}$/i.test(accountId)) {
    console.warn(`WARN  account id "${accountId}" is not 32 hex characters - is this really the Cloudflare account id?`);
  }
}

if (/\s/.test(key)) {
  console.warn('WARN  the key contains whitespace - usually a copy/paste artifact.');
}

// --- build the candidate ---------------------------------------------------
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`FAIL  cannot read ${path.relative(root, configPath)}: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(config.keys)) config.keys = [];

const index = config.keys.findIndex(k => k.platform === platform);
const entry = index === -1
  ? { platform, key, label, enabled }
  : { ...config.keys[index], platform, key, label, enabled };

if (index === -1) {
  config.keys.push(entry);
} else {
  config.keys[index] = entry;
}

fs.writeFileSync(candidatePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

// --- validate the candidate, then swap ------------------------------------
const validation = spawnSync(process.execPath, [validateScript, candidatePath], {
  cwd: root,
  stdio: 'inherit',
});
if (validation.status !== 0) {
  fs.rmSync(candidatePath, { force: true });
  console.error('\nFAIL  upstream loader rejected the change - config left untouched.');
  process.exit(1);
}

fs.renameSync(candidatePath, configPath);

const verb = index === -1 ? 'ADDED' : 'UPDATED';
console.log(`\n${verb}  ${platform} (${label})${enabled ? '' : ' [disabled]'}`);
console.log(`keys : ${config.keys.map(k => `${k.platform}${k.enabled === false ? ' (off)' : ''}`).join(', ')}`);

// --- publish the single-line copy ----------------------------------------
// publish-config re-validates unless told otherwise; it was validated above.
const publish = spawnSync(process.execPath, [publishScript, '--skip-validate'], {
  cwd: root,
  stdio: 'inherit',
});
if (publish.status !== 0) {
  console.error('\nFAIL  config is correct but publishing the single-line copy failed.');
  process.exit(1);
}
