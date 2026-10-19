import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { MAX_MESSAGES_BYTES } from '../../routes/conversations.js';

// Playground conversation storage: the sidebar's list/load/save/delete surface.
// Same in-memory DB + minted dashboard session as the other admin route suites.

async function request(
  app: Express,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

const USER_TURN = { role: 'user', content: 'hi' };
const ASSISTANT_TURN = {
  role: 'assistant',
  content: 'hello',
  reasoning: 'thinking about it',
  meta: {
    platform: 'groq',
    model: 'llama-3.3-70b',
    latency: 812,
    fallbackAttempts: 1,
    fusionPanel: [{ platform: 'groq', model: 'a', status: 'ok', content: 'A' }],
    fusionJudge: { platform: 'cerebras', model: 'j' },
    webSearch: { engine: 'tavily-search', latency: 420, sources: [{ title: 'T', url: 'https://t' }] },
  },
};

describe('playground conversations', () => {
  let app: Express;
  let dashToken: string;
  let unifiedKey: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    unifiedKey = getUnifiedApiKey();
    dashToken = mintDashboardToken('conversations@example.com');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM playground_conversations').run();
  });

  async function create(body: unknown = {}) {
    const res = await request(app, 'POST', '/api/conversations', { token: dashToken, body });
    expect(res.status).toBe(201);
    return res.body;
  }

  describe('CRUD', () => {
    it('creates an empty conversation and hands back its id', async () => {
      const created = await create();
      expect(created.id).toBeGreaterThan(0);
      expect(created.title).toBe('');
      expect(created.messages).toEqual([]);
      expect(created.model).toBeNull();
      expect(created.systemPrompt).toBeNull();
      expect(created.createdAt).toBeGreaterThan(0);
      expect(created.updatedAt).toBe(created.createdAt);
    });

    it('creates a conversation with its opening state in one call', async () => {
      const created = await create({
        title: 'First question',
        messages: [USER_TURN],
        model: 'fusion',
        systemPrompt: 'be terse',
      });
      const fetched = await request(app, 'GET', `/api/conversations/${created.id}`, { token: dashToken });
      expect(fetched.status).toBe(200);
      expect(fetched.body).toMatchObject({
        title: 'First question',
        model: 'fusion',
        systemPrompt: 'be terse',
      });
      expect(fetched.body.messages).toEqual([USER_TURN]);
    });

    it('round-trips routing meta, reasoning and images verbatim', async () => {
      const messages = [
        { ...USER_TURN, images: ['data:image/png;base64,AAAA'] },
        ASSISTANT_TURN,
        { role: 'assistant', content: 'boom', isError: true },
      ];
      const created = await create({ messages });
      const fetched = await request(app, 'GET', `/api/conversations/${created.id}`, { token: dashToken });
      expect(fetched.body.messages).toEqual(messages);
    });

    it('drops the transient streaming flag — a stored message is finished', async () => {
      const created = await create({ messages: [{ role: 'assistant', content: 'half', streaming: true }] });
      expect(created.messages[0]).toEqual({ role: 'assistant', content: 'half' });
    });

    it('lists summaries without message bodies, newest first', async () => {
      const older = await create({ title: 'older', messages: [USER_TURN] });
      const newer = await create({ title: 'newer', messages: [USER_TURN, ASSISTANT_TURN] });
      // Same-millisecond creates are entirely possible in-memory; the id
      // tiebreaker is what makes the order deterministic.
      const list = await request(app, 'GET', '/api/conversations', { token: dashToken });

      expect(list.status).toBe(200);
      expect(list.body.map((c: any) => c.id)).toEqual([newer.id, older.id]);
      expect(list.body[0]).toMatchObject({ title: 'newer', messageCount: 2 });
      expect(list.body[1]).toMatchObject({ title: 'older', messageCount: 1 });
      // No transcript crosses the wire on the list endpoint.
      expect(JSON.stringify(list.body)).not.toContain('hello');
      for (const summary of list.body) expect(summary.messages).toBeUndefined();
    });

    it('a PUT replaces the transcript and bumps updatedAt', async () => {
      const created = await create({ title: 'draft', messages: [USER_TURN] });
      const saved = await request(app, 'PUT', `/api/conversations/${created.id}`, {
        token: dashToken,
        body: { title: 'answered', messages: [USER_TURN, ASSISTANT_TURN], model: 'auto', systemPrompt: 'be terse' },
      });

      expect(saved.status).toBe(200);
      expect(saved.body.title).toBe('answered');
      expect(saved.body.messages).toHaveLength(2);
      expect(saved.body.model).toBe('auto');
      expect(saved.body.systemPrompt).toBe('be terse');
      expect(saved.body.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
      // createdAt is immutable — it orders nothing, but it dates the row.
      expect(saved.body.createdAt).toBe(created.createdAt);
    });

    it('a PUT that omits a field leaves it untouched (rename does not resend the transcript)', async () => {
      const created = await create({ messages: [USER_TURN, ASSISTANT_TURN], model: 'auto', systemPrompt: 'sp' });
      const renamed = await request(app, 'PUT', `/api/conversations/${created.id}`, {
        token: dashToken, body: { title: 'My chat' },
      });

      expect(renamed.status).toBe(200);
      expect(renamed.body.title).toBe('My chat');
      expect(renamed.body.messages).toHaveLength(2);
      expect(renamed.body.model).toBe('auto');
      expect(renamed.body.systemPrompt).toBe('sp');
    });

    it('null clears the model and system prompt', async () => {
      const created = await create({ model: 'auto', systemPrompt: 'sp' });
      const cleared = await request(app, 'PUT', `/api/conversations/${created.id}`, {
        token: dashToken, body: { model: null, systemPrompt: null },
      });
      expect(cleared.body.model).toBeNull();
      expect(cleared.body.systemPrompt).toBeNull();
    });

    it('deletes a conversation and 404s afterwards', async () => {
      const created = await create({ messages: [USER_TURN] });
      const del = await request(app, 'DELETE', `/api/conversations/${created.id}`, { token: dashToken });
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ success: true });

      expect((await request(app, 'GET', `/api/conversations/${created.id}`, { token: dashToken })).status).toBe(404);
      expect((await request(app, 'DELETE', `/api/conversations/${created.id}`, { token: dashToken })).status).toBe(404);
      expect((await request(app, 'PUT', `/api/conversations/${created.id}`, {
        token: dashToken, body: { title: 'gone' },
      })).status).toBe(404);
    });
  });

  describe('validation', () => {
    it('rejects a non-numeric id with 400, not 404', async () => {
      const { status } = await request(app, 'GET', '/api/conversations/not-an-id', { token: dashToken });
      expect(status).toBe(400);
    });

    it('rejects a malformed transcript', async () => {
      for (const messages of [
        [{ role: 'system', content: 'nope' }],
        [{ role: 'user' }],
        [{ role: 'user', content: 42 }],
        'not-an-array',
      ]) {
        const { status } = await request(app, 'POST', '/api/conversations', {
          token: dashToken, body: { messages },
        });
        expect(status, JSON.stringify(messages)).toBe(400);
      }
    });

    it('rejects unknown top-level fields', async () => {
      const { status } = await request(app, 'POST', '/api/conversations', {
        token: dashToken, body: { nope: true },
      });
      expect(status).toBe(400);
    });

    it('413s an oversized transcript with a clear error instead of truncating', async () => {
      const messages = [{ role: 'user', content: 'x'.repeat(MAX_MESSAGES_BYTES + 1024) }];
      const created = await create({ messages: [USER_TURN] });

      const post = await request(app, 'POST', '/api/conversations', { token: dashToken, body: { messages } });
      expect(post.status).toBe(413);
      expect(post.body.error.type).toBe('conversation_too_large');
      expect(post.body.error.message).toMatch(/too large/i);

      const put = await request(app, 'PUT', `/api/conversations/${created.id}`, { token: dashToken, body: { messages } });
      expect(put.status).toBe(413);

      // The refused write left the stored conversation exactly as it was.
      const fetched = await request(app, 'GET', `/api/conversations/${created.id}`, { token: dashToken });
      expect(fetched.body.messages).toEqual([USER_TURN]);
    });

    it('accepts a transcript just under the cap', async () => {
      // JSON overhead around the one message is ~40 bytes; stay clear of it.
      const messages = [{ role: 'user', content: 'x'.repeat(MAX_MESSAGES_BYTES - 1024) }];
      const { status } = await request(app, 'POST', '/api/conversations', { token: dashToken, body: { messages } });
      expect(status).toBe(201);
    });
  });

  describe('auth', () => {
    it('requires a dashboard session on every method', async () => {
      const created = await create();
      for (const [method, path, body] of [
        ['GET', '/api/conversations', undefined],
        ['GET', `/api/conversations/${created.id}`, undefined],
        ['POST', '/api/conversations', {}],
        ['PUT', `/api/conversations/${created.id}`, { title: 'x' }],
        ['DELETE', `/api/conversations/${created.id}`, undefined],
      ] as const) {
        const { status } = await request(app, method, path, { body });
        expect(status, `${method} ${path} unauthenticated`).toBe(401);
      }
      // Still there: none of the unauthenticated calls took effect.
      expect((await request(app, 'GET', `/api/conversations/${created.id}`, { token: dashToken })).status).toBe(200);
    });

    it('the unified /v1 key does not open the conversations API', async () => {
      const { status } = await request(app, 'GET', '/api/conversations', { token: unifiedKey });
      expect(status).toBe(401);
    });
  });
});
