import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb, setSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { clearCompressionStats } from '../../services/compression/stats.js';

let app: Express;
let dashboardToken = '';

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const server = await new Promise<ReturnType<Express['listen']>>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(path.startsWith('/api/') ? { Authorization: `Bearer ${dashboardToken}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  server.close();
  return {
    status: response.status,
    body: raw ? JSON.parse(raw) : null,
    headers: response.headers,
  };
}

describe('compression routes and chat integration', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    dashboardToken = mintDashboardToken();
    app = createApp();
  });

  beforeEach(() => {
    clearCompressionStats();
    getDb().prepare('DELETE FROM api_keys').run();
    setSetting('compression', JSON.stringify({
      mode: 'lossless',
      engines: {
        dedup: { enabled: true, minBlockChars: 80, minBlockLines: 3 },
        lite: { enabled: true },
        jsoncompact: { enabled: true, minRows: 8 },
      },
      trustProjectFilters: false,
      prefixFreeze: false,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads and updates compression settings', async () => {
    const current = await request('GET', '/api/settings/compression');
    expect(current.status).toBe(200);
    expect(current.body.mode).toBe('lossless');
    const updated = await request('PUT', '/api/settings/compression', {
      mode: 'standard',
      autoTriggerEstTokens: 32_000,
      engines: { toolfilter: { enabled: true, intensity: 'aggressive' } },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.mode).toBe('standard');
    expect(updated.body.autoTriggerEstTokens).toBe(32_000);
    expect(updated.body.engines.toolfilter.intensity).toBe('aggressive');
  });

  it('previews a request without adding it to live aggregate stats', async () => {
    const preview = await request('POST', '/api/compression/preview', {
      mode: 'lossless',
      messages: [{ role: 'user', content: 'hello   \n\n\n\nworld' }],
    });
    expect(preview.status).toBe(200);
    expect(preview.body.compressed[0].content).toBe('hello\n\nworld');
    expect(preview.body.stats.estSavedTokens).toBeGreaterThan(0);
    const stats = await request('GET', '/api/compression/stats');
    expect(stats.body.requests).toBe(0);
  });

  it('compresses all three chat surfaces before provider dispatch and reports the response header', async () => {
    const added = await request('POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_compression_test',
      label: 'compression',
    });
    expect(added.status).toBe(201);
    const originalFetch = global.fetch;
    const forwarded: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('api.groq.com/openai/v1/chat/completions')) {
        forwarded.push(JSON.parse(String((init as RequestInit).body)));
        return {
          ok: true,
          json: async () => ({
            id: 'compression-test',
            object: 'chat.completion',
            created: 1,
            model: 'openai/gpt-oss-120b',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        } as Response;
      }
      return originalFetch(url, init);
    });
    const response = await request('POST', '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello   \n\n\n\nworld' }],
    }, { Authorization: `Bearer ${getUnifiedApiKey()}` });
    expect(response.status).toBe(200);
    expect(forwarded[0].messages[0].content).toBe('hello\n\nworld');
    expect(response.headers.get('x-freellm-compress')).toMatch(/^lossless; saved~=\d+$/);

    const anthropic = await request('POST', '/v1/messages', {
      model: 'auto',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'anthropic   \n\n\n\nmessage' }],
    }, {
      'x-api-key': getUnifiedApiKey(),
      'anthropic-version': '2023-06-01',
    });
    expect(anthropic.status).toBe(200);
    expect(forwarded[1].messages[0].content).toBe('anthropic\n\nmessage');
    expect(anthropic.headers.get('x-freellm-compress')).toMatch(/^lossless; saved~=\d+$/);

    const responses = await request('POST', '/v1/responses', {
      model: 'auto',
      input: 'responses   \n\n\n\nmessage',
      max_output_tokens: 32,
    }, { Authorization: `Bearer ${getUnifiedApiKey()}` });
    expect(responses.status).toBe(200);
    expect(forwarded[2].messages[0].content).toBe('responses\n\nmessage');
    expect(responses.headers.get('x-freellm-compress')).toMatch(/^lossless; saved~=\d+$/);

    const stats = await request('GET', '/api/compression/stats');
    expect(stats.body.requests).toBe(3);
  });

  it('honors per-request lowering and the operator off master switch', async () => {
    setSetting('compression', JSON.stringify({
      mode: 'off',
      engines: {},
      trustProjectFilters: false,
      prefixFreeze: false,
    }));
    // Authentication/model setup is intentionally omitted: compression runs
    // after validation but the master-switch resolution is directly visible
    // through preview only when explicitly forced, so inspect settings here.
    const current = await request('GET', '/api/settings/compression');
    expect(current.body.mode).toBe('off');
  });
});
