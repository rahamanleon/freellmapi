import { describe, it, expect, vi, afterEach } from 'vitest';
import { PollinationsProvider } from '../../providers/pollinations.js';
import { getProvider, hasProvider, resolveProvider } from '../../providers/index.js';
import type { KeyValidationFailure } from '../../providers/base.js';

// Fake fixtures only — no real Pollinations key appears here or in any
// assertion message (#608 acceptance criterion: never log the key).
const REVOKED_KEY = 'sk_test_revoked';
const VALID_KEY = 'sk_test_valid';

const ACCOUNT_KEY_URL = 'https://gen.pollinations.ai/account/key';

// Verified live 2026-07-28: GET /v1/models answers 200 for a garbage bearer.
const PUBLIC_MODELS_200 = {
  ok: true,
  status: 200,
  json: () => Promise.resolve({ object: 'list', data: [{ id: 'openai-fast', object: 'model' }] }),
};

// Verified live 2026-07-28 against /account/key with a garbage bearer.
const ACCOUNT_KEY_401 = {
  ok: false,
  status: 401,
  statusText: 'Unauthorized',
  json: () => Promise.resolve({
    success: false,
    error: { message: 'API key required. This endpoint validates API keys.', code: 'UNAUTHORIZED' },
    status: 401,
  }),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Pollinations registration (#608)', () => {
  it('is registered and routable in the provider registry', () => {
    expect(hasProvider('pollinations')).toBe(true);
    const provider = getProvider('pollinations');
    expect(provider).toBeInstanceOf(PollinationsProvider);
    expect(provider?.platform).toBe('pollinations');
    expect(provider?.name).toBe('Pollinations');
    expect(provider?.keyless).toBe(false);
    expect(resolveProvider('pollinations')).toBe(provider);
  });
});

describe('Pollinations validateKey (#608)', () => {
  it('does NOT trust the public GET /v1/models — a revoked key that 200s there is invalid', async () => {
    // The reported repro: the same revoked key gets 200 from /v1/models and 401
    // from an authenticated endpoint.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      if (String(url).endsWith('/v1/models')) return PUBLIC_MODELS_200 as unknown as Response;
      return ACCOUNT_KEY_401 as unknown as Response;
    });

    const provider = new PollinationsProvider();
    const result = await provider.validateKey(REVOKED_KEY);

    expect(result).not.toBe(true);
    const failure = result as KeyValidationFailure;
    expect(failure.valid).toBe(false);
    expect(failure.error).toContain('401');
    expect(failure.error).toContain('API key required');
    // The key itself must never reach a health log line.
    expect(failure.error).not.toContain(REVOKED_KEY);

    // The public catalog endpoint must not be probed at all.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ACCOUNT_KEY_URL);
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${REVOKED_KEY}`);
  });

  it('returns true when /account/key authenticates (200)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, key: { valid: true, tier: 'seed' } }),
    } as unknown as Response);

    const provider = new PollinationsProvider();
    await expect(provider.validateKey(VALID_KEY)).resolves.toBe(true);
  });

  it('treats 402 as a VALID key (billing/quota, not auth)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 402,
      json: () => Promise.resolve({ error: { message: 'Insufficient pollen balance' } }),
    } as unknown as Response);

    const provider = new PollinationsProvider();
    await expect(provider.validateKey(VALID_KEY)).resolves.toBe(true);
  });

  it('treats 403 as inconclusive (throws) — permission, not a revoked key', async () => {
    // Pollinations returns 403 when the credential authenticated but lacks the
    // account permission the probe needs. Throwing keeps health.ts on
    // status=error (previous verdict preserved, no auto-disable).
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { message: 'Insufficient permissions' } }),
    } as unknown as Response);

    const provider = new PollinationsProvider();
    await expect(provider.validateKey(VALID_KEY)).rejects.toThrow(/inconclusive/i);
  });

  it('treats a 5xx from /account/key as inconclusive (throws), never invalid', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const provider = new PollinationsProvider();
    await expect(provider.validateKey(VALID_KEY)).rejects.toThrow(/HTTP 503/);
  });

  it('propagates a network timeout instead of reporting the key invalid', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    vi.spyOn(global, 'fetch').mockRejectedValue(abort);

    const provider = new PollinationsProvider();
    await expect(provider.validateKey(VALID_KEY)).rejects.toThrow(/aborted/i);
  });
});
