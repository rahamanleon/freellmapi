import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { getModelGroups, resolveRequestedIdToMembers } from '../../services/model-groups.js';
import { groupHandle } from '../../lib/endpoint-scope.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// Endpoint groups (#1176). A custom endpoint can be filed under an operator-set
// group label. The label belongs to the endpoint (every key in its pool), sorts
// the Keys page, narrows the group's on/off switch, and lets a request pin a
// model to the group: `custom:<model>#<group>` fails over only inside it.

const SHARED_MODEL = 'deepseek-v3.1';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown, auth?: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

const post = (app: Express, path: string, body: unknown) => request(app, 'POST', path, body);
const get = (app: Express, path: string) => request(app, 'GET', path);
const patch = (app: Express, path: string, body: unknown) => request(app, 'PATCH', path, body);

function keysOf(baseUrl: string): { id: number; group_label: string | null; enabled: number }[] {
  return getDb().prepare(
    "SELECT id, group_label, enabled FROM api_keys WHERE platform = 'custom' AND base_url = ? ORDER BY id",
  ).all(baseUrl) as { id: number; group_label: string | null; enabled: number }[];
}

function modelRowOn(baseUrl: string, modelId = SHARED_MODEL): number {
  const row = getDb().prepare(
    "SELECT id FROM models WHERE platform = 'custom' AND model_id = ? AND endpoint_scope = ?",
  ).get(modelId, baseUrl) as { id: number } | undefined;
  if (!row) throw new Error(`no ${modelId} row on ${baseUrl}`);
  return row.id;
}

