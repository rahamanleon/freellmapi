import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// `document` content blocks on POST /v1/messages.
//
// They used to fall off the end of the block ladder with every other
// unrecognised type, so attaching a PDF produced a confident answer about a
// document the model never saw. Text-shaped documents are now inlined; the
// rest are refused, before routing, with an actionable message.

let dashToken = '';

async function request(app: Express, path: string, body: any, extraHeaders: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE body */ }
  return { status: res.status, headers: res.headers, text, body: json };
}

function anthropicHeaders() {
  return { 'x-api-key': getUnifiedApiKey(), 'anthropic-version': '2023-06-01' };
}

/** Mock Groq's upstream and capture the post-translation outbound body. */
function mockJson(response: any) {
  const origFetch = global.fetch;
  const captured: { body: any; calls: number } = { body: null, calls: 0 };
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
      captured.calls++;
      captured.body = JSON.parse(String((init as RequestInit).body));
      return new Response(JSON.stringify(response), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return origFetch(url, init);
  });
  return captured;
}

const OK_RESPONSE = {
  id: 'chatcmpl-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'read it' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

const PDF_BLOCK = {
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQKUEFZTE9BRA==' },
  title: 'contract.pdf',
};

const TEXT_DOC_BLOCK = {
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data: 'PAYMENT TERMS: net 30.' },
  title: 'contract.txt',
};

describe('Anthropic document blocks', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    const { status } = await request(app, '/api/keys',
      { platform: 'groq', key: 'gsk_document_test', label: 't' },
      { Authorization: `Bearer ${dashToken}` });
    expect(status).toBe(201);
  });

  afterEach(() => vi.restoreAllMocks());

  it('refuses a base64 PDF with an actionable error instead of answering without it', async () => {
    mockJson(OK_RESPONSE);

    const { status, body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: [PDF_BLOCK, { type: 'text', text: 'summarize this' }] }],
    }, anthropicHeaders());

    expect(status).toBe(400);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('application/pdf');
    expect(body.error.message).toContain('Send the text instead');
  });

  it('spends no provider quota on a request every candidate would refuse', async () => {
    // Rejected before routing: a document failure is ours, not a provider's,
    // and failing over would try the same impossible request on the next key.
    const captured = mockJson(OK_RESPONSE);

    await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: [PDF_BLOCK] }],
    }, anthropicHeaders());

    expect(captured.calls).toBe(0);
    expect(getDb().prepare('SELECT COUNT(*) c FROM requests').get()).toMatchObject({ c: 0 });
  });

  it('never echoes the document payload back in the error', async () => {
    mockJson(OK_RESPONSE);

    const { body } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: [PDF_BLOCK] }],
    }, anthropicHeaders());

    expect(body.error.message).not.toContain('JVBERi');
  });

  it('inlines a text-source document and forwards it upstream', async () => {
    const captured = mockJson(OK_RESPONSE);

    const { status } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: [TEXT_DOC_BLOCK, { type: 'text', text: 'what are the terms?' }] }],
    }, anthropicHeaders());

    expect(status).not.toBe(400);
    if (captured.body) {
      const forwarded = JSON.stringify(captured.body);
      expect(forwarded).toContain('PAYMENT TERMS: net 30.');
      expect(forwarded).toContain('what are the terms?');
      // Fenced, so the model can tell quoted document from instruction.
      expect(forwarded).toMatch(/document-[0-9a-f]{12}/);
    }
  });

  it('applies the same verdict on count_tokens, not just on messages', async () => {
    const { status, body } = await request(app, '/v1/messages/count_tokens', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [PDF_BLOCK] }],
    }, anthropicHeaders());

    expect(status).toBe(400);
    expect(body.error.message).toContain('application/pdf');
  });

  it('still counts tokens for a text-source document', async () => {
    const { status, body } = await request(app, '/v1/messages/count_tokens', {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [TEXT_DOC_BLOCK] }],
    }, anthropicHeaders());

    expect(status).toBe(200);
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it('leaves ordinary requests untouched', async () => {
    const captured = mockJson(OK_RESPONSE);

    const { status } = await request(app, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'no documents here' }] }],
    }, anthropicHeaders());

    expect(status).not.toBe(400);
    if (captured.body) expect(JSON.stringify(captured.body)).toContain('no documents here');
  });
});
