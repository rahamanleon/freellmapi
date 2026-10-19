import { afterEach, describe, expect, it, vi } from 'vitest';
import { AurayProvider, AURAY_BASE_URL } from '../../providers/auray.js';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, parseKeysFromFile } from '../../lib/key-parser.js';
import { supportedParametersFor } from '../../lib/sampling-params.js';

const model = 'glm-5-3-flash';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = { id: 'test', object: 'chat.completion', created: 1, model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
const frame = { id: 'test', object: 'chat.completion.chunk', created: 1, model,
  choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] };
const sse = (frames: unknown[]) => new Response(': keepalive\n\n' + frames.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

describe('Auray catalog-only provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers the provider and explicit key import aliases', () => {
    expect(getProvider('auray')).toBeInstanceOf(AurayProvider);
    expect(getProvider('auray')!.keyless).toBe(false);
    expect(parseKeysFromFile('AURAY_API_KEY=auray_sk_test_only', 'keys.env').keys[0].platform).toBe('auray');
    expect(AUTH_JSON_PROVIDER_MAP.auray).toBe('auray');
  });

  it('does not advertise sampling controls that the provider ignores', () => {
    expect(supportedParametersFor('auray')).toEqual(['max_tokens', 'max_completion_tokens', 'stream', 'response_format', 'reasoning_effort']);
    expect(supportedParametersFor('auray', { tools: true })).toEqual(['max_tokens', 'max_completion_tokens', 'stream', 'response_format', 'reasoning_effort', 'tools', 'tool_choice']);
  });

  it.each([0, 50])('validates an authenticated account with %s credits without inference', async balance => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ plan: 'free', credits: { balance } }));
    expect(await new AurayProvider().validateKey('test-key')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe('https://api.auray.ai/v1/me');
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('rejects authentication failures %s', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Invalid key' } }, status));
    await expect(new AurayProvider().validateKey('bad-key')).resolves.toMatchObject({ valid: false });
  });

  it.each([402, 429, 503])('keeps HTTP %s inconclusive and preserves Retry-After', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({}, status, { 'Retry-After': '45' }));
    await expect(new AurayProvider().validateKey('test-key')).rejects.toMatchObject({ status, retryAfterMs: 45_000 });
  });

  it.each([{}, null, { plan: 'free', credits: { balance: '50' } }])('rejects malformed account responses', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(new AurayProvider().validateKey('test-key')).rejects.toMatchObject({ status: 502 });
  });

  it('uses the compatibility endpoint, preserving options and usage', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(completion));
    const out = await new AurayProvider().chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], model,
      { max_tokens: 256, reasoning_effort: 'minimal', response_format: { type: 'json_object' } });
    expect(fetch.mock.calls[0][0]).toBe(`${AURAY_BASE_URL}/chat/completions`);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ model, max_tokens: 256, reasoning_effort: 'minimal', response_format: { type: 'json_object' } });
    expect(out.usage?.total_tokens).toBe(4);
    expect(out._routed_via).toEqual({ platform: 'auray', model });
  });

  it.each([{ ...completion, model: 'substitute' }, { ...completion, model: undefined }, { ...completion, choices: [] }, { error: { code: 'vendor_disabled' } }])('fails closed on mismatched/malformed HTTP 200', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(new AurayProvider().chatCompletion('test-key', [], model)).rejects.toMatchObject({ status: 502 });
  });

  it('preserves HTTP rate-limit hints without retrying a paid request', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { message: 'Rate limited' } }, 429, { 'Retry-After': '45' }));
    await expect(new AurayProvider().chatCompletion('test-key', [], model)).rejects.toMatchObject({ status: 429, retryAfterMs: 45_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('streams text, tools, reasoning and usage-only events', async () => {
    const tools = [{ index: 0, id: 'call_au_1', type: 'function', function: { name: 'test', arguments: '{}' } }];
    vi.spyOn(global, 'fetch').mockResolvedValue(sse([frame, { ...frame, choices: [{ index: 0, delta: { reasoning_content: 'reason', tool_calls: tools }, finish_reason: 'tool_calls' }] }, { ...frame, choices: [], usage: completion.usage }]));
    const chunks = [];
    for await (const c of new AurayProvider().streamChatCompletion('test-key', [], model)) chunks.push(c);
    expect(chunks[0].choices[0].delta.content).toBe('OK');
    expect(chunks[1].choices[0].delta.tool_calls?.[0].id).toBe('call_au_1');
    expect(chunks.at(-1)?.usage?.total_tokens).toBe(4);
  });

  it.each([[], [{ ...frame, model: 'other' }], [{ ...frame, choices: undefined }], [frame, { error: { code: 'vendor_disabled' } }]].map(frames => ({ frames })))('rejects empty, substituted or deferred-error streams', async ({ frames }) => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sse(frames));
    await expect((async () => { for await (const _chunk of new AurayProvider().streamChatCompletion('test-key', [], model)) { /* drain */ } })()).rejects.toMatchObject({ status: 502 });
  });
});
