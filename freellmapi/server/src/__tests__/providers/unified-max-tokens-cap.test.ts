import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, setSetting } from '../../db/index.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { CloudflareProvider } from '../../providers/cloudflare.js';
import { CohereProvider } from '../../providers/cohere.js';
import { GoogleProvider } from '../../providers/google.js';
import { AIHordeProvider } from '../../providers/aihorde.js';
import {
  defaultMaxTokensFor,
  UNIFIED_MAX_TOKENS_SETTING,
  UNIFIED_MAX_TOKENS_AUTO,
} from '../../lib/sampling-params.js';

// The cap is only "unified" if EVERY adapter puts max_tokens on the wire
// through resolveMaxTokens(). These tests drive the real settings row and read
// the real outgoing request body for each adapter, so an adapter that goes back
// to reading options.max_tokens directly fails here.

const MESSAGES = [{ role: 'user' as const, content: 'Hi' }];
const CLIENT_ASKED = 65536; // Open WebUI's default

function openAiJsonResponse(): any {
  return {
    ok: true,
    status: 200,
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

function geminiJsonResponse(): any {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }),
    headers: new Headers(),
  };
}

function hordeJsonResponse(): any {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({
      id: 'horde-1',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { kudos: 2 },
    }),
    headers: new Headers(),
  };
}

/** Spy on fetch and hand back the parsed outgoing body. */
function captureBody(response: () => any): { body: () => any } {
  let captured: any = null;
  vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    captured = JSON.parse((init as any).body);
    return response() as any;
  });
  return { body: () => captured };
}

/** One entry per adapter: fire a chat completion and report the max_tokens it
 *  actually put on the wire. */
const ADAPTERS: Array<{
  name: string;
  send: (options?: Record<string, unknown>) => Promise<number | undefined>;
}> = [
  {
    name: 'openai-compat (groq)',
    send: async (options) => {
      const cap = captureBody(openAiJsonResponse);
      const p = new OpenAICompatProvider({ platform: 'groq', name: 'Groq', baseUrl: 'https://api.test.com/v1' });
      await p.chatCompletion('sk-test', MESSAGES, 'llama-3.3-70b', options as any);
      return cap.body().max_tokens;
    },
  },
  {
    name: 'cloudflare',
    send: async (options) => {
      const cap = captureBody(openAiJsonResponse);
      await new CloudflareProvider().chatCompletion('acct:token', MESSAGES, '@cf/openai/gpt-oss-120b', options as any);
      return cap.body().max_tokens;
    },
  },
  {
    name: 'cohere',
    send: async (options) => {
      const cap = captureBody(openAiJsonResponse);
      await new CohereProvider().chatCompletion('test-key', MESSAGES, 'command-a-03-2025', options as any);
      return cap.body().max_tokens;
    },
  },
  {
    name: 'google',
    send: async (options) => {
      const cap = captureBody(geminiJsonResponse);
      await new GoogleProvider().chatCompletion('test-key', MESSAGES, 'gemini-2.5-flash', options as any);
      return cap.body().generationConfig?.maxOutputTokens;
    },
  },
  {
    name: 'aihorde',
    send: async (options) => {
      const cap = captureBody(hordeJsonResponse);
      await new AIHordeProvider().chatCompletion('no-key', MESSAGES, 'm', options as any);
      return cap.body().max_tokens;
    },
  },
];

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  setSetting(UNIFIED_MAX_TOKENS_SETTING, 'off');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the unified cap reaches every adapter', () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.name} clamps an excessive client max_tokens`, async () => {
      setSetting(UNIFIED_MAX_TOKENS_SETTING, 'auto');
      expect(await adapter.send({ max_tokens: CLIENT_ASKED })).toBe(UNIFIED_MAX_TOKENS_AUTO);
    });

    it(`${adapter.name} honors an explicit integer cap`, async () => {
      setSetting(UNIFIED_MAX_TOKENS_SETTING, '4096');
      expect(await adapter.send({ max_tokens: CLIENT_ASKED })).toBe(4096);
    });

    it(`${adapter.name} leaves a value below the cap alone`, async () => {
      setSetting(UNIFIED_MAX_TOKENS_SETTING, '4096');
      expect(await adapter.send({ max_tokens: 512 })).toBe(512);
    });

    it(`${adapter.name} forwards the client value verbatim with the cap off`, async () => {
      expect(await adapter.send({ max_tokens: CLIENT_ASKED })).toBe(CLIENT_ASKED);
    });
  }
});

describe('the cap applies to values the client never sent', () => {
  it("clamps cloudflare's platform default (#553) when the cap is lower", async () => {
    const cfDefault = defaultMaxTokensFor('cloudflare')!;
    setSetting(UNIFIED_MAX_TOKENS_SETTING, String(cfDefault - 1));
    const cap = captureBody(openAiJsonResponse);
    await new CloudflareProvider().chatCompletion('acct:token', MESSAGES, '@cf/openai/gpt-oss-120b');
    expect(cap.body().max_tokens).toBe(cfDefault - 1);
  });

  it("clamps aihorde's own default", async () => {
    setSetting(UNIFIED_MAX_TOKENS_SETTING, '64');
    const cap = captureBody(hordeJsonResponse);
    await new AIHordeProvider().chatCompletion('no-key', MESSAGES, 'm');
    expect(cap.body().max_tokens).toBe(64);
  });

  it("never drops aihorde below the proxy's 16-token floor", async () => {
    setSetting(UNIFIED_MAX_TOKENS_SETTING, '4');
    const cap = captureBody(hordeJsonResponse);
    await new AIHordeProvider().chatCompletion('no-key', MESSAGES, 'm', { max_tokens: 1000 });
    expect(cap.body().max_tokens).toBe(16);
  });

  it('still omits max_tokens for a platform with no default', async () => {
    setSetting(UNIFIED_MAX_TOKENS_SETTING, 'auto');
    const cap = captureBody(openAiJsonResponse);
    const p = new OpenAICompatProvider({ platform: 'groq', name: 'Groq', baseUrl: 'https://api.test.com/v1' });
    await p.chatCompletion('sk-test', MESSAGES, 'llama-3.3-70b');
    expect(cap.body().max_tokens).toBeUndefined();
  });
});
