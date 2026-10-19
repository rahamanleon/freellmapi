import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// v0.14.0/v0.14.1: the Intel macOS release failed when stapling lost its
// connection to Apple right after notarization was accepted. Notarization now
// runs in our own afterSign hook, which retries the staple.

const yaml = createRequire(import.meta.url)('js-yaml');
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '../..');
const hookRel = './scripts/after-sign-notarize.mjs';
const hook = await import(pathToFileURL(resolve(desktopRoot, hookRel)).href);

type Result = { code: number; stdout: string; stderr: string };
const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): Result => ({ code: 68, stdout: '', stderr });

function fakeExec(script: Array<[string, Result]>) {
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    const i = script.findIndex(([prefix]) => line.startsWith(prefix));
    if (i === -1) return ok();
    const [, result] = script.splice(i, 1)[0];
    return result;
  };
  return { exec, calls };
}

const quiet = { log: () => {}, sleep: async () => {} };
const apiEnv = { APPLE_API_KEY: '/tmp/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'ISSUER' };
const context = { electronPlatformName: 'darwin', appOutDir: '/out/mac', packager: { appInfo: { productFilename: 'FreeLLMAPI' } } };

describe('afterSign notarization', () => {
  it('replaces electron-builder notarization with the hook', () => {
    const config = yaml.load(readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8')) as { afterSign?: string; mac?: { notarize?: boolean } };
    expect(config.afterSign).toBe(hookRel);
    expect(config.mac?.notarize).toBe(false);
    expect(existsSync(resolve(desktopRoot, hookRel))).toBe(true);
  });

  it('builds notarytool auth from an API key or a keychain profile', () => {
    expect(hook.notaryAuthArgs(apiEnv)).toEqual(['--key', '/tmp/AuthKey.p8', '--key-id', 'KEYID', '--issuer', 'ISSUER']);
    expect(hook.notaryAuthArgs({ APPLE_KEYCHAIN_PROFILE: 'p', APPLE_KEYCHAIN: 'k' })).toEqual(['--keychain-profile', 'p', '--keychain', 'k']);
    expect(hook.notaryAuthArgs({})).toBeNull();
  });

  it('retries the staple when Apple drops the connection, then succeeds', async () => {
    const { exec, calls } = fakeExec([
      ['xcrun stapler staple', fail('The staple and validate action failed! Error 68.')],
      ['xcrun stapler staple', ok()],
      ['xcrun stapler validate', fail('The validate action failed! Error 68.')],
    ]);
    const attempt = await hook.stapleWithRetry('/out/mac/FreeLLMAPI.app', { exec, ...quiet });
    expect(attempt).toBe(3);
    expect(calls.filter(c => c.startsWith('xcrun stapler staple'))).toHaveLength(3);
  });

  it('gives up with a clear error after the last attempt', async () => {
    const { exec } = fakeExec(Array.from({ length: 5 }, () => ['xcrun stapler staple', fail('Error 68')] as [string, Result]));
    await expect(hook.stapleWithRetry('/x.app', { exec, ...quiet })).rejects.toThrow(/failed after 5 attempts/);
  });

  it('notarizes and staples a Developer ID signed app', async () => {
    const { exec, calls } = fakeExec([
      ['codesign', ok('Authority=Developer ID Application: Example (TEAM)')],
      ['xcrun notarytool submit', ok(JSON.stringify({ id: 'abc', status: 'Accepted' }))],
    ]);
    await hook.default(context, { exec, env: apiEnv, ...quiet });
    expect(calls.some(c => c.startsWith('ditto -c -k'))).toBe(true);
    expect(calls.find(c => c.startsWith('xcrun notarytool submit'))).toContain('--key-id KEYID');
    expect(calls).toContain(`xcrun stapler staple ${join('/out/mac', 'FreeLLMAPI.app')}`);
  });

  it('fails the build when Apple rejects the submission', async () => {
    const { exec } = fakeExec([
      ['codesign', ok('Authority=Developer ID Application: Example (TEAM)')],
      ['xcrun notarytool submit', ok(JSON.stringify({ id: 'abc', status: 'Invalid' }))],
      ['xcrun notarytool log', ok('{"issues":[]}')],
    ]);
    await expect(hook.default(context, { exec, env: apiEnv, ...quiet })).rejects.toThrow(/not accepted \(status: Invalid/);
  });

  it('skips unsigned builds, builds without credentials, and other platforms', async () => {
    const unsigned = fakeExec([['codesign', ok('Signature=adhoc')]]);
    await hook.default(context, { exec: unsigned.exec, env: apiEnv, ...quiet });
    expect(unsigned.calls.some(c => c.includes('notarytool'))).toBe(false);

    const noCreds = fakeExec([]);
    await hook.default(context, { exec: noCreds.exec, env: {}, ...quiet });
    expect(noCreds.calls).toEqual([]);

    const linux = fakeExec([]);
    await hook.default({ ...context, electronPlatformName: 'linux' }, { exec: linux.exec, env: apiEnv, ...quiet });
    expect(linux.calls).toEqual([]);
  });
});
