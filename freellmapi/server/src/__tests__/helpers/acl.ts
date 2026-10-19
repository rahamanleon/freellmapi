import path from 'path';
import { execFileSync } from 'node:child_process';

/**
 * The access-control entries icacls reports for a file, one line per principal.
 *
 * Windows has no POSIX mode and Node exposes no ACL API, so asking the OS is
 * the only way for a test to assert the real guarantee. This shells out to
 * icacls directly rather than reusing lib/file-permissions, so a bug in the
 * production helper cannot make its own test pass.
 *
 * Every ACE line carries a "PRINCIPAL:(RIGHTS)" pair; the leading path line
 * ("C:\\...") and the trailing "Successfully processed" summary do not. An
 * inherited entry is marked "(I)" — its absence is what proves the file no
 * longer picks up principals from its parent directory.
 *
 * Windows-only: callers must gate on `process.platform === 'win32'`.
 */
export function aclEntries(target: string): string[] {
  const out = execFileSync(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
    [target],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.split(/\r?\n/).map(line => line.trim()).filter(line => /:\(/.test(line));
}
