import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { loadConfig } from '../../lib/config.js';

async function getHeaders(
  app: Express,
  path: string,
  forwardedProto?: string,
  host?: string,
): Promise<Headers> {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const headers: Record<string, string> = {};
  if (forwardedProto) headers['x-forwarded-proto'] = forwardedProto;
  // Overriding Host is how a LAN/reverse-proxy origin is simulated without
  // actually binding to one: req.hostname reads it. node:http rather than
  // fetch(), because undici silently overwrites Host with the connect target.
  if (host) headers['host'] = host;
  try {
    return await new Promise<Headers>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: addr.port, path, headers },
        res => {
          res.resume();
          resolve(new Headers(res.headers as Record<string, string>));
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

describe('CSP security headers', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('sets the Content-Security-Policy header on every response', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy');
    expect(csp).toBeTruthy();
  });

  it('restricts default-src to self', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
  });

  it('restricts script-src to self', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
  });

  it('allows inline styles for React hydration', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('does not set HSTS (local-only proxy)', async () => {
    const headers = await getHeaders(app, '/api/ping');
    expect(headers.get('strict-transport-security')).toBeNull();
  });
});

// #682: upgrade-insecure-requests broke plain-HTTP LAN installs because the
// browser rewrites /assets/* to https:// on an origin with no TLS. The directive
// is now gated by request protocol + the CSP_UPGRADE_INSECURE_REQUESTS env.
describe('CSP upgrade-insecure-requests (#682)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('omits upgrade-insecure-requests on plain HTTP (LAN)', async () => {
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('emits upgrade-insecure-requests behind an HTTPS reverse proxy (X-Forwarded-Proto)', async () => {
    const headers = await getHeaders(app, '/api/ping', 'https');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain('upgrade-insecure-requests');
  });
});

// #734: COOP and Origin-Agent-Cluster apply to secure contexts only. Sending
// them to a plain-HTTP LAN origin gets them discarded with a console error, so
// they are emitted only where the browser would honour them.
describe('secure-context-only headers (#734)', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('omits COOP and Origin-Agent-Cluster on a plain-HTTP LAN origin', async () => {
    const headers = await getHeaders(app, '/api/ping', undefined, '192.168.3.50:4001');
    expect(headers.get('cross-origin-opener-policy')).toBeNull();
    expect(headers.get('origin-agent-cluster')).toBeNull();
  });

  it('keeps them on loopback, which is a secure context over plain HTTP', async () => {
    for (const host of ['localhost:3001', '127.0.0.1:3001', 'freellmapi.localhost']) {
      const headers = await getHeaders(app, '/api/ping', undefined, host);
      expect(headers.get('cross-origin-opener-policy'), host).toBe('same-origin');
      expect(headers.get('origin-agent-cluster'), host).toBe('?1');
    }
  });

  it('keeps them behind an HTTPS reverse proxy', async () => {
    const headers = await getHeaders(app, '/api/ping', 'https', 'proxy.example.com');
    expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(headers.get('origin-agent-cluster')).toBe('?1');
  });

  it('reads the client-facing hop from a multi-proxy X-Forwarded-Proto', async () => {
    const headers = await getHeaders(app, '/api/ping', 'https, http', 'proxy.example.com');
    expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
  });

  it('leaves Cross-Origin-Resource-Policy alone (it is not secure-context gated)', async () => {
    const headers = await getHeaders(app, '/api/ping', undefined, '192.168.3.50:4001');
    expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });
});

describe('CSP_UPGRADE_INSECURE_REQUESTS env override (#682)', () => {
  let app: Express;
  const envKey = 'CSP_UPGRADE_INSECURE_REQUESTS';

  afterAll(() => {
    delete process.env[envKey];
  });

  it('force-on: emits the directive even on plain HTTP', async () => {
    process.env[envKey] = 'true';
    app = createApp(loadConfig());
    const headers = await getHeaders(app, '/api/ping');
    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('force-off: omits the directive even behind an HTTPS reverse proxy', async () => {
    process.env[envKey] = 'false';
    app = createApp(loadConfig());
    const headers = await getHeaders(app, '/api/ping', 'https');
    const csp = headers.get('content-security-policy')!;
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});
