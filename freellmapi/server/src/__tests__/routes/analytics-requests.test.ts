import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';
import { mintDashboardToken } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${dashToken}` },
  });
  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

function insertCall(createdAt: string, clientIp: string | null, clientUserAgent: string | null, status = 'success', platform = 'test') {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at, client_ip, client_user_agent)
    VALUES (?, 'test-model', ?, 10, 5, 42, NULL, ?, ?, ?)
  `).run(platform, status, createdAt, clientIp, clientUserAgent);
}

function recentUtcTimestamp(hour: number) {
  const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const hh = String(hour).padStart(2, '0');
  return {
    sql: `${day} ${hh}:00:00`,
    iso: `${day}T${hh}:00:00Z`,
  };
}

describe('GET /api/analytics/requests', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
  });

  it('returns one row per call, newest first, with caller identity', async () => {
    insertCall(recentUtcTimestamp(10).sql, '192.168.0.3', 'curl/8.6.0');
    insertCall(recentUtcTimestamp(11).sql, '192.168.0.15', 'python-httpx/0.27');
    insertCall(recentUtcTimestamp(12).sql, null, null);

    const { status, body } = await request(app, '/api/analytics/requests?range=7d');
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.rows.map((r: any) => r.clientIp)).toEqual([null, '192.168.0.15', '192.168.0.3']);
    expect(body.rows[1]).toMatchObject({
      platform: 'test',
      modelId: 'test-model',
      status: 'success',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 42,
      clientIp: '192.168.0.15',
      clientUserAgent: 'python-httpx/0.27',
    });
    // created_at is emitted as ISO-8601 UTC so the dashboard localizes it.
    expect(body.rows[1].createdAt).toBe(recentUtcTimestamp(11).iso);
  });

  it('paginates with limit/offset and clamps limit to 500', async () => {
    for (let i = 0; i < 5; i++) insertCall(recentUtcTimestamp(i).sql, '10.0.0.1', 'ua');

    const page = await request(app, '/api/analytics/requests?range=7d&limit=2&offset=2');
    expect(page.body.total).toBe(5);
    expect(page.body.rows).toHaveLength(2);
    expect(page.body.rows[0].createdAt).toBe(recentUtcTimestamp(2).iso);

    const clamped = await request(app, '/api/analytics/requests?range=7d&limit=99999');
    expect(clamped.body.rows).toHaveLength(5);
  });

  it('filters by status, keeping total consistent with the filter', async () => {
    insertCall(recentUtcTimestamp(8).sql, '10.0.0.1', 'ua', 'success');
    insertCall(recentUtcTimestamp(9).sql, '10.0.0.1', 'ua', 'error');
    insertCall(recentUtcTimestamp(10).sql, '10.0.0.1', 'ua', 'error');

    const errors = await request(app, '/api/analytics/requests?range=7d&status=error');
    expect(errors.status).toBe(200);
    expect(errors.body.total).toBe(2);
    expect(errors.body.rows.map((r: any) => r.status)).toEqual(['error', 'error']);

    const successes = await request(app, '/api/analytics/requests?range=7d&status=success');
    expect(successes.body.total).toBe(1);
    expect(successes.body.rows.map((r: any) => r.status)).toEqual(['success']);
  });

  it("filters by the 'canceled' status (#752)", async () => {
    insertCall(recentUtcTimestamp(8).sql, '10.0.0.1', 'ua', 'success');
    insertCall(recentUtcTimestamp(9).sql, '10.0.0.1', 'ua', 'canceled');

    const canceled = await request(app, '/api/analytics/requests?range=7d&status=canceled');
    expect(canceled.status).toBe(200);
    expect(canceled.body.total).toBe(1);
    expect(canceled.body.rows.map((r: any) => r.status)).toEqual(['canceled']);
    // ...and canceled rows still show up unfiltered.
    expect((await request(app, '/api/analytics/requests?range=7d')).body.total).toBe(2);
  });

  it('filters by platform, and combines with the status filter', async () => {
    insertCall(recentUtcTimestamp(8).sql, '10.0.0.1', 'ua', 'success', 'groq');
    insertCall(recentUtcTimestamp(9).sql, '10.0.0.1', 'ua', 'error', 'groq');
    insertCall(recentUtcTimestamp(10).sql, '10.0.0.1', 'ua', 'error', 'google');

    const groq = await request(app, '/api/analytics/requests?range=7d&platform=groq');
    expect(groq.status).toBe(200);
    expect(groq.body.total).toBe(2);
    expect(groq.body.rows.map((r: any) => r.platform)).toEqual(['groq', 'groq']);

    const combined = await request(app, '/api/analytics/requests?range=7d&platform=groq&status=error');
    expect(combined.body.total).toBe(1);
    expect(combined.body.rows).toHaveLength(1);
    expect(combined.body.rows[0]).toMatchObject({ platform: 'groq', status: 'error' });
  });

  it('rejects invalid status/platform filter values with 400', async () => {
    insertCall(recentUtcTimestamp(8).sql, '10.0.0.1', 'ua');

    expect((await request(app, '/api/analytics/requests?range=7d&status=weird')).status).toBe(400);
    expect((await request(app, '/api/analytics/requests?range=7d&platform=' + encodeURIComponent('a b;--'))).status).toBe(400);
    // Absent filters keep the default behavior.
    expect((await request(app, '/api/analytics/requests?range=7d')).status).toBe(200);
  });

  it('records the request-scoped caller identity through logRequest', async () => {
    const { clientContextMiddleware } = await import('../../lib/client-context.js');
    const req = { headers: { 'user-agent': 'vitest-client/1.0' }, socket: { remoteAddress: '192.168.0.99' } } as any;
    await new Promise<void>(resolve => {
      clientContextMiddleware(req, {} as any, () => {
        logRequest('test', 'test-model', 1, 'success', 1, 2, 3, null);
        resolve();
      });
    });

    const row = getDb().prepare('SELECT client_ip, client_user_agent FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(row).toEqual({ client_ip: '192.168.0.99', client_user_agent: 'vitest-client/1.0' });
  });
});
