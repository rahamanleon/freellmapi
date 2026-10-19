import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModelScopeProvider } from '../../providers/modelscope.js';
import { getProvider, hasProvider, resolveProvider } from '../../providers/index.js';
import type { KeyValidationFailure } from '../../providers/base.js';

// All fixtures are deliberately fake — no real ModelScope tokens exist for
// this project yet (auth requires an Alibaba Cloud cn-site account binding).
const GARBAGE_KEY = 'ms-test-invalid';

const ROSTER = {
  ok: true,
  status: 200,
  json: () => Promise.resolve({
    object: 'list',
    data: [
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', object: 'model' },
      { id: 'deepseek-ai/DeepSeek-V4-Flash', object: 'model' },
    ],
  }),
};

// The verified keyless probe (2026-07-26): a 401 from chat/completions with a
// garbage Bearer token. The alibaba-binding variant below is the
// maintainer-documented shape for unbound accounts — unconfirmed until a
// community tester runs a real token (#581).
const AUTH_FAILED_401 = {
  ok: false,
  status: 401,
  json: () => Promise.resolve({
    error: { message: 'please bind your alibaba cloud account before use' },
  }),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ModelScope registration (#581)', () => {
  it('is registered and routable in the provider registry', () => {
    expect(hasProvider('modelscope')).toBe(true);
    const provider = getProvider('modelscope');
    expect(provider).toBeInstanceOf(ModelScopeProvider);
    expect(provider?.platform).toBe('modelscope');
    expect(provider?.name).toBe('ModelScope');
    expect(provider?.keyless).toBe(false);
    // resolveProvider (the routing entry point) returns the same singleton.
    expect(resolveProvider('modelscope')).toBe(provider);
  });
});

describe('ModelScope validateKey (#581)', () => {
  it('does NOT trust GET /v1/models — a garbage key that 200s there is still invalid', async () => {
    // The trap: ModelScope's /v1/models answers 200 with or without auth
    // (verified keyless 2026-07-26), so the default openai-compat validateKey
    // would mark garbage keys healthy forever.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      if (String(url).endsWith('/models')) return ROSTER as unknown as Response;
      return AUTH_FAILED_401 as unknown as Response;
    });

    const provider = new ModelScopeProvider();
    const result = await provider.validateKey(GARBAGE_KEY);

    expect(result).not.toBe(true);
    const failure = result as KeyValidationFailure;
    expect(failure.valid).toBe(false);
    // The alibaba-binding reason must surface verbatim in the health error.
    expect(failure.error).toContain('please bind your alibaba cloud account before use');
    expect(failure.error).toContain('401');

    // Probe shape: models list first (to pick a live model id), then a
    // 1-token chat completion that actually enforces auth.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://api-inference.modelscope.cn/v1/models');
    expect(calls[1].url).toBe('https://api-inference.modelscope.cn/v1/chat/completions');
    expect(calls[1].init.method).toBe('POST');
    const body = JSON.parse(String(calls[1].init.body));
    expect(body.model).toBe('Qwen/Qwen3-235B-A22B-Instruct-2507'); // first roster entry
    expect(body.max_tokens).toBe(1);
    expect((calls[1].init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${GARBAGE_KEY}`);
  });

  it('returns true when the 1-token chat probe authenticates (200)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/models')) return ROSTER as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'chatcmpl-1', object: 'chat.completion', created: 1,
          model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
          choices: [{ index: 0, message: { role: 'assistant', content: 'p' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });

    const provider = new ModelScopeProvider();
    await expect(provider.validateKey('ms-test-valid-shaped')).resolves.toBe(true);
  });

  it('treats a 429 probe answer as a VALID key (quota, not auth)', async () => {
    // ModelScope also 429s for retired models ("insufficient balance (1008)").
    // Neither case is an auth failure, so the key must not be disabled.
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/models')) return ROSTER as unknown as Response;
      return {
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: { message: 'Request limit exceeded' } }),
      } as unknown as Response;
    });

    const provider = new ModelScopeProvider();
    await expect(provider.validateKey('ms-test-valid-shaped')).resolves.toBe(true);
  });

  it('throws (health status=error, never invalid) when the roster fetch fails', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    } as unknown as Response);

    const provider = new ModelScopeProvider();
    await expect(provider.validateKey(GARBAGE_KEY)).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the roster is empty (no probe model available)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ object: 'list', data: [] }),
    } as unknown as Response);

    const provider = new ModelScopeProvider();
    await expect(provider.validateKey(GARBAGE_KEY)).rejects.toThrow(/no models/);
  });

  it('caches a successful validation per key and skips the network on repeat checks', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/models')) return ROSTER as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'chatcmpl-1', object: 'chat.completion', created: 1,
          model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
          choices: [{ index: 0, message: { role: 'assistant', content: 'p' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as unknown as Response;
    });

    const provider = new ModelScopeProvider();
    const ctx = {
      platform: 'modelscope' as const,
      keyId: 48,
      quotaPoolKey: 'modelscope::account',
      endpoint: 'models',
      origin: 'health' as const,
    };

    // First validation probes the network (models + chat completion).
    await expect(provider.validateKey('ms-test-valid-shaped', ctx)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Second validation within the cache window returns true without any call.
    await expect(provider.validateKey('ms-test-valid-shaped', ctx)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // A DIFFERENT token on the same key row is a different secret — rotating a
    // key in place must re-probe rather than inherit the old token's verdict.
    await expect(provider.validateKey('ms-test-rotated', ctx)).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('does not cache an invalid validation (a 401 re-probes on the next check)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/models')) return ROSTER as unknown as Response;
      return AUTH_FAILED_401 as unknown as Response;
    });

    const provider = new ModelScopeProvider();
    const ctx = {
      platform: 'modelscope' as const,
      keyId: 48,
      quotaPoolKey: 'modelscope::account',
      endpoint: 'models',
      origin: 'health' as const,
    };

    await expect(provider.validateKey(GARBAGE_KEY, ctx)).resolves.not.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // A failed validation must not be cached — the next health pass re-probes.
    await expect(provider.validateKey(GARBAGE_KEY, ctx)).resolves.not.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
