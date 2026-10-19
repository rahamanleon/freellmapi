import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { connectDb, getDefaultDbPath, shouldHardenDataDir } from '../../db/index.js';
import { aclEntries } from '../helpers/acl.js';

const isWindows = process.platform === 'win32';
const itPosix = it.skipIf(isWindows);
const itWindows = it.skipIf(!isWindows);

const created: string[] = [];
const createdDirs: string[] = [];

const ORIGINAL_DIR_HARDENING = process.env.FREEAPI_DB_DIR_HARDENING;
const ORIGINAL_DB_PATH = process.env.FREEAPI_DB_PATH;

function tempDbPath(): string {
  const p = path.join(os.tmpdir(), `freeapi-hardening-${Date.now()}-${Math.random()}.db`);
  created.push(p);
  return p;
}

/** A directory that already exists, like a mounted volume or a shared temp dir:
 *  connectDb finds it rather than creating it. */
function existingDir(): string {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-hardening-existing-'));
  createdDirs.push(p);
  return p;
}

/** A path connectDb has to create, which is what earns it the right to harden
 *  it. Returns the not-yet-existent directory and the DB path inside it. */
function unbornDataDir(): { dataDir: string; dbPath: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-hardening-parent-'));
  createdDirs.push(parent);
  const dataDir = path.join(parent, 'data');
  return { dataDir, dbPath: path.join(dataDir, 'freeapi.db') };
}

