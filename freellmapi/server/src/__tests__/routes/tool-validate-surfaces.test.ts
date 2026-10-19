import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// Follow-up to the opt-in tool-argument schema verdict: it shipped wired at
// /v1/chat/completions (both paths) and Anthropic non-streaming only. These
// tests pin the remaining surfaces — /v1/responses non-streaming, the Anthropic
// stream, and the shared inbound-chat lane behind the Gemini/Ollama emulations —
// plus the one surface that deliberately stays unwired, so the gap is a pinned
// decision rather than something to rediscover.
//
// Same scripted-provider mock pattern as responses-tool-args-repair.test.ts.
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

// `path` is required and absent. Nothing tool-args can repair — the value is
// not a mis-encoded anything, it is simply not the argument the tool declared.
const INVALID_ARGS = JSON.stringify({ nope: 'README.md' });
const VALID_ARGS = JSON.stringify({ path: 'README.md' });

const PARAMS = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
};

const RESPONSES_TOOL = { type: 'function', name: 'read_file', parameters: PARAMS };
const ANTHROPIC_TOOL = { name: 'read_file', input_schema: PARAMS };
const GEMINI_TOOL = { functionDeclarations: [{ name: 'read_file', parameters: PARAMS }] };

function nonStreamToolTurn(args: string) {
  return {
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: args } }] },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

function streamToolTurn(args: string) {
  return async function* () {
    yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: args } }] } }] };
    yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
  };
}

