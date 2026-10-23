// End-to-end verification of image generation.
//
// Two jobs, because "image generation is not working" is almost never one
// thing:
//
//   1. --inspect  : read the LOCAL database and say why nothing can be served
//                   (no image rows at all vs. rows but no usable key). This
//                   needs no server and no network.
//   2. default    : POST /v1/images/generations for real, then decode the
//                   response and write the image to ops/out/images/.
//
// The unified API key is read from the database and never printed - same
// contract as verify-router.mjs.
//
// Usage:
//   node ops/scripts/verify-images.mjs                       # local, model auto
//   node ops/scripts/verify-images.mjs http://127.0.0.1:3001 auto
//   node ops/scripts/verify-images.mjs http://127.0.0.1:3001 @cf/black-forest-labs/flux-1-schnell
//   node ops/scripts/verify-images.mjs --inspect
//
// Free-tier reality (catalog v2026.10.23): only `cloudflare` rows exist, and
// they need an "account_id:API_token" key. See RUNBOOK.md section 5.4.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const dbPath = path.join(root, 'freellmapi', 'server', 'data', 'freeapi.db');
const outDir = path.join(root, 'ops', 'out', 'images');

const inspectOnly = process.argv.includes('--inspect');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const baseUrl = args[0] ?? 'http://127.0.0.1:3001';
const model = args[1] ?? 'auto';
const prompt = args[2] ?? 'A single ripe mango on a wooden table, soft window light, shallow depth of field';

const db = new DatabaseSync(dbPath, { readOnly: true });
const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get();
const key = keyRow?.value;

// Image rows plus the credentials actually reachable for each. `custom` rows
// are bound to one api_keys row (key_id), so they must not borrow the count of
// an unrelated custom endpoint.
const rows = db.prepare(`
  SELECT mm.platform, mm.model_id, mm.display_name, mm.enabled, mm.priority, mm.key_id,
         (SELECT COUNT(*) FROM api_keys k
           WHERE k.enabled = 1 AND k.status IN ('healthy', 'unknown')
             AND k.platform = mm.platform) AS platform_keys
  FROM media_models mm
  WHERE mm.modality = 'image'
  ORDER BY mm.priority, mm.id
`).all();

const customKeyIds = new Set(
  db.prepare("SELECT id FROM api_keys WHERE platform = 'custom' AND enabled = 1 AND status IN ('healthy', 'unknown')")
    .all().map(r => r.id),
);
db.close();

const usable = row => (row.platform === 'custom'
  ? (row.key_id != null && customKeyIds.has(row.key_id) ? 1 : 0)
  : row.platform_keys);

console.log(`database : ${path.relative(root, dbPath)}`);
console.log(`image rows : ${rows.length}\n`);

if (rows.length) {
  const width = Math.max(...rows.map(r => `${r.platform}/${r.model_id}`.length));
  for (const r of rows) {
    const state = r.enabled === 1 ? (usable(r) > 0 ? 'ready' : 'NO KEY') : 'disabled';
    console.log(`  ${`${r.platform}/${r.model_id}`.padEnd(width)}  ${state}`);
  }
  console.log('');
}

const enabledRows = rows.filter(r => r.enabled === 1);
const servable = enabledRows.filter(r => usable(r) > 0);

if (rows.length === 0) {
  console.log('No image rows in this database.');
  console.log('  They arrive via catalog sync (a signed document from api.freellmapi.co),');
  console.log('  gated on the MEDIA_PLATFORMS adapter allowlist in services/media.ts.');
  console.log('  Boot the server once, trigger a sync from the dashboard, and re-run this.');
} else if (servable.length === 0) {
  console.log(`${enabledRows.length} enabled image row(s), but no usable provider key.`);
  const platforms = [...new Set(enabledRows.map(r => r.platform))].join(', ');
  console.log(`  platforms in the catalog: ${platforms}`);
  const missing = [...new Set(enabledRows.filter(r => usable(r) === 0).map(r => r.platform))];
  for (const p of missing) {
    console.log(p === 'cloudflare'
      ? '  add: node ops/scripts/add-key.mjs cloudflare "<account_id>:<API_token>"'
      : `  add a key for "${p}" (RUNBOOK.md 5.4), then restart the server`);
  }
  console.log('  Restart is required: keys are applied from the config at boot.');
}

if (inspectOnly) process.exit(servable.length ? 0 : 1);

if (!key) {
  console.error('\nFAIL  no unified_api_key in the database - has the server booted yet?');
  process.exit(1);
}

// --- live probe ------------------------------------------------------------
console.log(`POST ${baseUrl}/v1/images/generations`);
console.log(`model  : ${model}`);
console.log(`prompt : ${prompt}`);
console.log(`key    : ${key.slice(0, 12)}... (${key.length} chars, redacted)\n`);

const started = Date.now();
let res;
try {
  res = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024' }),
    signal: AbortSignal.timeout(180_000),
  });
} catch (err) {
  console.error(`FAIL  request did not complete: ${err.message}`);
  process.exit(1);
}
const elapsed = Date.now() - started;
console.log(`HTTP ${res.status} in ${elapsed}ms`);

const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { body = null; }

if (!res.ok) {
  console.log('\n--- error body ---');
  console.log(text.slice(0, 800));
  if (res.status === 503) {
    console.log('\n503 = the chain had no usable provider. Re-run with --inspect.');
  } else if (res.status === 401 || res.status === 403) {
    console.log('\n4xx from the provider usually means the provider key was rejected.');
    console.log('For cloudflare: the token must have the "Workers AI: Read" permission.');
  } else if (res.status === 429) {
    console.log('\n429 = provider rate limit / daily allocation, or monthly key budget.');
  }
  process.exit(1);
}

console.log(`provider : ${body.provider}`);
console.log(`model    : ${body.model}`);
console.log(`images   : ${body.data?.length ?? 0}`);

const extFor = buf => {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return 'bin';
};

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

for (const [i, image] of (body.data ?? []).entries()) {
  let buf;
  if (image.b64_json) {
    buf = Buffer.from(image.b64_json, 'base64');
  } else if (image.url) {
    // Some adapters (siliconflow, or a custom endpoint asked for url output)
    // return a link instead of bytes. Download it without the gateway key.
    const dl = await fetch(image.url, { signal: AbortSignal.timeout(60_000) });
    if (!dl.ok) {
      console.log(`  [${i}] url ${dl.status} - not downloaded: ${image.url.slice(0, 120)}`);
      continue;
    }
    buf = Buffer.from(await dl.arrayBuffer());
  } else {
    console.log(`  [${i}] no b64_json and no url - cannot save`);
    continue;
  }

  const file = path.join(outDir, `${stamp}-${i}.${extFor(buf)}`);
  fs.writeFileSync(file, buf);
  console.log(`  [${i}] ${buf.length} bytes -> ${path.relative(root, file)}`);
}