afterEach(() => {
  if (ORIGINAL_DIR_HARDENING === undefined) delete process.env.FREEAPI_DB_DIR_HARDENING;
  else process.env.FREEAPI_DB_DIR_HARDENING = ORIGINAL_DIR_HARDENING;
  if (ORIGINAL_DB_PATH === undefined) delete process.env.FREEAPI_DB_PATH;
  else process.env.FREEAPI_DB_PATH = ORIGINAL_DB_PATH;

  for (const p of created.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(`${p}${suffix}`); } catch { /* best effort */ }
    }
  }
  for (const p of createdDirs.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('database runtime hardening', () => {
  it('sets a busy timeout so concurrent writers wait instead of erroring', () => {
    const db = connectDb(tempDbPath());
    // pragma() returns a scalar or a row list depending on driver; normalise.
    const raw = db.pragma('busy_timeout');
    const value = Array.isArray(raw)
      ? Number((raw[0] as Record<string, unknown>).timeout ?? (raw[0] as Record<string, unknown>).busy_timeout)
      : Number(raw);
    expect(value).toBe(5000);
  });

  it('keeps foreign keys and WAL on', () => {
    const db = connectDb(tempDbPath());
    const fk = db.pragma('foreign_keys');
    const fkValue = Array.isArray(fk)
      ? Number((fk[0] as Record<string, unknown>).foreign_keys)
      : Number(fk);
    expect(fkValue).toBe(1);

    const jm = db.pragma('journal_mode');
    const jmValue = Array.isArray(jm)
      ? String((jm[0] as Record<string, unknown>).journal_mode)
      : String(jm);
    expect(jmValue.toLowerCase()).toBe('wal');
  });

  // The DB holds encrypted provider keys and the dashboard password hash, so it
  // must not be readable by other local accounts. The guarantee is the same on
  // both platforms; only the mechanism that expresses it differs, so each leg
  // asserts what its own OS can actually enforce. Asserting POSIX modes on
  // Windows is not a stricter test — it is an unfalsifiable one: Node
  // synthesizes 0o666 there and chmod cannot clear it, so the assertion failed
  // whether or not the file was protected.

  itPosix('restricts the database file to the owner', () => {
    const dbPath = tempDbPath();
    connectDb(dbPath);

    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  itPosix('restricts the WAL sidecars once they exist', () => {
    const dbPath = tempDbPath();
    const db = connectDb(dbPath);
    // Force a write so -wal/-shm are created, then reconnect to chmod them.
    db.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO probe (id) VALUES (1)');
    connectDb(dbPath);

    for (const suffix of ['-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (!fs.existsSync(target)) continue;
      const mode = fs.statSync(target).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });

  itWindows('restricts the database file to the owner', () => {
    const dbPath = tempDbPath();
    connectDb(dbPath);

    const entries = aclEntries(dbPath);
    // Inherited ACEs are where the extra principals come from: a file created
    // under %TEMP% or a shared profile inherits Modify for app containers and
    // for other local accounts. If any (I) survives, hardening did not run.
    expect(entries.filter(e => e.includes('(I)'))).toEqual([]);
    // Exactly the owner, SYSTEM and Administrators — the POSIX 0600 equivalent,
    // where root likewise keeps access.
    expect(entries).toHaveLength(3);
  });

  itWindows('restricts the WAL sidecars once they exist', () => {
    const dbPath = tempDbPath();
    const db = connectDb(dbPath);
    // Force a write so -wal/-shm are created, then reconnect to harden them.
    db.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO probe (id) VALUES (1)');
    connectDb(dbPath);

    let checked = 0;
    for (const suffix of ['-wal', '-shm']) {
      const target = `${dbPath}${suffix}`;
      if (!fs.existsSync(target)) continue;
      checked++;
      expect(aclEntries(target).filter(e => e.includes('(I)'))).toEqual([]);
    }
    // The original test silently passed when neither sidecar existed; make the
    // Windows leg say so rather than pretending it verified something.
    //
    // Note what the reconnect above buys, and what it does not: it proves the
    // file pass restricts sidecars THAT ALREADY EXIST, which is the unclean
    // shutdown case. It says nothing about a normal start, where the sidecars
    // appear after connectDb has already been and gone — that is what the
    // "data directory" block below covers.
    expect(checked).toBeGreaterThan(0);
  });

  itWindows('leaves an already-restricted file unchanged when reconnecting', () => {
    const dbPath = tempDbPath();
    connectDb(dbPath);
    const first = aclEntries(dbPath);
    connectDb(dbPath);

    expect(aclEntries(dbPath)).toEqual(first);
  });

  it('works for an in-memory database without touching the filesystem', () => {
    expect(() => connectDb(':memory:')).not.toThrow();
  });
});

describe('data directory hardening policy', () => {
  it('claims a directory it just created', () => {
    expect(shouldHardenDataDir(existingDir(), true)).toBe(true);
  });

  it('claims the built-in default data directory, so upgrades are covered too', () => {
    // An install that predates this change already has server/data, so it never
    // hits the "we created it" case. Without this leg the fix would reach new
    // installs only.
    delete process.env.FREEAPI_DB_PATH;
    expect(shouldHardenDataDir(path.dirname(getDefaultDbPath()), false)).toBe(true);
  });

  it('matches the default directory case-insensitively on Windows', () => {
    delete process.env.FREEAPI_DB_PATH;
    const defaultDir = path.dirname(getDefaultDbPath());
    expect(shouldHardenDataDir(defaultDir.toUpperCase(), false, 'win32')).toBe(true);
    // POSIX paths really are case-sensitive; the same leniency there would be a bug.
    expect(shouldHardenDataDir(defaultDir.toUpperCase(), false, 'linux')).toBe(false);
  });

  it('refuses a pre-existing directory it was merely pointed at', () => {
    // The whole reason this predicate exists: FREEAPI_DB_PATH=/tmp/freeapi.db
    // must never end in chmod 0700 /tmp.
    expect(shouldHardenDataDir(os.tmpdir(), false)).toBe(false);
    expect(shouldHardenDataDir(existingDir(), false)).toBe(false);
  });

  it('lets an operator force it on for a directory of their own', () => {
    process.env.FREEAPI_DB_DIR_HARDENING = '1';
    expect(shouldHardenDataDir(os.tmpdir(), false)).toBe(true);
  });

  it('lets an operator force it off even where the default would apply', () => {
    process.env.FREEAPI_DB_DIR_HARDENING = '0';
    expect(shouldHardenDataDir(existingDir(), true)).toBe(false);
  });

  it('ignores a value it cannot interpret rather than guessing', () => {
    process.env.FREEAPI_DB_DIR_HARDENING = 'maybe';
    expect(shouldHardenDataDir(os.tmpdir(), false)).toBe(false);
    expect(shouldHardenDataDir(existingDir(), true)).toBe(true);
  });
});

describe('WAL sidecars on a normal start', () => {
  // The case the file-by-file pass structurally cannot reach. SQLite creates
  // -wal/-shm on the first write and deletes them on the last clean close, so
  // on a real start there is nothing to harden by the time connectDb looks —
  // and a real server, unlike the tests above, never reconnects to get a second
  // chance. Only the directory can carry the restriction forward.
  //
  // Each leg asserts the guarantee its own OS actually expresses, because the
  // two platforms reach it by genuinely different mechanisms: Windows inherits
  // the ACL onto the new child, while POSIX never propagates modes and instead
  // makes the child unreachable by clearing the directory's search bit.

  function connectAndWrite(dbPath: string): void {
    const db = connectDb(dbPath);
    // Deliberately no second connectDb: this must hold for a process that opens
    // the database exactly once, which is what the server does.
    db.exec('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO probe (id) VALUES (1)');
  }

  function sidecars(dbPath: string): string[] {
    return ['-wal', '-shm'].map(s => `${dbPath}${s}`).filter(p => fs.existsSync(p));
  }

  itPosix('makes the directory it created unreachable to other accounts', () => {
    const { dataDir, dbPath } = unbornDataDir();
    connectAndWrite(dbPath);

    expect(sidecars(dbPath).length).toBeGreaterThan(0);
    expect(fs.statSync(dataDir).mode & 0o077).toBe(0);
    // Owner search+write must survive: 0600 here would lock the server out of
    // its own data directory.
    expect(fs.statSync(dataDir).mode & 0o700).toBe(0o700);
  });

  itWindows('gives the sidecars the restricted ACL by inheritance', () => {
    const { dataDir, dbPath } = unbornDataDir();
    connectAndWrite(dbPath);

    const dirEntries = aclEntries(dataDir);
    expect(dirEntries.filter(e => e.includes('(I)'))).toEqual([]);
    expect(dirEntries).toHaveLength(3);
    // Without (OI)(CI) the ACEs apply to the directory alone and no child ever
    // sees them — the flags are the entire mechanism.
    expect(dirEntries.every(e => e.includes('(OI)') && e.includes('(CI)'))).toBe(true);

    const found = sidecars(dbPath);
    expect(found.length).toBeGreaterThan(0);
    for (const target of found) {
      // Exactly the owner, SYSTEM and Administrators — inherited from the
      // directory, since nothing hardened these files directly.
      expect(aclEntries(target)).toHaveLength(3);
    }
  });

  itPosix('leaves a directory it did not create exactly as it found it', () => {
    // The safety property that makes the default acceptable. A group-readable
    // shared directory must come out of connectDb unchanged.
    const dir = existingDir();
    fs.chmodSync(dir, 0o755);
    connectAndWrite(path.join(dir, 'freeapi.db'));

    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  itPosix('hardens that same directory once the operator opts in', () => {
    const dir = existingDir();
    fs.chmodSync(dir, 0o755);
    process.env.FREEAPI_DB_DIR_HARDENING = '1';
    connectAndWrite(path.join(dir, 'freeapi.db'));

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });
});
