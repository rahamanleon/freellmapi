// Notarize and staple the signed .app (replaces electron-builder's built-in
// `mac.notarize`). The built-in path staples once and gives up, and on the
// macos-15-intel runners the staple's ticket lookup at api.apple-cloudkit.com
// regularly loses its connection ("Error 68", NSURLErrorDomain -1005) right
// after Apple accepted the submission — that held back the v0.14.0 and v0.14.1
// desktop installers. The ticket already exists by then, so retrying the
// staple with a short backoff is all it takes.
//
// Same credentials as electron-builder: an App Store Connect API key
// (APPLE_API_KEY = path to the .p8, APPLE_API_KEY_ID, APPLE_API_ISSUER) or a
// stored notarytool keychain profile (APPLE_KEYCHAIN_PROFILE, optionally
// APPLE_KEYCHAIN). Without credentials, or for an app that is not signed with
// a Developer ID (local and pull-request builds), it skips, as electron-builder
// did.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const STAPLE_ATTEMPTS = 5;
export const STAPLE_BACKOFF_MS = 20_000;

/** Runs a command and resolves { code, stdout, stderr } without throwing. */
async function run(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message ?? err) };
  }
}

/** notarytool authentication arguments from the environment, or null. */
export function notaryAuthArgs(env = process.env) {
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  }
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? ['--keychain', env.APPLE_KEYCHAIN] : [])];
  }
  return null;
}

/** Staple, then validate, retrying both together on failure. */
export async function stapleWithRetry(target, { exec = run, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.log, attempts = STAPLE_ATTEMPTS, backoffMs = STAPLE_BACKOFF_MS } = {}) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const staple = await exec('xcrun', ['stapler', 'staple', target]);
    const validate = staple.code === 0 ? await exec('xcrun', ['stapler', 'validate', target]) : null;
    if (validate && validate.code === 0) {
      log(`  stapled ${target}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return attempt;
    }
    const failed = validate ?? staple;
    last = `${failed.stdout}${failed.stderr}`.trim().split('\n').slice(-2).join(' ');
    if (attempt < attempts) {
      log(`  staple attempt ${attempt} failed, retrying in ${(backoffMs * attempt) / 1000}s: ${last}`);
      await sleep(backoffMs * attempt);
    }
  }
  throw new Error(`stapling ${target} failed after ${attempts} attempts: ${last}`);
}

/** Submit a zip of the app and wait; throws unless Apple accepts it. */
export async function submitForNotarization(appPath, auth, { exec = run, log = console.log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'notarize-'));
  const zip = join(dir, 'app.zip');
  try {
    const zipped = await exec('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip]);
    if (zipped.code !== 0) throw new Error(`zipping ${appPath} failed: ${zipped.stderr}`);
    log(`  submitting ${appPath} to Apple's notary service`);
    const submitted = await exec('xcrun', ['notarytool', 'submit', zip, ...auth, '--wait', '--timeout', '30m', '--output-format', 'json']);
    let result = {};
    try { result = JSON.parse(submitted.stdout); } catch { /* reported below */ }
    if (result.status !== 'Accepted') {
      let detail = '';
      if (result.id) {
        const notes = await exec('xcrun', ['notarytool', 'log', result.id, ...auth]);
        detail = `\n${notes.stdout}`;
      }
      throw new Error(`notarization was not accepted (status: ${result.status ?? 'unknown'}, exit ${submitted.code}): ${submitted.stderr}${detail}`);
    }
    log(`  notarization accepted (${result.id})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async function afterSign(context, deps = {}) {
  if (context.electronPlatformName !== 'darwin') return;
  const { exec = run, log = console.log, env = process.env } = deps;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const auth = notaryAuthArgs(env);
  if (!auth) {
    log('  skipped notarization: no Apple API key or keychain profile in the environment');
    return;
  }
  const signature = await exec('codesign', ['-dv', '--verbose=2', appPath]);
  if (!`${signature.stdout}${signature.stderr}`.includes('Authority=Developer ID Application')) {
    log('  skipped notarization: the app is not signed with a Developer ID certificate');
    return;
  }
  await submitForNotarization(appPath, auth, { exec, log });
  await stapleWithRetry(appPath, { ...deps, exec, log });
}
