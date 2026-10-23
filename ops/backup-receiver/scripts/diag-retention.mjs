// Diagnostic: what sequence numbers does the store actually allocate, and
// what does the prune query actually delete? Prints the real values so the
// retention off-by-one is answered by evidence rather than by reasoning.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { BackupStore, MAGIC } from '../src/storage.js';

const envFile = path.resolve(import.meta.dirname, '..', 'local.env');
const raw = fs.readFileSync(envFile, 'utf8');
const uri = raw.split(/\r?\n/).find((l) => l.startsWith('MONGODB_URI='))?.slice(12).trim();

const RUN_ID = Date.now().toString(36);
const DB_NAME = `diag_${RUN_ID}`;
const blob = (n) => Buffer.concat([MAGIC, crypto.randomBytes(n)]);

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const store = new BackupStore(client, { dbName: DB_NAME, collection: 'pruning', retention: 3 });
await store.ensureIndexes();

for (let i = 0; i < 7; i++) {
  const w = await store.put(blob(128));
  const all = await client.db(DB_NAME).collection('pruning').find({}).sort({ seq: 1 }).project({ seq: 1, size: 1 }).toArray();
  console.log(`put #${i + 1}: returned seq=${w.seq}  |  stored seqs: [${all.map((d) => d.seq).join(', ')}]  count=${all.length}`);
}

const final = await client.db(DB_NAME).collection('pruning').find({}).sort({ seq: 1 }).project({ seq: 1 }).toArray();
console.log(`\nfinal stored seqs: [${final.map((d) => d.seq).join(', ')}]  count=${final.length}`);
console.log(`store.count() = ${await store.count()}`);
console.log(`newest readable seq = ${(await store.get())?.seq}`);

try {
  await client.db(DB_NAME).dropDatabase();
} catch {
  // Least-privilege Atlas users cannot dropDatabase; leave the documents.
}
await client.close();
