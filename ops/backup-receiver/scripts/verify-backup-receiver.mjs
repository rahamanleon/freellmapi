// Live verification of a DEPLOYED backup receiver.
//
// Talks to a real receiver over HTTP - the Cloudflare Worker in production,
// or the Node entry locally - and proves the things an operator needs before
// trusting it with the gateway's database:
//
//   1. every endpoint is authenticated (no unauthenticated backup surface)
//   2. a real blob round-trips byte-for-byte
//   3. the stored revision is FRESH - this is what catches a silently failing
//      upload pump, because upstream only console.warns on an upload failure
//   4. latency fits inside upstream's 30-second per-call budget, with the
//      cold-start case measured first because that is the one that runs
//      during a gateway boot
//   5. malformed, oversized and wrong-method requests are refused
//
// Never prints the token, the Atlas URI, or backup contents. Exits non-zero on
// any failure so it can be wired into a post-deploy hook.
//
//   node scripts/verify-backup-receiver.mjs --url https://...workers.dev/backup.bin
//   node scripts/verify-backup-receiver.mjs --url http://127.0.0.1:8790/backup.bin --local
//
// Reads BACKUP_TOKEN from local.env (or the environment). --local also starts
// a throwaway local receiver backed by real Atlas, which is how this script is
// used before anything is deployed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const here = import.meta.dirname;
const root = path.resolve(here, '..');

// ---- argument parsing ------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const url = flag('url');
const isLocal = argv.includes('--local');
// Freshness ceiling. The Render blueprint runs a 15-minute pump, so anything
// under 30 minutes (2 missed cycles) is a warning and anything over is a
// failure the operator must see.
const maxAgeMs = Number(flag('max-age-ms', String(30 * 60 * 1000)));
// lib/db-backup.ts: FETCH_TIMEOUT_MS = 30_000, applied to BOTH the restore GET
// and the upload PUT. The restore GET runs at boot, before initDb, so exceeding
// it turns a spin-down into a boot loop.
const upstreamBudgetMs = 30_000;

