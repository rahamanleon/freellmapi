import fs from 'fs';
import path from 'path';
import { execFileSync as nodeExecFileSync } from 'node:child_process';

/**
 * Restrict a sensitive file to its owner on every platform we support.
 *
 * POSIX gets `chmod 0600`. Windows has no POSIX modes at all: `fs.chmodSync`
 * there only maps the owner-write bit onto FILE_ATTRIBUTE_READONLY, so
 * `chmod(0o600)` is a silent no-op and the file keeps whatever ACL it inherited
 * from its directory. That is not a cosmetic gap — a freshly created database
 * under `%TEMP%` or a shared profile can inherit Modify for app containers and
 * for other local accounts, and this file holds encrypted provider keys, the
 * dashboard password hash, or the master encryption key.
 *
 * The Windows leg therefore drops inheritance and rewrites the ACL to exactly
 * three principals: the current user, SYSTEM and Administrators. Keeping the
 * last two mirrors POSIX, where 0600 never locks root out — and dropping them
 * would break backup agents and service accounts for no security gain, since
 * both can take ownership regardless.
 *
 * `restrictDirToOwner` covers what per-file hardening structurally cannot: a
 * file that does not exist yet. SQLite's `-wal`/`-shm` sidecars are created on
 * the first write, long after startup has walked the file list, so the only
 * thing that can protect them is the directory holding them. The two platforms
 * reach that guarantee by different mechanisms, and it is worth being precise
 * about which, because they are not the same idea:
 *
 *   - Windows really does inherit. `(OI)(CI)` marks an ACE object- and
 *     container-inheritable, so a sidecar created afterwards is born with the
 *     restricted ACL already on it.
 *   - POSIX does not propagate modes at all — a file created inside a 0700
 *     directory still lands at 0644. It does not need to: 0700 clears the search
 *     bit for group and other, and without search permission no other account
 *     can resolve a path through the directory to reach the child in the first
 *     place. The sidecar is unreachable rather than unreadable.
 */

/** Injectable seam so tests never spawn a real process. Mirrors the `ExecFile`
 *  seam in routes/update.ts, but sync: the callers run at startup, not on the
 *  request path, and making them async would ripple through every connectDb. */
export type ExecFileSyncLike = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; windowsHide: true; stdio: ['ignore', 'pipe', 'pipe'] },
) => string;

export interface RestrictOptions {
  platform?: NodeJS.Platform;
  execFileSync?: ExecFileSyncLike;
  /** Pre-resolved owner SID, so a caller hardening several files pays for the
   *  lookup once. Tests pass it to skip the `whoami` round trip entirely. */
  ownerSid?: string | null;
}

const EXEC_TIMEOUT_MS = 5_000;

/** SYSTEM and the local Administrators group, as well-known SIDs. Referenced by
 *  SID rather than by name because the display names are localized — a German
 *  Windows reports `VORDEFINIERT\Administratoren`. */
const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINISTRATORS = 'S-1-5-32-544';

const defaultExecFileSync: ExecFileSyncLike = (file, args, options) =>
  nodeExecFileSync(file, args, options) as unknown as string;

/** Absolute path into System32. Never resolve these off PATH: a Git Bash or
 *  MSYS `whoami` shadows the Windows one and fails outright, and letting PATH
 *  decide which binary hardens a file is itself a hijack vector. */
function system32(binary: string): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', binary);
}

let cachedOwnerSid: string | null | undefined;

/**
 * The current user's SID, via `whoami /user /fo csv /nh`, which prints
 * `"DOMAIN\\user","S-1-5-21-..."`. Returns null if it cannot be determined.
 * Memoized only for the real binary — a process's own SID cannot change — so an
 * injected fake in tests is never cached and never reads another test's value.
 */
