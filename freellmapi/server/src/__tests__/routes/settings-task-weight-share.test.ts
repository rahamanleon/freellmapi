import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { TASK_WEIGHT_SHARE_KEY, getTaskWeightShare, setTaskWeightShare } from '../../services/router.js';
import { taskAdjustedWeights, TASK_WEIGHT_SHARE } from '../../services/scoring.js';

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

// GET/PUT /api/settings/task-weight-share (#1127 follow-up): tunable share of
// one bandit axis moved onto the other for declared/derived task types.
describe('/api/settings/task-weight-share', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('reports the scoring.ts default before anything is configured', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/task-weight-share', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ share: TASK_WEIGHT_SHARE });
  });

  it('stores and returns the configured share', async () => {
    const put = await request(app, 'PUT', '/api/settings/task-weight-share', { share: 0.5 }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ share: 0.5 });
    expect(getSetting(TASK_WEIGHT_SHARE_KEY)).toBe('0.5');

    const get = await request(app, 'GET', '/api/settings/task-weight-share', undefined, token);
    expect(get.body).toEqual(put.body);
  });

  it('null clears back to the default', async () => {
    await request(app, 'PUT', '/api/settings/task-weight-share', { share: 0.5 }, token);
    const put = await request(app, 'PUT', '/api/settings/task-weight-share', { share: null }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ share: TASK_WEIGHT_SHARE });
    expect(getSetting(TASK_WEIGHT_SHARE_KEY)).toBeUndefined();
  });

  it('rejects out-of-range, negative, and non-numeric shares', async () => {
    for (const bad of [{ share: 1.5 }, { share: -0.1 }, { share: 2 }, { share: '0.5' }]) {
      const { status } = await request(app, 'PUT', '/api/settings/task-weight-share', bad, token);
      expect(status).toBe(400);
    }
  });

  it('requires the share field', async () => {
    const { status } = await request(app, 'PUT', '/api/settings/task-weight-share', {}, token);
    expect(status).toBe(400);
  });

  it('a corrupt stored value falls back to the default', async () => {
    setTaskWeightShare(0.7);
    const db = (await import('../../db/index.js')).getDb();
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('not-a-number', TASK_WEIGHT_SHARE_KEY);
    expect(getTaskWeightShare()).toBe(TASK_WEIGHT_SHARE);
  });
});

describe('taskAdjustedWeights share parameter', () => {
  const base = { reliability: 0.5, speed: 0.25, intelligence: 0.25 };

  it('share 0 disables the bias entirely', () => {
    const out = taskAdjustedWeights(base, 'code', 'balanced', 0);
    expect(out.adjusted).toBe(false);
    expect(out.weights).toEqual(base);
  });

  it('moves share of the speed axis onto intelligence for code', () => {
    const out = taskAdjustedWeights(base, 'code', 'balanced', 0.5);
    expect(out.adjusted).toBe(true);
    expect(out.weights.speed).toBeCloseTo(0.25 - 0.25 * 0.5);
    expect(out.weights.intelligence).toBeCloseTo(0.25 + 0.25 * 0.5);
    expect(out.weights.reliability).toBe(0.5);
  });

  it('moves share of the intelligence axis onto speed for chat', () => {
    const out = taskAdjustedWeights(base, 'chat', 'balanced', 0.5);
    expect(out.adjusted).toBe(true);
    expect(out.weights.speed).toBeCloseTo(0.25 + 0.25 * 0.5);
    expect(out.weights.intelligence).toBeCloseTo(0.25 - 0.25 * 0.5);
  });

  it('an exempt strategy ignores the configured share', () => {
    // The share only scales a bias the strategy accepts in the first place:
    // fastest/reliable/custom stay exactly where the operator put them (#1128).
    for (const strategy of ['fastest', 'reliable', 'custom'] as const) {
      const out = taskAdjustedWeights(base, 'code', strategy, 1);
      expect(out.adjusted).toBe(false);
      expect(out.weights).toEqual(base);
    }
  });
});
