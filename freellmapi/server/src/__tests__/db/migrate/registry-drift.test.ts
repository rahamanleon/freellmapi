import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS } from '../../../db/migrate/defaults.js';

// The runner walks the static DEFAULT_MIGRATIONS list, not the directory, so a
// migration file that nobody registered is skipped in silence: it never runs,
// nothing fails, and the gap only shows up as a symptom on an upgraded install.
// Adding the file and forgetting the registry is the easy mistake — this makes
// it a failing test instead of a quiet no-op.
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../../../db/migrations');

describe('migration registry', () => {
  it('registers every migration file on disk', () => {
    const onDisk = fs.readdirSync(MIGRATIONS_DIR)
      .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort();
    const registered = DEFAULT_MIGRATIONS.map(m => m.filename).sort();

    expect(registered).toEqual(onDisk);
  });

  it('keeps the registry in filename order — the order they are applied in', () => {
    const filenames = DEFAULT_MIGRATIONS.map(m => m.filename);

    expect(filenames).toEqual([...filenames].sort());
  });
});
