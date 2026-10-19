import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getSetting, setSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { UNIFIED_MAX_TOKENS_SETTING, UNIFIED_MAX_TOKENS_AUTO } from '../../lib/sampling-params.js';

async function request(app: Express, method: string, path: string, body: any, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

// GET/PUT /api/settings/output-limit is the only way to configure the unified
// output-token cap, so its contract is what a dashboard has to code against.
describe('/api/settings/output-limit', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it("reports 'off' before anything is configured", async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/output-limit', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ mode: 'off', effectiveCap: null, autoValue: UNIFIED_MAX_TOKENS_AUTO });
  });

  it("stores 'auto' and reports the auto ceiling", async () => {
    const put = await request(app, 'PUT', '/api/settings/output-limit', { mode: 'auto' }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ mode: 'auto', effectiveCap: UNIFIED_MAX_TOKENS_AUTO, autoValue: UNIFIED_MAX_TOKENS_AUTO });
    expect(getSetting(UNIFIED_MAX_TOKENS_SETTING)).toBe('auto');

    const get = await request(app, 'GET', '/api/settings/output-limit', undefined, token);
    expect(get.body).toEqual(put.body);
  });

  it('stores an explicit integer and reports it as a number, not a string', async () => {
    const put = await request(app, 'PUT', '/api/settings/output-limit', { mode: 8192 }, token);
    expect(put.status).toBe(200);
    expect(put.body.mode).toBe(8192);
    expect(put.body.effectiveCap).toBe(8192);

    // A dashboard must be able to PUT back exactly what GET handed it.
    const get = await request(app, 'GET', '/api/settings/output-limit', undefined, token);
    expect(get.body).toEqual(put.body);
    const roundTrip = await request(app, 'PUT', '/api/settings/output-limit', { mode: get.body.mode }, token);
    expect(roundTrip.status).toBe(200);
    expect(roundTrip.body).toEqual(get.body);
  });

  it("'off' restores pass-through", async () => {
    await request(app, 'PUT', '/api/settings/output-limit', { mode: 'auto' }, token);
    const put = await request(app, 'PUT', '/api/settings/output-limit', { mode: 'off' }, token);
    expect(put.status).toBe(200);
    expect(put.body.mode).toBe('off');
    expect(put.body.effectiveCap).toBeNull();
  });

  const rejected: Array<[string, any]> = [
    ['an unknown mode string', { mode: 'unlimited' }],
    ['a numeric string', { mode: '8192' }],
    ['zero', { mode: 0 }],
    ['a negative integer', { mode: -1 }],
    ['a fractional value', { mode: 1.5 }],
    ['a missing mode', {}],
    ['a null mode', { mode: null }],
  ];

  for (const [label, payload] of rejected) {
    it(`rejects ${label} with a 400 and leaves the setting untouched`, async () => {
      await request(app, 'PUT', '/api/settings/output-limit', { mode: 4096 }, token);
      const { status, body } = await request(app, 'PUT', '/api/settings/output-limit', payload, token);
      expect(status).toBe(400);
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toMatch(/Invalid output limit/);
      expect(getSetting(UNIFIED_MAX_TOKENS_SETTING)).toBe('4096');
    });
  }

  it('reports a stored value it cannot parse as off, matching how it behaves', async () => {
    setSetting(UNIFIED_MAX_TOKENS_SETTING, 'banana');
    const { body } = await request(app, 'GET', '/api/settings/output-limit', undefined, token);
    expect(body.mode).toBe('off');
    expect(body.effectiveCap).toBeNull();
  });
});
