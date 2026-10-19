import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { resetServedModelObservations } from '../../lib/served-model.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Served-model drift guard (#534 follow-up): the proxy overwrites the
// upstream `model` field with the routed id before the caller sees it (the
// gateway contract — unchanged here). These tests assert the raw upstream
// value is captured BEFORE that overwrite, compared against the routed id,
// warn-logged once per tuple, and persisted to requests.served_model when it
// genuinely differs (NULL otherwise), on both the non-streaming and the
// streaming path.

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
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
  try { json = JSON.parse(text); } catch { /* SSE body */ }
  return { status: res.status, headers: res.headers, text, body: json };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

/** Parse an SSE response body into JSON frames (excluding [DONE]). */
function frames(text: string): any[] {
  return text.split('\n')
    .filter(l => l.startsWith('data: ') && l.trim() !== 'data: [DONE]')
    .map(l => JSON.parse(l.slice(6)));
}

const sse = (...payloads: (object | string)[]) =>
  payloads.map(p => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');

/** Mock the groq upstream. `upstreamModel` is what the provider CLAIMS it served. */
function mockUpstream(opts: { upstreamModel: string; stream?: boolean }) {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (!urlStr.includes('api.groq.com')) return origFetch(url as any, init as any);
    if (opts.stream) {
      const chunk = (delta: object, finish: string | null) => ({
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: opts.upstreamModel,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      return new Response(
        sse(chunk({ role: 'assistant' }, null), chunk({ content: 'streamed hello' }, null), chunk({}, 'stop'), '[DONE]'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-served', object: 'chat.completion', created: 1, model: opts.upstreamModel,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

function lastRequestRow(): any {
  return getDb().prepare(
    'SELECT id, model_id, served_model, status FROM requests ORDER BY id DESC LIMIT 1'
  ).get();
}

function servedModelWarns(): string[] {
  return vi.mocked(console.warn).mock.calls
    .map(c => String(c[0]))
    .filter(m => m.startsWith('[ServedModel]'));
}

describe('served-model drift guard (#534)', () => {
  let app: Express;
  let groqModelId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    groqModelId = (getDb().prepare(`
      SELECT m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.platform = 'groq' AND m.enabled = 1
      ORDER BY fc.priority LIMIT 1
    `).get() as { model_id: string }).model_id;
  });

  beforeEach(async () => {
    resetServedModelObservations();
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    const addKey = await request(app, 'POST', '/api/keys',
      { platform: 'groq', key: 'gsk_served_model_guard_test', label: 'served-model' });
    expect(addKey.status).toBe(201);
    vi.spyOn(console, 'warn');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('non-streaming: captures, logs, and persists a genuinely different served model — contract unchanged', async () => {
    mockUpstream({ upstreamModel: 'gemma-3-27b-it' });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: groqModelId, messages: [{ role: 'user', content: 'drift test' }],
    }, authHeaders());
    expect(status).toBe(200);
    // Contract unchanged: the caller still sees the ROUTED model.
    expect(body.model).toBe(groqModelId);

    const row = lastRequestRow();
    expect(row.status).toBe('success');
    expect(row.model_id).toBe(groqModelId);
    expect(row.served_model).toBe('gemma-3-27b-it');

    const warns = servedModelWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`platform=groq requested=${groqModelId} served=gemma-3-27b-it`);
  });

  it('non-streaming: warns once per tuple but persists every drifted row', async () => {
    mockUpstream({ upstreamModel: 'gemma-3-27b-it' });
    for (let i = 0; i < 2; i++) {
      const { status } = await request(app, 'POST', '/v1/chat/completions', {
        model: groqModelId, messages: [{ role: 'user', content: `drift repeat ${i}` }],
      }, authHeaders());
      expect(status).toBe(200);
    }
    expect(servedModelWarns()).toHaveLength(1);
    const rows = getDb().prepare(
      "SELECT served_model FROM requests WHERE status = 'success' ORDER BY id"
    ).all() as any[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.served_model).toBe('gemma-3-27b-it');
  });

  it('non-streaming: cosmetically-equal id (case + org prefix + :free suffix) does not flag', async () => {
    mockUpstream({ upstreamModel: `some-org/${groqModelId}:free`.toUpperCase() });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: groqModelId, messages: [{ role: 'user', content: 'cosmetic test' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(body.model).toBe(groqModelId);
    expect(lastRequestRow().served_model).toBeNull();
    expect(servedModelWarns()).toHaveLength(0);
  });

  it('non-streaming: identical served id stores NULL', async () => {
    mockUpstream({ upstreamModel: groqModelId });
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: groqModelId, messages: [{ role: 'user', content: 'same id test' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(lastRequestRow().served_model).toBeNull();
    expect(servedModelWarns()).toHaveLength(0);
  });

  it('streaming: captures, logs, and persists drift — streamed frames still show the routed model', async () => {
    mockUpstream({ upstreamModel: 'mystery-substitute-model', stream: true });
    const r = await request(app, 'POST', '/v1/chat/completions', {
      model: groqModelId, stream: true, messages: [{ role: 'user', content: 'stream drift test' }],
    }, authHeaders());
    expect(r.status).toBe(200);
    const fs = frames(r.text);
    expect(fs.length).toBeGreaterThan(0);
    // Contract unchanged: every outbound frame carries the routed model.
    for (const f of fs) expect(f.model).toBe(groqModelId);
    expect(fs.some(f => f.choices?.[0]?.delta?.content?.includes('streamed hello'))).toBe(true);

    const row = lastRequestRow();
    expect(row.status).toBe('success');
    expect(row.served_model).toBe('mystery-substitute-model');
    const warns = servedModelWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`platform=groq requested=${groqModelId} served=mystery-substitute-model`);
  });

  it('streaming: identical served id stores NULL and does not warn', async () => {
    mockUpstream({ upstreamModel: groqModelId, stream: true });
    const r = await request(app, 'POST', '/v1/chat/completions', {
      model: groqModelId, stream: true, messages: [{ role: 'user', content: 'stream same test' }],
    }, authHeaders());
    expect(r.status).toBe(200);
    expect(lastRequestRow().served_model).toBeNull();
    expect(servedModelWarns()).toHaveLength(0);
  });

  it('exposes servedModel in the per-request analytics detail payload', async () => {
    mockUpstream({ upstreamModel: 'gemma-3-27b-it' });
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: groqModelId, messages: [{ role: 'user', content: 'detail test' }],
    }, authHeaders());
    expect(status).toBe(200);
    const row = lastRequestRow();

    const detail = await request(app, 'GET', `/api/analytics/requests/${row.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.servedModel).toBe('gemma-3-27b-it');
    expect(detail.body.modelId).toBe(groqModelId);
  });
});
