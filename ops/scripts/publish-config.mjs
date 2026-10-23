// Rebuild ops/secrets/config-oneline.json from ops/freellmapi.config.json.
//
// WHY THIS EXISTS
// ---------------
// Render's FREEAPI_CONFIG_JSON is a SINGLE-LINE copy of the declarative config.
// ops/scripts/copy-for-render.ps1 reads that copy from
// ops/secrets/config-oneline.json - not from the config file itself. So a key
// added to freellmapi.config.json does not reach a deploy until this file is
// regenerated.
//
// That is not hypothetical: the nvidia key (5dde8db) was written to
// freellmapi.config.json only, so config-oneline.json - and therefore the
// Render secret built from it - silently kept the old key list. The gateway
// looked keyed while the deploy was not.
//
// This script makes the step explicit: validate against the real upstream
// loader, write the compact single-line copy, print structure only (never a
// key value).
//
// Usage:
//   node ops/scripts/publish-config.mjs               # validate + write
//   node ops/scripts/publish-config.mjs --check       # exit 1 if stale, write nothing
//   node ops/scripts/publish-config.mjs --skip-validate
//
// Then (deploying to Render):
//   powershell -NoProfile -ExecutionPolicy Bypass -File ops\scripts\copy-for-render.ps1 -Which config
// and paste into the FREEAPI_CONFIG_JSON prompt.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..', '..');
const configPath = path.join(root, 'ops', 'freellmapi.config.json');
const outPath = path.join(root, 'ops', 'secrets', 'config-oneline.json');
const validateScript = path.join(root, 'ops', 'scripts', 'validate-config.mjs');

const checkOnly = process.argv.includes('--check');
const skipValidate = process.argv.includes('--skip-validate');

if (!fs.existsSync(configPath)) {
  console.error(`FAIL  config not found: ${configPath}`);
  process.exit(2);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`FAIL  invalid JSON in ${path.relative(root, configPath)}: ${err.message}`);
  process.exit(1);
}

// Compact, no BOM, no interior whitespace: exactly what Render's single-line
// env var has to hold. A trailing newline is dropped by copy-for-render.ps1
// (.Trim()) and is friendlier to editors and Git.
const compact = JSON.stringify(parsed);

const current = fs.existsSync(outPath)
  ? fs.readFileSync(outPath, 'utf8').trim()
  : '';
const stale = current !== compact;

const platforms = (parsed.keys ?? []).map(k => k.platform).join(', ');
const length = compact.length;
const sha = crypto.createHash('sha256').update(compact).digest('hex').slice(0, 12);

console.log(`config : ${path.relative(root, configPath)}`);
console.log(`output : ${path.relative(root, outPath)}`);
console.log(`platforms : ${platforms || '(none)'}`);
console.log(`length : ${length} characters`);
console.log(`sha256 : ${sha}`);
console.log(`state  : ${stale ? (current ? 'STALE - needs publishing' : 'MISSING') : 'up to date'}`);

if (checkOnly) {
  // A stale secret is a deploy-time surprise: fail CI / a pre-deploy hook
  // rather than let the gateway run with a key list nobody published.
  process.exit(stale ? 1 : 0);
}

if (!skipValidate) {
  const child = spawnSync(process.execPath, [validateScript, configPath], {
    cwd: root,
    stdio: 'inherit',
  });
  if (child.status !== 0) {
    console.error('\nFAIL  config rejected by the upstream loader - nothing was written.');
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${compact}\n`, 'utf8');

console.log(`\n${stale ? 'WROTE' : 'REFRESHED'}  ${path.relative(root, outPath)}`);

if (stale) {
  console.log('\nNext: put it on the running service.');
  console.log('  Render   : powershell -NoProfile -ExecutionPolicy Bypass -File ops\\scripts\\copy-for-render.ps1 -Which config');
  console.log('             paste into FREEAPI_CONFIG_JSON, then redeploy (config is read at boot only).');
  console.log('  Local    : restart the server (FREEAPI_CONFIG_PATH is read at boot only).');
}
