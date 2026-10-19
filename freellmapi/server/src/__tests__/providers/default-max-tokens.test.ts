import { describe, it, expect, vi, afterEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { defaultMaxTokensFor, resolveMaxTokens } from '../../lib/sampling-params.js';

// #553: Workers AI applies its own (small) server-side max_tokens when the
// request omits one, so a client that never sets max_tokens — the OpenAI SDK
// default — gets a response cut off mid-sentence a couple of seconds in. The
// gateway therefore sends a generous per-platform floor when, and only when,
// the client omitted the parameter.

function jsonResponse(): any {
  return {
    ok: true,
    json: () => Promise.resolve({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    headers: new Headers(),
  };
}

function sseResponse(): any {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, body: stream, headers: new Headers() };
}

function captureBody(response: () => any): { body: () => any } {
  let captured: any = null;
  vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    captured = JSON.parse((init as any).body);
    return response() as any;
  });
  return { body: () => captured };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveMaxTokens', () => {
  it('applies the platform default only when the client omitted max_tokens', () => {
    const cfDefault = defaultMaxTokensFor('cloudflare');
    expect(cfDefault).toBeGreaterThan(0);

    expect(resolveMaxTokens('cloudflare', undefined)).toBe(cfDefault);
    expect(resolveMaxTokens('cloudflare', 64)).toBe(64);
    // A client value above the default is never clamped down.
    expect(resolveMaxTokens('cloudflare', 100000)).toBe(100000);
  });

  it('leaves platforms without a default untouched', () => {
    expect(defaultMaxTokensFor('groq')).toBeUndefined();
    expect(resolveMaxTokens('groq', undefined)).toBeUndefined();
    expect(resolveMaxTokens('groq', 32)).toBe(32);
    expect(resolveMaxTokens('unknown-platform', undefined)).toBeUndefined();
  });
});

describe('Cloudflare default max_tokens', () => {
  const provider = new CloudflareProvider();
  const messages = [{ role: 'user' as const, content: 'Hi' }];

  it('sends the default when the client omitted max_tokens (non-streaming)', async () => {
    const cap = captureBody(jsonResponse);
    await provider.chatCompletion('acct:token', messages, '@cf/openai/gpt-oss-120b');
    expect(cap.body().max_tokens).toBe(defaultMaxTokensFor('cloudflare'));
  });

  it('sends the default when the client omitted max_tokens (streaming)', async () => {
    const cap = captureBody(sseResponse);
    const gen = provider.streamChatCompletion('acct:token', messages, '@cf/openai/gpt-oss-120b');
    for await (const _chunk of gen) { /* drain */ }
    expect(cap.body().max_tokens).toBe(defaultMaxTokensFor('cloudflare'));
  });

  it('passes a client-supplied max_tokens through untouched', async () => {
    const cap = captureBody(jsonResponse);
    await provider.chatCompletion('acct:token', messages, '@cf/openai/gpt-oss-120b', { max_tokens: 16 });
    expect(cap.body().max_tokens).toBe(16);
  });

  it('passes a client-supplied max_tokens larger than the default through untouched', async () => {
    const cap = captureBody(jsonResponse);
    await provider.chatCompletion('acct:token', messages, '@cf/openai/gpt-oss-120b', { max_tokens: 120000 });
    expect(cap.body().max_tokens).toBe(120000);
  });
});

describe('other platforms are unchanged', () => {
  const messages = [{ role: 'user' as const, content: 'Hi' }];

  it('omits max_tokens entirely when the client did (groq)', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.test.com/v1',
    });
    const cap = captureBody(jsonResponse);
    await provider.chatCompletion('sk-test', messages, 'llama-3.3-70b');
    expect(cap.body().max_tokens).toBeUndefined();
  });

  it('still forwards a client-supplied max_tokens (groq)', async () => {
    const provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.test.com/v1',
    });
    const cap = captureBody(jsonResponse);
    await provider.chatCompletion('sk-test', messages, 'llama-3.3-70b', { max_tokens: 77 });
    expect(cap.body().max_tokens).toBe(77);
  });
});
