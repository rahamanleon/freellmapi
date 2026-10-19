import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { EMBEDDING_PLATFORMS, runEmbeddings } from '../../services/embeddings.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const model = 'qwen3-embedding-8b';
const json = (body: unknown) => new Response(JSON.stringify(body));
function seed() {
  const db = getDb(), secret = encrypt('auray-test-key');
  db.prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('auray','test',?,?,?,'healthy',1)").run(secret.encrypted, secret.iv, secret.authTag);
  const result = applyCatalog(db, { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', models: [], quirks: [],
    embeddings: [{ platform: 'auray', modelId: model, family: 'auray-test', displayName: model, dimensions: 4096, maxInputTokens: 40960, priority: 1, enabled: true, quotaLabel: '50 monthly credits shared' }] });
  expect(result.skippedUnknownPlatform).toBe(0);
}

describe('Auray catalog-managed embeddings', () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
  afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

  it('routes ordered fixed-width vectors with a cold-start timeout and usage', async () => {
    seed();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ model, data: [{ index: 1, embedding: Array(4096).fill(0.2) }, { index: 0, embedding: Array(4096).fill(0.1) }], usage: { prompt_tokens: 6 } }));
    const result = await runEmbeddings('auray-test', ['first', 'second']);
    expect(EMBEDDING_PLATFORMS.has('auray')).toBe(true);
    expect(timeout).toHaveBeenCalledWith(180_000);
    expect(fetch.mock.calls[0][0]).toBe('https://api.auray.ai/openai/v1/embeddings');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer auray-test-key');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, input: ['first', 'second'] });
    expect(result).toMatchObject({ platform: 'auray', modelId: model, dimensions: 4096, inputTokens: 6 });
    expect(result.vectors.map(v => v[0])).toEqual([0.1, 0.2]);
  });

  it.each([
    { model: 'other', data: [{ index: 0, embedding: Array(4096).fill(0.1) }] },
    { model, data: [] },
    { model, data: [{ index: 0, embedding: [0.1] }] },
    { model, data: [{ index: 0, embedding: Array(4096).fill(null) }] },
    { model, data: [{ index: 1, embedding: Array(4096).fill(0.1) }] },
    { error: { code: 'insufficient_credits' } },
  ])('rejects invalid model identity, vector dimensions or values', async body => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runEmbeddings('auray-test', ['hello'])).rejects.toMatchObject({ status: 502 });
  });

  it('does not send an unsupported dimension override', async () => {
    seed(); const fetch = vi.spyOn(global, 'fetch');
    await expect(runEmbeddings('auray-test', ['hello'], 1024)).rejects.toThrow('dimension override');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves rate-limit retry hints', async () => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429, headers: { 'Retry-After': '45' } }));
    await expect(runEmbeddings('auray-test', ['hello'])).rejects.toMatchObject({ status: 429, retryAfterMs: 45_000 });
  });

  it('does not seed new models before the signed catalog arrives', () => {
    for (const table of ['models', 'embedding_models']) expect(getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE platform='auray'`).get()).toEqual({ n: 0 });
  });
});