/** A tiny OpenAI-compatible upstream that answers with its own name. */
async function fakeRelay(name: string) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      hits.push(req.url ?? '');
      const model = (() => { try { return JSON.parse(raw).model; } catch { return SHARED_MODEL; } })();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-${name}`,
        object: 'chat.completion',
        created: 0,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: `from ${name}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  return { baseUrl, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe('custom endpoint groups (#1176)', () => {
  let app: Express;
  const RELAY_A = 'http://127.0.0.1:18191/v1';
  const RELAY_B = 'http://127.0.0.1:18192/v1';

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  describe('storing the group', () => {
    it('files a new endpoint under the group given on add, and lists it', async () => {
      const added = await post(app, '/api/keys/custom', {
        baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a', groupLabel: '  Work   relays ',
      });
      expect(added.status).toBe(201);
      expect(keysOf(RELAY_A).map(k => k.group_label)).toEqual(['Work relays']);

      const list = await get(app, '/api/keys');
      const row = (list.body as any[]).find(k => k.baseUrl === RELAY_A);
      expect(row.groupLabel).toBe('Work relays');
    });

    it('leaves an endpoint in the default group when none is given', async () => {
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a' });
      expect(keysOf(RELAY_A).map(k => k.group_label)).toEqual([null]);
      const list = await get(app, '/api/keys');
      expect((list.body as any[]).find(k => k.baseUrl === RELAY_A).groupLabel).toBeNull();
    });

    it('moves every key of the endpoint when one key is regrouped', async () => {
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a1' });
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a2' });
      const [first] = keysOf(RELAY_A);

      const res = await patch(app, `/api/keys/${first!.id}`, { groupLabel: 'Work' });
      expect(res.status).toBe(200);
      expect(res.body.groupLabel).toBe('Work');
      expect(keysOf(RELAY_A).map(k => k.group_label)).toEqual(['Work', 'Work']);

      // '' moves the whole endpoint back to the default group.
      await patch(app, `/api/keys/${first!.id}`, { groupLabel: '' });
      expect(keysOf(RELAY_A).map(k => k.group_label)).toEqual([null, null]);
    });

    it('gives a key added to a grouped endpoint the same group', async () => {
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a1', groupLabel: 'Work' });
      // Credential-only add (#702), no group in the submit.
      const res = await post(app, '/api/keys/custom', { baseUrl: RELAY_A, apiKey: 'key-a2' });
      expect(res.status).toBe(201);
      expect(keysOf(RELAY_A).map(k => k.group_label)).toEqual(['Work', 'Work']);
    });

    it('does not touch other endpoints', async () => {
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a' });
      await post(app, '/api/keys/custom', { baseUrl: RELAY_B, model: SHARED_MODEL, apiKey: 'key-b' });
      await patch(app, `/api/keys/${keysOf(RELAY_A)[0]!.id}`, { groupLabel: 'Work' });
      expect(keysOf(RELAY_B).map(k => k.group_label)).toEqual([null]);
    });

    it('rejects a group on a built-in provider key', async () => {
      const added = await post(app, '/api/keys', { platform: 'groq', key: 'gsk_test_key_123456' });
      expect(added.status).toBeLessThan(300);
      const id = (getDb().prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;
      const res = await patch(app, `/api/keys/${id}`, { groupLabel: 'Work' });
      expect(res.status).toBe(400);
    });
  });

  describe('group switch', () => {
    it('turns off only the named group, or only the ungrouped endpoints', async () => {
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a', groupLabel: 'Work' });
      await post(app, '/api/keys/custom', { baseUrl: RELAY_B, model: SHARED_MODEL, apiKey: 'key-b' });

      const off = await patch(app, '/api/keys/platform/custom', { enabled: false, group: 'Work' });
      expect(off.status).toBe(200);
      expect(off.body.updatedKeys).toBe(1);
      expect(keysOf(RELAY_A).map(k => k.enabled)).toEqual([0]);
      expect(keysOf(RELAY_B).map(k => k.enabled)).toEqual([1]);

      await patch(app, '/api/keys/platform/custom', { enabled: false, group: null });
      expect(keysOf(RELAY_B).map(k => k.enabled)).toEqual([0]);

      // No group keeps the old whole-platform sweep.
      await patch(app, '/api/keys/platform/custom', { enabled: true });
      expect([...keysOf(RELAY_A), ...keysOf(RELAY_B)].map(k => k.enabled)).toEqual([1, 1]);
    });

    it('refuses a group on a built-in platform', async () => {
      const res = await patch(app, '/api/keys/platform/groq', { enabled: false, group: 'Work' });
      expect(res.status).toBe(400);
    });
  });

  describe('referring to a group in a model id', () => {
    it('resolves custom:<model>#<group> to the copies inside the group only', async () => {
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a', groupLabel: 'My Relays' });
      await post(app, '/api/keys/custom', { baseUrl: RELAY_B, model: SHARED_MODEL, apiKey: 'key-b' });
      const groups = getModelGroups();

      expect(groupHandle('My Relays')).toBe('my-relays');
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#my-relays`, groups)).toEqual([modelRowOn(RELAY_A)]);
      // The label as typed, and the bare model id, both work too.
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#My Relays`, groups)).toEqual([modelRowOn(RELAY_A)]);
      expect(resolveRequestedIdToMembers(`${SHARED_MODEL}#my-relays`, groups)).toEqual([modelRowOn(RELAY_A)]);
      // Without a group the request still reaches both endpoints.
      expect(resolveRequestedIdToMembers(SHARED_MODEL, groups)?.sort()).toEqual([modelRowOn(RELAY_A), modelRowOn(RELAY_B)].sort());
      // An unknown group names nothing.
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#nope`, groups)).toBeNull();
    });

    it('spans every endpoint in the group', async () => {
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a', groupLabel: 'Work' });
      await post(app, '/api/keys/custom', { baseUrl: RELAY_B, model: SHARED_MODEL, apiKey: 'key-b', groupLabel: 'Work' });
      const ids = resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#work`, getModelGroups());
      expect(ids?.sort()).toEqual([modelRowOn(RELAY_A), modelRowOn(RELAY_B)].sort());
    });

    it('follows a regroup without a restart', async () => {
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a', groupLabel: 'Work' });
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#work`, getModelGroups())).not.toBeNull();
      await patch(app, `/api/keys/${keysOf(RELAY_A)[0]!.id}`, { groupLabel: 'Home' });
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#work`, getModelGroups())).toBeNull();
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#home`, getModelGroups())).toEqual([modelRowOn(RELAY_A)]);
    });

    it('prefers an endpoint handle over a group of the same name', async () => {
      await post(app, '/api/keys/custom', { baseUrl: RELAY_A, model: SHARED_MODEL, apiKey: 'key-a' });
      // Group B under a label that slugs to relay A's endpoint handle.
      await post(app, '/api/keys/custom', { baseUrl: RELAY_B, model: SHARED_MODEL, apiKey: 'key-b', groupLabel: '127.0.0.1-18191-v1' });
      expect(resolveRequestedIdToMembers(`custom:${SHARED_MODEL}#127.0.0.1-18191-v1`, getModelGroups()))
        .toEqual([modelRowOn(RELAY_A)]);
    });
  });

  describe('end to end', () => {
    const relays: Awaited<ReturnType<typeof fakeRelay>>[] = [];
    afterEach(async () => {
      await Promise.all(relays.splice(0).map(r => r.close()));
    });

    it('a chat request for custom:<model>#<group> is served by the group', async () => {
      const work = await fakeRelay('work');
      const home = await fakeRelay('home');
      relays.push(work, home);
      await post(app, '/api/keys/custom', { baseUrl: work.baseUrl, model: SHARED_MODEL, apiKey: 'key-w', groupLabel: 'Work' });
      await post(app, '/api/keys/custom', { baseUrl: home.baseUrl, model: SHARED_MODEL, apiKey: 'key-h', groupLabel: 'Home' });

      for (const [group, relay, other] of [['work', work, home], ['home', home, work]] as const) {
        const before = other.hits.length;
        const res = await request(app, 'POST', '/v1/chat/completions', {
          model: `custom:${SHARED_MODEL}#${group}`,
          messages: [{ role: 'user', content: 'hi' }],
        }, getUnifiedApiKey());
        expect(res.status).toBe(200);
        expect(res.body.choices[0].message.content).toBe(`from ${group}`);
        expect(relay.hits.length).toBeGreaterThan(0);
        expect(other.hits.length).toBe(before);
      }
    });
  });
});
