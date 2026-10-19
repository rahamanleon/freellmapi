import { afterEach, describe, expect, it, vi } from 'vitest';
import { BeatApiProvider } from '../../providers/beatapi.js';
import { SerpSearchProvider } from '../../providers/serpsearch.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
afterEach(() => vi.restoreAllMocks());

describe.each([
  { platform: 'beatapi' as const, provider: new BeatApiProvider(), url: 'https://api.beatapi.io/v1/models' },
  { platform: 'serpsearch' as const, provider: new SerpSearchProvider(), url: 'https://api.serpsearch.com/api/v1/search' },
])('$platform credentials', ({ platform, provider, url }) => {
  it('registers and imports explicitly named keys', () => {
    expect(getProvider(platform)).toBeInstanceOf(provider.constructor);
    expect(parseKeysFromFile(`${platform.toUpperCase()}_API_KEY=unit-test-only`, 'keys.env').keys[0].platform).toBe(platform);
    expect(AUTH_JSON_PROVIDER_MAP[platform]).toBe(platform);
  });

  it('validates without spending search or inference quota', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(platform === 'beatapi'
      ? json({ data: [{ id: 'jev-1.14-free' }] })
      : new Response('Failed to deserialize query string: missing field `query`', { status: 400, headers: { 'x-quota-limit': '1000' } }));
    expect(await provider.validateKey('unit-test-key')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(url);
    const init = fetch.mock.calls[0][1]!;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer unit-test-key');
  });

  it.each([401, 403])('rejects HTTP %s authentication failures', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Invalid API key' } }, status));
    await expect(provider.validateKey('invalid')).resolves.toMatchObject({ valid: false });
  });

  it.each([429, 500, 503])('keeps HTTP %s inconclusive with retry hints', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({}, status, { 'Retry-After': '60' }));
    await expect(provider.validateKey('unit-test-key')).rejects.toMatchObject({ status, retryAfterMs: 60_000 });
  });

  it('rejects ordinary and streaming chat without making a request', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    const base = getProvider(platform)!;
    await expect(base.chatCompletion('k', [], 'm')).rejects.toMatchObject({ status: 422 });
    await expect(base.streamChatCompletion('k', [], 'm').next()).rejects.toMatchObject({ status: 422 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

it.each([null, {}, { data: {} }, { data: [], error: 'failure' }])('rejects malformed BeatAPI lists', async body => {
  vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
  await expect(new BeatApiProvider().validateKey('k')).rejects.toMatchObject({ status: 502 });
});

it.each([
  { body: 'missing field `query`', headers: {} },
  { body: 'unrelated error', headers: { 'x-quota-limit': '1000' } },
])('does not accept unauthenticated or unrelated SerpSearch 400s', async ({ body, headers }) => {
  vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body, { status: 400, headers }));
  await expect(new SerpSearchProvider().validateKey('k')).rejects.toMatchObject({ status: 400 });
});
