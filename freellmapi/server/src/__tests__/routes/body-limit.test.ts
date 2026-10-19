import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { loadConfig } from '../../lib/config.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

async function post(app: Express, path: string, body: unknown, key: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

// ~11.5MB base64 payload — the shape that used to die at the global 10mb
// express.json limit BEFORE routing (opaque 413, no fallback, no analytics
// row). Sized past 10MB on purpose: the regression only reproduces above it.
const BIG_IMAGE = `data:image/png;base64,${'A'.repeat(11_500_000)}`;

describe('Inference body limits (vision payloads)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  it('accepts an >10mb vision payload on /v1/chat/completions (no parser 413)', async () => {
    // Seed has vision models enabled but no provider keys, so routing
    // exhausts → 429. The point: it is NOT the parser's 413, proving the
    // body reached routing and the fallback loop owns the failure from here.
    const { status } = await post(app, '/v1/chat/completions', {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image_url', image_url: { url: BIG_IMAGE } },
        ],
      }],
    }, key);
    expect(status).not.toBe(413);
  }, 30_000);

  it('accepts an >10mb vision payload on /v1/responses too', async () => {
    const { status } = await post(app, '/v1/responses', {
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is in this image?' },
          { type: 'input_image', image_url: BIG_IMAGE },
        ],
      }],
    }, key);
    expect(status).not.toBe(413);
  }, 30_000);
});

describe('Over-limit bodies (configurable ceiling)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // Tiny ceiling so the rejection path is testable without a 50MB body.
    app = createApp({ ...loadConfig(), requestBodyLimitBytes: 1024 });
    key = getUnifiedApiKey();
  });

  it('returns a normalized OpenAI-style 413 and logs it for the dashboard', async () => {
    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'x'.repeat(4096) }],
    }, key);
    expect(status).toBe(413);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('request_too_large');
    expect(body.error.message).toContain('REQUEST_BODY_LIMIT_MB');

    // The rejection is visible in request analytics like any failed request,
    // not only in the container log.
    const row = getDb().prepare(
      "SELECT platform, model_id, status, error FROM requests WHERE model_id = 'payload-too-large' ORDER BY id DESC LIMIT 1",
    ).get() as { platform: string; model_id: string; status: string; error: string } | undefined;
    expect(row?.platform).toBe('proxy');
    expect(row?.status).toBe('error');
    expect(row?.error).toContain('Request body too large');
  });
});
