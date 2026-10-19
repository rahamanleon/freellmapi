import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { resolveRoutingChain, setRoutingStrategy, getOrderedFusionChain } from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE / non-JSON */ }
  return { status: res.status, body: json, text };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

function activeProfileId(): number | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

function addKey(platform: string): void {
  const secret = encrypt(`${platform}-disabled-routing-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'disabled-routing', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

// A two-model catalog at fixed priorities: with the 'priority' strategy the
// routed model is fully deterministic, so "which model served" is a clean
// assertion. Unique model ids also make each model its own unify group, so an
// explicit request resolves to exactly one row.
function addModel(modelId: string, priority: number): number {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools
    )
    VALUES ('groq', ?, ?, ?, ?, 'Small', NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1)
  `).run(modelId, `Disabled Routing ${modelId}`, priority, priority);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  const profileId = activeProfileId();
  if (profileId != null) {
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
      .run(profileId, id, priority);
  }
  return id;
}

function mockUpstream() {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('api.groq.com')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({
          id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'default',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      } as any;
    }
    return origFetch(url, init);
  });
}

function lastServedModel(): string {
  const row = getDb().prepare('SELECT model_id FROM requests ORDER BY id DESC LIMIT 1').get() as { model_id: string } | undefined;
  return row?.model_id ?? '';
}

// A follow-up turn in the same conversation: an assistant message is what makes
// the sticky map readable at all (see getStickyModel).
const FOLLOW_UP = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'ok' },
  { role: 'user', content: 'again' },
];

let alphaId = 0;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  setRoutingStrategy('priority');
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM models').run();
  addKey('groq');
  alphaId = addModel('alpha-model', 1);
  addModel('beta-model', 2);
  mockUpstream();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// #634: a model the operator switched off must never be selected at request
