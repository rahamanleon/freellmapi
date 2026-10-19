import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { encrypt } from '../../lib/crypto.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  server.close();
  let json: any;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, body: json, headers: response.headers };
}

function seedGroq(): void {
  const key = encrypt('gsk_gemini_surface_test');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'gemini-test', ?, ?, ?, 'healthy', 1)
  `).run(key.encrypted, key.iv, key.authTag);
}

const completion = {
  id: 'chatcmpl-gemini',
  object: 'chat.completion',
  created: 1,
  model: 'openai/gpt-oss-120b',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'hello from Gemini wire' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
};

describe('native Gemini /v1beta surface', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM rate_limit_usage').run();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    seedGroq();
  });

  afterEach(() => vi.restoreAllMocks());

  it('lists Gemini-shaped models with x-goog-api-key auth', async () => {
    const response = await request(app, 'GET', '/v1beta/models', undefined, {
      'x-goog-api-key': getUnifiedApiKey(),
    });
    expect(response.status).toBe(200);
    expect(response.body.models[0]).toMatchObject({
      name: 'models/auto',
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
    });
    expect(response.body.models.some((model: any) => model.name.startsWith('models/'))).toBe(true);

    const single = await request(app, 'GET', '/v1beta/models/auto', undefined, {
      'x-goog-api-key': getUnifiedApiKey(),
    });
    expect(single.status).toBe(200);
    expect(single.body.name).toBe('models/auto');
  });

  it('translates generateContent and structured tools through the shared router', async () => {
    let upstreamBody: any;
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        upstreamBody = JSON.parse(String(init?.body));
        return {
          ok: true,
          headers: new Headers(),
          json: async () => completion,
        } as any;
      }
      return originalFetch(url, init);
    });

    const response = await request(
      app,
      'POST',
      `/v1beta/models/gemini-2.5-flash:generateContent?key=${getUnifiedApiKey()}`,
      {
        systemInstruction: { parts: [{ text: 'Be concise' }] },
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        tools: [{
          functionDeclarations: [{
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          }],
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 64 },
      },
    );

    expect(response.status).toBe(200);
    expect(upstreamBody.messages[0]).toEqual({ role: 'system', content: 'Be concise' });
    expect(upstreamBody.tools[0].function.name).toBe('read_file');
    expect(response.body.candidates[0].content.parts).toEqual([{ text: 'hello from Gemini wire' }]);
    expect(response.body.usageMetadata.totalTokenCount).toBe(11);
    expect(response.headers.get('x-routed-via')).toContain('groq/');
  });

  it('returns native Gemini function calls for a tool-using turn', async () => {
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({
            ...completion,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_read',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"README.md"}' },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          }),
        } as any;
      }
      return originalFetch(url, init);
    });

    const response = await request(
      app,
      'POST',
      '/v1beta/models/gemini-2.5-flash:generateContent',
      {
        contents: [{ role: 'user', parts: [{ text: 'Read the README' }] }],
        tools: [{
          functionDeclarations: [{
            name: 'read_file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          }],
        }],
      },
      { 'x-goog-api-key': getUnifiedApiKey() },
    );

    expect(response.status).toBe(200);
    expect(response.body.candidates[0].content.parts).toEqual([{
      functionCall: {
        id: 'call_read',
        name: 'read_file',
        args: { path: 'README.md' },
      },
    }]);
    expect(response.body.candidates[0].finishReason).toBe('STOP');
  });

  it('streams SSE for Gemini CLI and exposes countTokens', async () => {
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        return new Response(
          'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n'
          + 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n'
          + 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
          + 'data: [DONE]\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return originalFetch(url, init);
    });
    const body = { contents: [{ role: 'user', parts: [{ text: 'hello world' }] }] };
    const stream = await request(
      app,
      'POST',
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      body,
      { 'x-goog-api-key': getUnifiedApiKey() },
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.text).toContain('"text":"hel"');
    expect(stream.text).toContain('"finishReason":"STOP"');

    const jsonStream = await request(
      app,
      'POST',
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
      body,
      { 'x-goog-api-key': getUnifiedApiKey() },
    );
    expect(jsonStream.status).toBe(200);
    expect(jsonStream.headers.get('content-type')).toContain('application/json');
    expect(Array.isArray(jsonStream.body)).toBe(true);
    expect(jsonStream.body.at(-1).candidates[0].finishReason).toBe('STOP');

    const count = await request(
      app,
      'POST',
      '/v1beta/models/gemini-2.5-flash:countTokens',
      body,
      { 'x-goog-api-key': getUnifiedApiKey() },
    );
    expect(count.status).toBe(200);
    expect(count.body.totalTokens).toBeGreaterThan(0);
  });
});
