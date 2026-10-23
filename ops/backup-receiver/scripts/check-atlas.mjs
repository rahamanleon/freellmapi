// Connectivity check for the Atlas cluster used by the real tests.
//
// Prints only aggregate facts - reachable or not, latency, error class - and
// never the URI, credentials, or any stored data. Exists so a failing test run
// can be triaged as "the cluster is unreachable" vs "the code is wrong"
// without dumping a connection string into a log.

import fs from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const envFile = path.resolve(import.meta.dirname, '..', 'local.env');
const raw = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const uriLine = raw.split(/\r?\n/).find((l) => l.startsWith('MONGODB_URI='));
const uri = process.env.MONGODB_URI || uriLine?.slice('MONGODB_URI='.length).trim();

if (!uri) {
  console.log('MONGODB_URI: not set');
  process.exit(2);
}

const started = Date.now();
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 12_000, connectTimeoutMS: 12_000 });
try {
  await client.connect();
  const admin = client.db('admin');
  const info = await admin.command({ buildInfo: 1 });
  const ping = await admin.command({ ping: 1 });
  const ms = Date.now() - started;
  console.log(`reachable: yes`);
  console.log(`  driver latency : ${ms} ms`);
  console.log(`  server version : ${info.version}`);
  console.log(`  ping ok        : ${ping.ok === 1}`);
  console.log(`  srv scheme     : ${uri.startsWith('mongodb+srv://') ? 'yes' : 'no'}`);
  await client.close();
  process.exit(0);
} catch (err) {
  const ms = Date.now() - started;
  console.log(`reachable: NO  (${ms} ms)`);
  console.log(`  error class    : ${err?.name ?? 'unknown'}`);
  console.log(`  message        : ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`);
  console.log('');
  console.log('Common causes:');
  console.log('  - Atlas IP access list does not include this machine (0.0.0.0/0 needed for the Worker)');
  console.log('  - cluster paused or deleted');
  console.log('  - credentials rotated');
  console.log('  - no outbound network from this environment');
  await client.close().catch(() => {});
  process.exit(1);
}