// time, on any surface. Two flavors of "off" are covered here because they leak
// differently: catalog-off (models.enabled = 0) and auto-routing-off
// (fallback_config / profile_models .enabled = 0). Explicitly NAMING a model
// that is only auto-routing-off still works — that is the documented contract
// (see routing-semantics.test.ts) — but nothing may pick it implicitly.
describe('disabled models are never routed (#634)', () => {
  describe('sticky sessions', () => {
    // The sticky map holds a db id for 30 minutes, so it outlives a disable.
    // routeRequest treats an off-chain preferred id as an explicit pin and
    // injects it ahead of the chain — which resurrected the disabled model.
    it.each([
      ['catalog', { enabled: false }],
      ['chain', { fallbackEnabled: false }],
    ])('/v1/chat/completions falls through to auto when the pinned model is %s-disabled mid-session', async (_flavor, patch) => {
      const sessionId = `sess-chat-${_flavor}`;
      const first = await request('POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: 'hello' }],
      }, { ...authHeaders(), 'x-session-id': sessionId });
      expect(first.status).toBe(200);
      expect(lastServedModel()).toBe('alpha-model');

      expect((await request('PATCH', `/api/models/${alphaId}`, patch)).status).toBe(200);

      const second = await request('POST', '/v1/chat/completions', {
        messages: FOLLOW_UP,
      }, { ...authHeaders(), 'x-session-id': sessionId });
      expect(second.status).toBe(200);
      expect(lastServedModel()).toBe('beta-model');
    });

    it('/v1/responses falls through to auto when the pinned model is chain-disabled mid-session', async () => {
      const first = await request('POST', '/v1/responses', { input: 'hello' }, {
        ...authHeaders(), 'x-session-id': 'sess-responses',
      });
      expect(first.status).toBe(200);
      expect(lastServedModel()).toBe('alpha-model');

      expect((await request('PATCH', `/api/models/${alphaId}`, { fallbackEnabled: false })).status).toBe(200);

      const second = await request('POST', '/v1/responses', { input: FOLLOW_UP }, {
        ...authHeaders(), 'x-session-id': 'sess-responses',
      });
      expect(second.status).toBe(200);
      expect(lastServedModel()).toBe('beta-model');
    });

    it('/v1/messages falls through to auto when the pinned model is chain-disabled mid-session', async () => {
      const first = await request('POST', '/v1/messages', {
        model: 'claude-sonnet-4', max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
      }, { ...authHeaders(), 'x-session-id': 'sess-messages' });
      expect(first.status).toBe(200);
      expect(lastServedModel()).toBe('alpha-model');

      expect((await request('PATCH', `/api/models/${alphaId}`, { fallbackEnabled: false })).status).toBe(200);

      const second = await request('POST', '/v1/messages', {
        model: 'claude-sonnet-4', max_tokens: 64, messages: FOLLOW_UP,
      }, { ...authHeaders(), 'x-session-id': 'sess-messages' });
      expect(second.status).toBe(200);
      expect(lastServedModel()).toBe('beta-model');
    });
  });

  describe('auto chain building', () => {
    // 'auto:smart' & friends rank the whole catalog instead of following the
    // chain's ORDER. They must still drop what the operator switched off.
    it.each([['auto:smart'], ['auto:fast'], ['auto:cheap'], ['auto:reliable']])(
      '%s excludes a chain-disabled model', async (modelString) => {
        expect((await request('PATCH', `/api/models/${alphaId}`, { fallbackEnabled: false })).status).toBe(200);
        expect(resolveRoutingChain(modelString).chain.map(row => row.model_db_id)).not.toContain(alphaId);
      },
    );

    it('auto:smart still spans models that were never touched in the chain', async () => {
      const chain = resolveRoutingChain('auto:smart').chain.map(row => row.model_db_id);
      expect(chain).toContain(alphaId);
    });

    it('auto:smart excludes a catalog-disabled model', async () => {
      expect((await request('PATCH', `/api/models/${alphaId}`, { enabled: false })).status).toBe(200);
      expect(resolveRoutingChain('auto:smart').chain.map(row => row.model_db_id)).not.toContain(alphaId);
    });

    it('the default auto chain drops a model the moment it is disabled', async () => {
      expect((await request('PATCH', `/api/models/${alphaId}`, { enabled: false })).status).toBe(200);
      const { status } = await request('POST', '/v1/chat/completions', {
        model: 'auto', messages: [{ role: 'user', content: 'hi' }],
      }, authHeaders());
      expect(status).toBe(200);
      expect(lastServedModel()).toBe('beta-model');
    });
  });

  describe('fusion panels', () => {
    it('an auto panel drops a model disabled after the panel was last built', async () => {
      expect(getOrderedFusionChain(100).map(c => c.modelDbId)).toContain(alphaId);
      expect((await request('PATCH', `/api/models/${alphaId}`, { fallbackEnabled: false })).status).toBe(200);
      expect(getOrderedFusionChain(100).map(c => c.modelDbId)).not.toContain(alphaId);
    });

    it('an explicit panel drops a catalog-disabled member instead of dispatching it', async () => {
      expect((await request('PATCH', `/api/models/${alphaId}`, { enabled: false })).status).toBe(200);
      const { status, body } = await request('POST', '/v1/chat/completions', {
        model: 'fusion',
        messages: [{ role: 'user', content: 'hi' }],
        fusion: { models: ['alpha-model', 'beta-model'], expose_panel: true },
      }, authHeaders());
      expect(status).toBe(200);
      expect(body.x_fusion.panel.map((p: any) => p.model)).toEqual(['beta-model']);
      expect(body.x_fusion.dropped).toContain('alpha-model (unknown or disabled)');
    });
  });

  describe('explicit model requests', () => {
    it.each([
      ['/v1/chat/completions', { model: 'alpha-model', messages: [{ role: 'user', content: 'hi' }] }],
      ['/v1/completions', { model: 'alpha-model', prompt: 'hi' }],
    ])('%s returns model_not_found for a catalog-disabled model', async (path, body) => {
      expect((await request('PATCH', `/api/models/${alphaId}`, { enabled: false })).status).toBe(200);
      const res = await request('POST', path, body, authHeaders());
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('model_not_found');
    });
  });
});
