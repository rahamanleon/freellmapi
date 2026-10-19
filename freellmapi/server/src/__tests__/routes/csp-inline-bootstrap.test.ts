import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { createApp, INLINE_BOOTSTRAP_SHA } from '../../app.js';
import { initDb } from '../../db/index.js';

// index.html ships one inline <script>: the theme/direction bootstrap that has
// to run before first paint so dark-mode users do not get a white flash.
// `script-src 'self'` blocked it on EVERY install, HTTPS included — the
// violation is visible in the console log pasted into #682, where it was read
// as part of the LAN/HTTP problem. It is not: it reproduces on localhost too.
//
// The hash is a literal in app.ts so the CSP header stays constant. These tests
// are the guard against drift: edit the inline script without updating the
// hash and the suite fails here rather than in a user's browser.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

function inlineBootstrapFrom(html: string): string | null {
  // The bootstrap is the only <script> with no src attribute.
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  return match ? match[1]! : null;
}

function sha256Directive(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

describe('CSP allows the inline theme bootstrap (#682)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('the hash in app.ts matches the inline script in client/index.html', () => {
    const html = fs.readFileSync(path.join(repoRoot, 'client/index.html'), 'utf8');
    const inline = inlineBootstrapFrom(html);
    expect(inline, 'no inline <script> found in client/index.html').not.toBeNull();
    expect(sha256Directive(inline!)).toBe(INLINE_BOOTSTRAP_SHA);
  });

  it('the hash also matches the built client, when one is present', () => {
    // Vite copies index.html through, but a future plugin could rewrite the
    // inline script — the browser enforces the hash against the BUILT file, so
    // that is the one that really has to match.
    const built = path.join(repoRoot, 'client/dist/index.html');
    if (!fs.existsSync(built)) return;
    const inline = inlineBootstrapFrom(fs.readFileSync(built, 'utf8'));
    expect(inline, 'no inline <script> found in client/dist/index.html').not.toBeNull();
    expect(sha256Directive(inline!)).toBe(INLINE_BOOTSTRAP_SHA);
  });

  it('serves that hash in the script-src directive', async () => {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/ping`);
    server.close();
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain(`script-src 'self' ${INLINE_BOOTSTRAP_SHA}`);
  });

  it('still refuses inline scripts generally — no unsafe-inline for scripts', async () => {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/ping`);
    server.close();
    const csp = res.headers.get('content-security-policy')!;
    const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src '))!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});
