import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// Two defects on the streaming tool-call rescue path, both fixed together
// because they are the same block of code:
//
// 1. The rescue ran on turns that declared NO tools. Every non-streaming path
//    (proxy.ts, anthropic.ts, responses.ts) and the shared inbound-chat lane
//    already gated on `wantsTools`, and openai-compat's failed-generation
//    rescue guards `toolNames.size === 0` explicitly — the three STREAMING
//    paths did not. An ordinary answer that happened to contain `<function=…>`
//    was stripped out of the prose and re-emitted as a fabricated tool_calls
//    entry the client never asked for and cannot interpret.
//
// 2. The opt-in schema verdict ran BEFORE the rescue appended its calls, so
//    the calls reconstructed from prose — the ones most likely to be malformed
//    — were the only ones the validator never saw.
//
// Same scripted-provider mock pattern as tool-validate-surfaces.test.ts.
const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');

async function post(app: Express, path: string, body: any, headers: Record<string, string>) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* SSE, or an error page */ }
  return { status: res.status, body: json, raw };
}

/** Collect the concatenated `content` and any tool_calls out of an SSE body. */
function readStream(raw: string): { content: string; toolCalls: any[] } {
  let content = '';
  const toolCalls: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    let chunk: any;
    try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string') content += delta.content;
    if (delta.tool_calls) toolCalls.push(...delta.tool_calls);
  }
  return { content, toolCalls };
}

/** A model that answers in prose containing a function-tag dialect fragment. */
function streamTextTurn(text: string) {
  return async function* () {
    yield { choices: [{ delta: { content: text } }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  };
}

const PARAMS = {
  type: 'object',
  properties: { command: { type: 'string' } },
  required: ['command'],
};
const BASH_TOOL = { type: 'function', function: { name: 'Bash', parameters: PARAMS } };

// A complete, parseable dialect call. With tools declared it is a legitimate
// rescue; with none declared it must stay prose.
const DIALECT = '<function=Bash{"command":"ls"}</function>';
// Parseable as a call, but the arguments violate the declared schema
// (`command` is required and absent).
const DIALECT_INVALID = '<function=Bash{"nope":"ls"}</function>';

describe('streaming tool-call rescue respects whether the request wanted tools', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    delete process.env.VALIDATE_TOOL_ARGUMENTS;
  });

  afterEach(() => {
    delete process.env.VALIDATE_TOOL_ARGUMENTS;
  });

  const bearer = () => ({ Authorization: `Bearer ${key}` });

  describe('no tools declared', () => {
    it('delivers dialect-looking prose as content instead of fabricating a tool call', async () => {
      streamChatCompletion.mockImplementation(streamTextTurn(DIALECT));

      const { status, raw } = await post(app, '/v1/chat/completions', {
        model: 'auto', stream: true, messages: [{ role: 'user', content: 'how do I list files?' }],
      }, bearer());

      expect(status).toBe(200);
      const { content, toolCalls } = readStream(raw);
      expect(toolCalls).toEqual([]);
      expect(content).toContain('<function=Bash');
    });

    it('does not kill the turn when the dialect is unparseable', async () => {
      // An opaque id leaves no way to know which tool was meant, so WITH tools
      // this is a dead turn that fails over. With none, it is just prose.
      const opaque = '<|tool_call_begin|>chatcmpl-tool-abc<|tool_call_argument_begin|>{"a":1}<|tool_call_end|>';
      streamChatCompletion.mockImplementation(streamTextTurn(opaque));

      const { status, raw } = await post(app, '/v1/chat/completions', {
        model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }],
      }, bearer());

      expect(status).toBe(200);
      const { content, toolCalls } = readStream(raw);
      expect(toolCalls).toEqual([]);
      expect(content).toContain('<|tool_call_begin|>');
    });
  });

  describe('tools declared', () => {
    it('still rescues the same text into a structured tool call', async () => {
      streamChatCompletion.mockImplementation(streamTextTurn(DIALECT));

      const { status, raw } = await post(app, '/v1/chat/completions', {
        model: 'auto', stream: true, tools: [BASH_TOOL],
        messages: [{ role: 'user', content: 'list files' }],
      }, bearer());

      expect(status).toBe(200);
      const { toolCalls } = readStream(raw);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].function.name).toBe('Bash');
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ command: 'ls' });
    });

    it('delivers a schema-invalid rescued call while validation is off', async () => {
      streamChatCompletion.mockImplementation(streamTextTurn(DIALECT_INVALID));

      const { status, raw } = await post(app, '/v1/chat/completions', {
        model: 'auto', stream: true, tools: [BASH_TOOL],
        messages: [{ role: 'user', content: 'list files' }],
      }, bearer());

      expect(status).toBe(200);
      const { toolCalls } = readStream(raw);
      expect(toolCalls).toHaveLength(1);
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ nope: 'ls' });
    });

    // The ordering half: the verdict is taken after the rescue, so a rescued
    // call gets the same scrutiny as one the provider emitted structurally.
    // Running first exempted precisely the reconstructed calls.
    it('fails a schema-invalid RESCUED call over when validation is on', async () => {
      process.env.VALIDATE_TOOL_ARGUMENTS = '1';
      streamChatCompletion.mockImplementation(streamTextTurn(DIALECT_INVALID));

      const { status } = await post(app, '/v1/chat/completions', {
        model: 'auto', stream: true, tools: [BASH_TOOL],
        messages: [{ role: 'user', content: 'list files' }],
      }, bearer());

      // Every candidate answers the same way, so the ladder exhausts rather
      // than delivering arguments the tool cannot accept.
      expect(status).toBeGreaterThanOrEqual(400);
    });
  });
});