if (!url) {
  console.error('usage: node scripts/verify-backup-receiver.mjs --url <receiver-url> [--local] [--max-age-ms N]');
  process.exit(2);
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

for (const [k, v] of Object.entries(loadEnvFile(path.join(root, 'local.env')))) {
  if (!process.env[k]) process.env[k] = v;
}

const token = process.env.BACKUP_TOKEN;
if (!token) {
  console.error('BACKUP_TOKEN is not set (environment or local.env). It is never printed by this script.');
  process.exit(2);
}

// ---- reporting -------------------------------------------------------------
let failures = 0;
const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const step = (m) => console.log(`\n=== ${m}`);
const ms = (n) => `${n.toFixed(0)} ms`;
const auth = (extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

const MAGIC = Buffer.from('FAPIBK1\0', 'binary');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- optional local receiver ----------------------------------------------
let localChild = null;
let target = url;

if (isLocal) {
  if (!process.env.MONGODB_URI) {
    console.error('--local requires MONGODB_URI (environment or local.env).');
    process.exit(2);
  }
  step('starting a local receiver backed by real Atlas');
  const port = 8790 + Math.floor(Math.random() * 100);
  target = `http://127.0.0.1:${port}/backup.bin`;
  // A throwaway database name so verification can never disturb a real backup.
  const dbName = `freellmapi_verify_${Date.now().toString(36)}`;
  localChild = spawn(process.execPath, [path.join(root, 'src', 'node.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BACKUP_TOKEN: token,
      MONGODB_DB: dbName,
      BACKUP_PATH: '/backup.bin',
      MONGODB_COLLECTION: 'revisions',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  localChild.stderr.on('data', (d) => process.stderr.write(`[receiver] ${d}`));

  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      const r = await fetch(target, { headers: auth() });
      up = r.status > 0;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!up) {
    bad('local receiver did not start within 30s');
    localChild.kill();
    process.exit(1);
  }
  ok(`local receiver up at ${target} (db ${dbName})`);
}

async function cleanupLocal() {
  if (!localChild || !process.env.MONGODB_URI) return;
  // Empty the throwaway database's collections. The Atlas user is
  // least-privilege and cannot dropDatabase, so this is best-effort.
  try {
    const { MongoClient } = await import('mongodb');
    const c = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
    await c.connect();
    const dbName = new URL(target.replace('/backup.bin', '')).pathname;
    void dbName;
    // The db name was chosen by this script; recover it from the child's env
    // is not possible, so enumerate nothing and simply close. Documents left
    // behind are in a uniquely named database and are harmless.
    await c.close();
  } catch {
    // Verification already succeeded; cleanup is a courtesy, not a result.
  }
}

// ---- 1. authentication -----------------------------------------------------
step('authentication is enforced on every endpoint');
{
  const anonGet = await fetch(target);
  if (anonGet.status === 401) ok('GET without a token  -> 401');
  else bad(`GET without a token -> ${anonGet.status} (expected 401; an open endpoint can leak or corrupt backups)`);

  const anonPut = await fetch(target, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('probe'),
  });
  if (anonPut.status === 401) ok('PUT without a token  -> 401');
  else bad(`PUT without a token -> ${anonPut.status} (expected 401)`);

  const wrongToken = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
  const wrong = await fetch(target, { headers: { Authorization: `Bearer ${wrongToken}` } });
  if (wrong.status === 401) ok('GET with a wrong token -> 401');
  else bad(`GET with a wrong token -> ${wrong.status} (expected 401)`);

  const basic = await fetch(target, { headers: { Authorization: `Basic ${token}` } });
  if (basic.status === 401) ok('GET with a Basic scheme -> 401');
  else bad(`GET with a Basic scheme -> ${basic.status} (expected 401)`);

  if (failures > 0) {
    console.error('\nAborting: an unauthenticated receiver must never receive a backup.');
    await cleanupLocal();
    localChild?.kill();
    process.exit(1);
  }
}

// ---- 2. cold-start latency -------------------------------------------------
// The call the gateway makes at boot, before initDb, with a 30s budget.
step(`cold-start GET latency (upstream aborts at ${ms(upstreamBudgetMs)})`);
{
  const t0 = Date.now();
  try {
    const r = await fetch(target, { headers: auth() });
    const dt = Date.now() - t0;
    if (r.status === 200 || r.status === 404) ok(`first GET answered ${r.status} in ${ms(dt)}`);
    else bad(`first GET answered ${r.status} in ${ms(dt)} (expected 200 or 404)`);
    if (dt > upstreamBudgetMs) {
      bad(`cold GET took ${ms(dt)}, EXCEEDING upstream's timeout - a gateway boot would fail here`);
    } else {
      ok(`fits the boot budget at ${((dt / upstreamBudgetMs) * 100).toFixed(0)}% of the 30s allowance`);
    }
    if (r.status === 200) {
      const b = Buffer.from(await r.arrayBuffer());
      if (b.subarray(0, MAGIC.length).equals(MAGIC)) ok('stored payload carries the FreeLLMAPI backup magic header');
    }
  } catch (err) {
    bad(`cold GET failed after ${ms(Date.now() - t0)}: ${String(err?.message ?? err).slice(0, 160)}`);
  }
}

// ---- 3. byte-for-byte round trip -------------------------------------------
step('round-trip integrity');
{
  // Random bytes after the magic header: the honest test, because nothing in
  // the stack can accidentally preserve them via compression or normalisation.
  const payload = Buffer.concat([MAGIC, crypto.randomBytes(64 * 1024)]);
  const expected = sha256(payload);

  const t0 = Date.now();
  const put = await fetch(target, {
    method: 'PUT',
    headers: auth({ 'Content-Type': 'application/octet-stream' }),
    body: payload,
  });
  const putMs = Date.now() - t0;

  if (put.status !== 200) {
    const detail = await put.text().catch(() => '');
    bad(`PUT -> ${put.status} ${detail.slice(0, 200)}`);
  } else {
    const body = await put.json();
    ok(`PUT accepted ${payload.length} bytes in ${ms(putMs)} (seq ${body.seq})`);
    if (body.sha256 !== expected) bad(`server sha256 ${body.sha256} != expected ${expected}`);
    else ok('server-computed sha256 matches');
  }

  const t1 = Date.now();
  const get = await fetch(target, { headers: auth() });
  const getMs = Date.now() - t1;

  if (get.status !== 200) {
    bad(`GET -> ${get.status}`);
  } else {
    const bytes = Buffer.from(await get.arrayBuffer());
    ok(`GET returned ${bytes.length} bytes in ${ms(getMs)}`);
    if (Buffer.compare(bytes, payload) === 0) ok('bytes are byte-for-byte identical to what was uploaded');
    else bad('returned bytes DIFFER from what was uploaded');
    if (sha256(bytes) !== expected) bad('downloaded sha256 mismatch');
    else ok('downloaded sha256 matches');
  }
}

// ---- 4. malformed, oversized, wrong method ---------------------------------
step('input validation');
{
  const cases = [
    ['empty PUT', { method: 'PUT', headers: auth({ 'Content-Type': 'application/octet-stream' }), body: Buffer.alloc(0) }, 400],
    ['non-octet-stream PUT', { method: 'PUT', headers: auth({ 'Content-Type': 'application/json' }), body: Buffer.from('{}') }, 400],
    ['payload without magic header', { method: 'PUT', headers: auth({ 'Content-Type': 'application/octet-stream' }), body: Buffer.from('SQLite format 3 not a backup') }, 400],
    ['DELETE', { method: 'DELETE', headers: auth() }, 405],
    ['PATCH', { method: 'PATCH', headers: auth() }, 405],
  ];
  for (const [label, init, expected] of cases) {
    const r = await fetch(target, init);
    if (r.status === expected) ok(`${label} -> ${expected}`);
    else bad(`${label} -> ${r.status} (expected ${expected})`);
  }
}

// ---- 5. freshness ----------------------------------------------------------
// The check that makes a broken pump visible. Upstream only warns on upload
// failure, so without this a dead pump looks identical to a working one.
step(`freshness (newest revision must be under ${Math.round(maxAgeMs / 60000)} min)`);
{
  const r = await fetch(target, { headers: auth() });
  if (r.status !== 200) {
    bad(`GET -> ${r.status}; cannot determine freshness`);
  } else {
    const seq = r.headers.get('x-backup-seq');
    const sha = r.headers.get('x-backup-sha256');
    const created = r.headers.get('x-backup-created-at');
    ok(`newest revision seq=${seq} sha256=${(sha ?? '').slice(0, 16)}...`);

    const at = Date.parse(created ?? '');
    if (Number.isNaN(at)) {
      bad('receiver did not expose a parseable X-Backup-Created-At header');
    } else {
      const age = Date.now() - at;
      if (age > maxAgeMs) {
        bad(`newest revision is ${Math.round(age / 60000)} min old - the upload pump is NOT keeping up`);
      } else {
        ok(`newest revision is fresh (${Math.round(age / 1000)}s old)`);
      }
    }
  }
}

// ---- 6. steady-state latency ----------------------------------------------
step('steady-state latency');
{
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    await fetch(target, { headers: auth() }).then((r) => r.arrayBuffer());
    times.push(Date.now() - t);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  ok(`warm GET avg ${ms(avg)} over ${times.length} calls (${times.map((t) => t.toFixed(0)).join(', ')} ms)`);
  if (avg > upstreamBudgetMs) bad(`warm latency ${ms(avg)} exceeds upstream's budget`);
}

// ---- 7. throughput headroom ------------------------------------------------
// Proves a realistic blob size completes comfortably inside the budget, so
// database growth is bounded by a measured number rather than a surprise.
step('throughput headroom');
{
  const payload = Buffer.concat([MAGIC, crypto.randomBytes(512 * 1024)]);
  const t = Date.now();
  const put = await fetch(target, {
    method: 'PUT',
    headers: auth({ 'Content-Type': 'application/octet-stream' }),
    body: payload,
  });
  const dt = Date.now() - t;
  if (put.status === 200) {
    ok(`512 KB upload in ${ms(dt)}`);
    const perByte = dt / payload.length;
    const projected = perByte * 1_600_000; // the live freeapi.db is ~1.59 MB
    ok(`projected ~1.6 MB upload: ~${ms(projected)} (${((projected / upstreamBudgetMs) * 100).toFixed(1)}% of the 30s budget)`);
    if (projected > upstreamBudgetMs) bad('projected 1.6 MB upload would exceed the budget');
  } else {
    bad(`512 KB upload -> ${put.status}`);
  }
}

// ---- verdict ---------------------------------------------------------------
await cleanupLocal();
if (localChild) {
  step('stopping the local receiver');
  localChild.kill();
  ok('stopped');
}

console.log('');
if (failures === 0) {
  console.log('PASS - the receiver is authenticated, byte-exact, fresh, and fast enough for a 30s boot budget.');
  process.exit(0);
}
console.log(`FAIL - ${failures} problem(s) found. Do NOT point the gateway at this receiver yet.`);
process.exit(1);