describe('tool-argument schema verdict — remaining surfaces', () => {
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

  describe('/v1/responses, non-streaming', () => {
    it('delivers a schema-invalid call untouched while validation is off', async () => {
      chatCompletion.mockResolvedValue(nonStreamToolTurn(INVALID_ARGS));

      const { status, body } = await post(app, '/v1/responses', {
        input: 'read the readme', tools: [RESPONSES_TOOL],
      }, bearer());

      expect(status).toBe(200);
      const fc = body.output.find((o: any) => o.type === 'function_call');
      expect(JSON.parse(fc.arguments)).toEqual({ nope: 'README.md' });
    });

    it('fails the turn over instead of delivering it when validation is on', async () => {
      process.env.VALIDATE_TOOL_ARGUMENTS = '1';
      chatCompletion.mockResolvedValue(nonStreamToolTurn(INVALID_ARGS));

      const { status, body } = await post(app, '/v1/responses', {
        input: 'read the readme', tools: [RESPONSES_TOOL],
      }, bearer());

      // Every candidate answers the same way, so the ladder exhausts rather
      // than handing the client a call it cannot use.
      expect(status).not.toBe(200);
      expect(body?.output).toBeUndefined();
      expect(chatCompletion).toHaveBeenCalled();
    });

    it('leaves a schema-valid call alone when validation is on', async () => {
      process.env.VALIDATE_TOOL_ARGUMENTS = '1';
      chatCompletion.mockResolvedValue(nonStreamToolTurn(VALID_ARGS));

      const { status, body } = await post(app, '/v1/responses', {
        input: 'read the readme', tools: [RESPONSES_TOOL],
      }, bearer());

      expect(status).toBe(200);
      const fc = body.output.find((o: any) => o.type === 'function_call');
      expect(JSON.parse(fc.arguments)).toEqual({ path: 'README.md' });
    });
  });

  describe('/v1/responses, streaming', () => {
    // Deliberately NOT wired — this route commits on the first tool-call delta,
    // long before the arguments are complete. A verdict could only turn a
    // delivered call into a response.failed on a stream the client is already
    // reading. Pinned so the asymmetry with the non-streaming path above reads
    // as a decision rather than an oversight.
    it('still delivers a schema-invalid call, because it has already committed', async () => {
      process.env.VALIDATE_TOOL_ARGUMENTS = '1';
      streamChatCompletion.mockImplementation(streamToolTurn(INVALID_ARGS));

      const { status, raw } = await post(app, '/v1/responses', {
        input: 'read the readme', stream: true, tools: [RESPONSES_TOOL],
      }, bearer());

      expect(status).toBe(200);
      expect(raw).toContain('response.function_call_arguments.done');
      expect(raw).toContain('nope');
    });
  });

  describe('/v1/messages, streaming', () => {
    it('fails a tool-only turn over before message_start when validation is on', async () => {
      process.env.VALIDATE_TOOL_ARGUMENTS = '1';
      streamChatCompletion.mockImplementation(streamToolTurn(INVALID_ARGS));

      const { raw } = await post(app, '/v1/messages', {
        model: 'auto', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'read the readme' }],
        tools: [ANTHROPIC_TOOL],
      }, { 'x-api-key': key });

      // Tool calls are buffered to the end of the stream here, so nothing was
      // committed: no tool_use block reaches the client.
      expect(raw).not.toContain('tool_use');
      expect(raw).not.toContain('nope');
    });

    it('delivers a schema-valid tool-only turn unchanged', async () => {
      process.env.VALIDATE_TOOL_ARGUMENTS = '1';
      streamChatCompletion.mockImplementation(streamToolTurn(VALID_ARGS));

      const { status, raw } = await post(app, '/v1/messages', {
        model: 'auto', max_tokens: 64, stream: true,
        messages: [{ role: 'user', content: 'read the readme' }],
        tools: [ANTHROPIC_TOOL],
      }, { 'x-api-key': key });

      expect(status).toBe(200);
      expect(raw).toContain('tool_use');
      expect(raw).toContain('README.md');
    });
  });

  describe('inbound-chat lane (native Gemini surface)', () => {
    it('non-stream: fails over instead of returning an invalid functionCall', async () => {
      process.env.VALIDATE_TOOL_ARGUMENTS = '1';
      chatCompletion.mockResolvedValue(nonStreamToolTurn(INVALID_ARGS));

      const { status, body } = await post(app, '/v1beta/models/gemini-2.5-flash:generateContent', {
        contents: [{ role: 'user', parts: [{ text: 'read the readme' }] }],
        tools: [GEMINI_TOOL],
      }, { 'x-goog-api-key': key });

      expect(status).not.toBe(200);
      expect(body?.candidates).toBeUndefined();
    });

    it('non-stream: delivers the same turn when validation is off', async () => {
      chatCompletion.mockResolvedValue(nonStreamToolTurn(INVALID_ARGS));

      const { status, body } = await post(app, '/v1beta/models/gemini-2.5-flash:generateContent', {
        contents: [{ role: 'user', parts: [{ text: 'read the readme' }] }],
        tools: [GEMINI_TOOL],
      }, { 'x-goog-api-key': key });

      expect(status).toBe(200);
      expect(body.candidates[0].content.parts[0].functionCall.args).toEqual({ nope: 'README.md' });
    });

    it('stream: a tool-only turn is buffered, so it can still fail over', async () => {
      process.env.VALIDATE_TOOL_ARGUMENTS = '1';
      streamChatCompletion.mockImplementation(streamToolTurn(INVALID_ARGS));

      const { raw } = await post(app, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', {
        contents: [{ role: 'user', parts: [{ text: 'read the readme' }] }],
        tools: [GEMINI_TOOL],
      }, { 'x-goog-api-key': key });

      expect(raw).not.toContain('functionCall');
      expect(raw).not.toContain('nope');
    });

    it('stream: a schema-valid tool-only turn is delivered unchanged', async () => {
      process.env.VALIDATE_TOOL_ARGUMENTS = '1';
      streamChatCompletion.mockImplementation(streamToolTurn(VALID_ARGS));

      const { status, raw } = await post(app, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', {
        contents: [{ role: 'user', parts: [{ text: 'read the readme' }] }],
        tools: [GEMINI_TOOL],
      }, { 'x-goog-api-key': key });

      expect(status).toBe(200);
      expect(raw).toContain('functionCall');
      expect(raw).toContain('README.md');
    });
  });
});
