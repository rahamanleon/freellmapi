import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { up, down } from '../../../db/migrations/20260802_000001_custom_endpoint_host_labels.js';

// A minimal stand-in for api_keys: the data-only migration only reads
// platform / label / base_url.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT,
      base_url TEXT
    );
  `);
  const insert = db.prepare('INSERT INTO api_keys (platform, label, base_url) VALUES (?, ?, ?)');
  insert.run('custom', 'Custom', 'http://127.0.0.1:11434/v1');   // legacy default (#704)
  insert.run('custom', 'Custom', 'http://192.168.1.50:8080/v1'); // …and its indistinguishable twin
  insert.run('custom', 'Ollama box', 'http://127.0.0.1:1234/v1');// operator's own name: untouched
  insert.run('custom', 'Custom', null);                          // no URL to rename to
  insert.run('groq', 'Custom', null);                            // catalog key that must NOT change
  return db;
}

function labels(db: Database.Database): (string | null)[] {
  return (db.prepare('SELECT label FROM api_keys ORDER BY id').all() as { label: string | null }[])
    .map(r => r.label);
}

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('custom_endpoint_host_labels migration (#704)', () => {
  it('renames the legacy default to the endpoint host and leaves everything else alone', () => {
    const db = makeDb();
    dbs.push(db);

    up(db);

    expect(labels(db)).toEqual([
      '127.0.0.1:11434',
      '192.168.1.50:8080',
      'Ollama box',
      'Custom', // no base_url: nothing to rename to
      'Custom', // not a custom endpoint
    ]);
  });

  it('is idempotent — a second up() produces the identical result', () => {
    const db = makeDb();
    dbs.push(db);

    up(db);
    const once = labels(db);
    up(db);

    expect(labels(db)).toEqual(once);
  });

  it('down() restores the generic label on the endpoints up() renamed', () => {
    const db = makeDb();
    dbs.push(db);

    up(db);
    down(db);

    expect(labels(db)).toEqual(['Custom', 'Custom', 'Ollama box', 'Custom', 'Custom']);
  });
});