function resolveOwnerSid(exec: ExecFileSyncLike, useCache: boolean): string | null {
  if (useCache && cachedOwnerSid !== undefined) return cachedOwnerSid;

  let sid: string | null = null;
  try {
    // No existsSync guard: a missing binary throws ENOENT out of exec, which
    // this catch already handles, and probing the filesystem first would make
    // the Windows branch untestable anywhere but Windows.
    const out = exec(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sid = /"(S-1-[0-9-]+)"/.exec(out)?.[1] ?? null;
  } catch {
    sid = null;
  }

  if (useCache) cachedOwnerSid = sid;
  return sid;
}

/**
 * The icacls arguments that restrict `target` to `ownerSid` + SYSTEM +
 * Administrators. Split out from the spawn so the command shape is testable
 * without a Windows box.
 *
 * `/inheritance:r` removes the inherited ACEs (the whole point — that is where
 * the extra principals come from), and `/grant:r` replaces rather than adds, so
 * running it twice is idempotent. The `*` prefix makes icacls read each
 * principal as a SID literal instead of an account name.
 *
 * `inheritable` adds `(OI)(CI)` so children created later are born restricted.
 * It is only ever set for a directory: the flags describe what a container
 * hands down, and on a leaf file they protect nothing.
 */
export function windowsRestrictArgs(
  target: string,
  ownerSid: string,
  opts?: { inheritable?: boolean },
): string[] {
  const rights = opts?.inheritable ? '(OI)(CI)(F)' : '(F)';
  return [
    target,
    '/inheritance:r',
    '/grant:r', `*${ownerSid}:${rights}`,
    '/grant:r', `*${SID_SYSTEM}:${rights}`,
    '/grant:r', `*${SID_ADMINISTRATORS}:${rights}`,
  ];
}

/** A directory needs its search bit kept, or the owning process locks itself
 *  out of its own data directory; 0600 on a directory is not a stricter 0700,
 *  it is a broken one. */
const POSIX_MODE = { file: 0o600, directory: 0o700 } as const;

function restrict(
  target: string,
  kind: 'file' | 'directory',
  opts?: RestrictOptions,
): boolean {
  const platform = opts?.platform ?? process.platform;
  const exec = opts?.execFileSync ?? defaultExecFileSync;

  try {
    if (!fs.existsSync(target)) return true;
  } catch {
    return false;
  }

  if (platform !== 'win32') {
    try {
      fs.chmodSync(target, POSIX_MODE[kind]);
      return true;
    } catch {
      return false;
    }
  }

  const ownerSid = opts?.ownerSid !== undefined
    ? opts.ownerSid
    : resolveOwnerSid(exec, opts?.execFileSync === undefined);
  if (!ownerSid) return false;

  try {
    exec(
      system32('icacls.exe'),
      windowsRestrictArgs(target, ownerSid, { inheritable: kind === 'directory' }),
      {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Restrict `target` to its owner. Never throws: permissions are a hardening
 * measure, not a correctness one, and startup must survive a filesystem that
 * cannot express them.
 *
 * @returns true when the restriction was applied, false when it could not be.
 *          Callers are expected to surface a false — the failure mode that made
 *          this function necessary was a guard everyone believed was running.
 */
export function restrictToOwner(target: string, opts?: RestrictOptions): boolean {
  return restrict(target, 'file', opts);
}

/**
 * Restrict a directory to its owner, so files created inside it later are
 * protected without anyone having to remember to harden them. See the header
 * for why this is the only thing that can cover SQLite's WAL sidecars.
 *
 * Callers must be sure the directory is theirs. This is deliberately not
 * something to do to any path handed in by configuration: locking down a shared
 * directory — a temp dir, a working copy, someone else's data directory — is a
 * worse outage than the leak it prevents.
 *
 * @returns true when the restriction was applied, false when it could not be.
 */
export function restrictDirToOwner(target: string, opts?: RestrictOptions): boolean {
  return restrict(target, 'directory', opts);
}

/**
 * Restrict several files that share an owner, resolving the SID at most once.
 * Missing files are skipped, not failed — SQLite's `-wal`/`-shm` sidecars do not
 * exist until the first write.
 *
 * @returns the targets that could not be restricted.
 */
export function restrictAllToOwner(targets: string[], opts?: RestrictOptions): string[] {
  const platform = opts?.platform ?? process.platform;
  const exec = opts?.execFileSync ?? defaultExecFileSync;
  const ownerSid = platform === 'win32' && opts?.ownerSid === undefined
    ? resolveOwnerSid(exec, opts?.execFileSync === undefined)
    : opts?.ownerSid ?? null;

  const failed: string[] = [];
  for (const target of targets) {
    if (!restrictToOwner(target, { ...opts, platform, ownerSid })) failed.push(target);
  }
  return failed;
}
