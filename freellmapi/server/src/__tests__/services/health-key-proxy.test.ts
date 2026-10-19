import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import https from 'https';
import { encrypt } from '../../lib/crypto.js';
import { encryptProxyUrl } from '../../lib/key-proxy.js';
import { getDb, initDb } from '../../db/index.js';

const validateKey = vi.hoisted(() => vi.fn());

vi.mock('../../providers/index.js', () => ({
  resolveProvider: () => ({ name: 'Mistral', validateKey }),
}));

const { checkKeyHealth, probeKeyValidity } = await import('../../services/health.js');
const { applyProxyUrl, applyProxyEnabled, applyProxyBypass, proxyFetch } = await import('../../lib/proxy.js');

// The agent handed to https.request carries the SOCKS proxy's port, so which
// proxy a validation call went through is directly observable.
function stubHttpsRequest() {
  return vi.spyOn(https, 'request').mockImplementation(((_opts: any, cb: any) => {
    const req = new EventEmitter() as any;
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      res.statusMessage = 'OK';
      res.headers = {};
      res.destroy = () => {};
      cb(res);
      setImmediate(() => res.emit('end'));
    };
    return req;
  }) as any);
}

// #590: a key exists behind its own proxy precisely because the provider is
// unreachable (or geo-blocked) without it. Validating such a key on the direct
// path would fail three checks in a row and auto-disable a perfectly good
// credential, so health checks and cooldown probes go through the key's proxy
// exactly like its traffic does.
describe('Key health — per-key proxy override (#590)', () => {
  let nextId = 7000;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    validateKey.mockReset();
    vi.restoreAllMocks();
    delete process.env.NO_PROXY;
    applyProxyEnabled(true);
    applyProxyBypass('');
    applyProxyUrl('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function seedKey(proxyUrl: string): number {
    const id = ++nextId;
    const key = encrypt('mistral-health-test-key');
    const proxy = encryptProxyUrl(proxyUrl);
    getDb().prepare(`
      INSERT INTO api_keys
        (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, proxy_encrypted, proxy_iv, proxy_auth_tag)
      VALUES (?, 'mistral', 'health-test', ?, ?, ?, 1, 'unknown', ?, ?, ?)
    `).run(id, key.encrypted, key.iv, key.authTag, proxy.encrypted, proxy.iv, proxy.authTag);
    return id;
  }

  /** A provider whose validateKey actually reaches out, like the real ones. */
  function validatingProvider(): void {
    validateKey.mockImplementation(async () => {
      await proxyFetch('https://api.mistral.ai/v1/models', undefined, 'mistral');
      return true;
    });
  }

  const agentPortOf = (spy: ReturnType<typeof stubHttpsRequest>): unknown =>
    ((spy.mock.calls[0]?.[0] as any)?.agent)?.proxy?.port;

  it('checkKeyHealth validates through the key\'s own proxy', async () => {
    const id = seedKey('socks5h://127.0.0.1:1091');
    validatingProvider();
    const reqSpy = stubHttpsRequest();

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(agentPortOf(reqSpy)).toBe(1091);
  });

  it('checkKeyHealth uses the global proxy for a key with no override', async () => {
    const id = seedKey('');
    applyProxyUrl('socks5://127.0.0.1:1090');
    validatingProvider();
    const reqSpy = stubHttpsRequest();

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(agentPortOf(reqSpy)).toBe(1090);
  });

  it('probeKeyValidity probes through the key\'s own proxy too', async () => {
    const id = seedKey('socks5://127.0.0.1:1092');
    applyProxyUrl('socks5://127.0.0.1:1090');
    validatingProvider();
    const reqSpy = stubHttpsRequest();

    expect(await probeKeyValidity(id)).toBe('valid');
    expect(agentPortOf(reqSpy)).toBe(1092);
  });
});
