import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import { routePinnedModel } from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// #619(b): a custom endpoint can hold SEVERAL credentials. Adding a second key
// for a base_url that already has one used to UPDATE the existing row — the
// first key vanished with no warning — and the models upsert re-bound every
// model of that endpoint to whichever key was submitted last.

const ENDPOINT = 'http://127.0.0.1:18080/v1';
let dashToken = '';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

const post = (app: Express, path: string, body: unknown) => request(app, 'POST', path, body);
const get = (app: Express, path: string) => request(app, 'GET', path);
const del = (app: Express, path: string) => request(app, 'DELETE', path);

function customKeys(baseUrl = ENDPOINT) {
  return getDb().prepare(`
    SELECT id, label, encrypted_key, iv, auth_tag, base_url
      FROM api_keys
     WHERE platform = 'custom' AND base_url = ?
     ORDER BY id
  `).all(baseUrl) as Array<{ id: number; label: string; encrypted_key: string; iv: string; auth_tag: string; base_url: string }>;
}

function secrets(baseUrl = ENDPOINT) {
  return customKeys(baseUrl).map(k => decrypt(k.encrypted_key, k.iv, k.auth_tag));
}

function chatModel(modelId: string) {
  return getDb().prepare("SELECT id, key_id FROM models WHERE platform = 'custom' AND model_id = ?")
    .get(modelId) as { id: number; key_id: number | null } | undefined;
}

describe('multiple keys per custom endpoint (#619)', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('inserts a second key row instead of overwriting the first', async () => {
    expect((await post(app, '/api/keys/custom', {
      baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret', label: 'Relay A',
    })).status).toBe(201);
    expect((await post(app, '/api/keys/custom', {
      baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'second-secret', label: 'Relay B',
    })).status).toBe(201);

    expect(secrets()).toEqual(['first-secret', 'second-secret']);
  });

  it('keeps an existing model bound to a key of its endpoint', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
    const firstKeyId = customKeys()[0]!.id;
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'second-secret' });

    // The binding must not be silently moved to the last-added key.
    expect(chatModel('relay-model')!.key_id).toBe(firstKeyId);
  });

  it('rotates request-time key selection across every key of the endpoint', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'second-secret' });

    const modelDbId = chatModel('relay-model')!.id;
    const usedKeyIds = new Set<number>();
    const usedSecrets = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const route = routePinnedModel(modelDbId);
      expect(route).not.toBeNull();
      expect((route!.provider as any).baseUrl).toBe(ENDPOINT);
      usedKeyIds.add(route!.keyId);
      usedSecrets.add(route!.apiKey);
      route!.release?.();
    }

    expect(usedKeyIds.size).toBe(2);
    expect([...usedSecrets].sort()).toEqual(['first-secret', 'second-secret']);
  });

  it('updates in place when the same secret is submitted again', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret', label: 'Relay A' });
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret', label: 'Relay renamed' });

    const keys = customKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.label).toBe('Relay renamed');
  });

  it('upgrades a keyless endpoint in place when a real key arrives', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model' });
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });

    // 'no-key' is a placeholder, not a credential — replacing it loses nothing.
    expect(secrets()).toEqual(['first-secret']);
  });

  it('lists the endpoint models against every key of that endpoint', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'second-secret' });

    const { body } = await get(app, '/api/keys');
    const rows = (body as any[]).filter(k => k.platform === 'custom');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.models.map((m: any) => m.modelId)).toEqual(['relay-model']);
    }
  });

  it('re-binds the endpoint models to a sibling key when one key is deleted', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'second-secret' });
    const [first, second] = customKeys();

    expect((await del(app, `/api/keys/${first!.id}`)).status).toBe(200);

    const model = chatModel('relay-model');
    expect(model).toBeDefined();
    expect(model!.key_id).toBe(second!.id);
    expect(getDb().prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(model!.id)).toBeDefined();

    // Still routable through the surviving credential.
    const route = routePinnedModel(model!.id);
    expect(route).not.toBeNull();
    expect(route!.apiKey).toBe('second-secret');
    route!.release?.();
  });

  it('still cascades the models away when the endpoints last key is deleted', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
    const only = customKeys()[0]!;
    const modelDbId = chatModel('relay-model')!.id;

    expect((await del(app, `/api/keys/${only.id}`)).status).toBe(200);

    expect(chatModel('relay-model')).toBeUndefined();
    expect(getDb().prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelDbId)).toBeUndefined();
  });

  it('clears every key of the endpoint once its last model is removed', async () => {
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'second-secret' });
    expect(customKeys()).toHaveLength(2);

    const modelDbId = chatModel('relay-model')!.id;
    expect((await del(app, `/api/models/custom/${modelDbId}`)).status).toBe(200);

    expect(customKeys()).toHaveLength(0);
  });

  it('keeps a second custom media key for the same endpoint', async () => {
    expect((await post(app, '/api/media/custom', {
      baseUrl: ENDPOINT, model: 'relay-image', modality: 'image', apiKey: 'first-secret',
    })).status).toBe(201);
    expect((await post(app, '/api/media/custom', {
      baseUrl: ENDPOINT, model: 'relay-image', modality: 'image', apiKey: 'second-secret',
    })).status).toBe(201);

    expect(secrets()).toEqual(['first-secret', 'second-secret']);
  });

  it('does not merge keys that share a secret across different endpoints', async () => {
    const other = 'http://127.0.0.1:18081/v1';
    await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'shared-secret' });
    await post(app, '/api/keys/custom', { baseUrl: other, model: 'other-model', apiKey: 'shared-secret' });

    expect(secrets()).toEqual(['shared-secret']);
    expect(secrets(other)).toEqual(['shared-secret']);
    expect(routePinnedModel(chatModel('other-model')!.id)!.provider).toMatchObject({ baseUrl: other });
  });

  // #702: every route into POST /custom demanded a model alongside the key, so
  // an endpoint whose models were all registered had no way left to take a
  // second credential. The reporter got past it by registering a throwaway
  // model id and deleting it afterwards, which silently took the new key too.
  describe('adding a key without naming a model (#702)', () => {
    const modelSettings = (modelId: string) => getDb().prepare(
      "SELECT key_id, enabled, display_name, supports_tools, supports_vision FROM models WHERE platform = 'custom' AND model_id = ?",
    ).get(modelId) as { key_id: number; enabled: number; display_name: string; supports_tools: number; supports_vision: number };

    it('adds a second credential to an endpoint that is fully registered', async () => {
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });

      const res = await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, apiKey: 'second-secret', label: 'Relay B' });

      expect(res.status).toBe(201);
      expect((res.body as any).models).toEqual([]);
      expect(secrets()).toEqual(['first-secret', 'second-secret']);
      expect(customKeys()[1]!.label).toBe('Relay B');
    });

    it('leaves the models of the endpoint exactly as they were', async () => {
      await post(app, '/api/keys/custom', {
        baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret', supportsTools: true, supportsVision: true,
      });
      const before = modelSettings('relay-model');
      // Whatever the operator tuned afterwards has to survive the key add: going
      // through the model form instead resets all of this.
      getDb().prepare("UPDATE models SET enabled = 0, display_name = 'Tuned name' WHERE platform = 'custom' AND model_id = 'relay-model'").run();

      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, apiKey: 'second-secret' });

      expect(modelSettings('relay-model')).toEqual({
        key_id: before.key_id,
        enabled: 0,
        display_name: 'Tuned name',
        supports_tools: 1,
        supports_vision: 1,
      });
    });

    it('puts the new credential straight into the rotation pool', async () => {
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, apiKey: 'second-secret' });

      const modelDbId = chatModel('relay-model')!.id;
      const usedSecrets = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const route = routePinnedModel(modelDbId);
        usedSecrets.add(route!.apiKey);
        route!.release?.();
      }

      expect([...usedSecrets].sort()).toEqual(['first-secret', 'second-secret']);
    });

    it('upgrades a keyless endpoint in place rather than adding a row', async () => {
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model' });

      const res = await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, apiKey: 'first-secret' });

      // 'no-key' is a placeholder, not a credential, so nothing is lost.
      expect(res.status).toBe(200);
      expect(secrets()).toEqual(['first-secret']);
    });

    it('rejects a secret the endpoint already holds', async () => {
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });

      const res = await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, apiKey: 'first-secret' });

      expect(res.status).toBe(409);
      expect(secrets()).toEqual(['first-secret']);
    });

    it('still requires a model for an endpoint that does not exist yet', async () => {
      const res = await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, apiKey: 'first-secret' });

      expect(res.status).toBe(400);
      expect(customKeys()).toHaveLength(0);
    });

    it('still requires a model when no key is submitted either', async () => {
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });

      const res = await post(app, '/api/keys/custom', { baseUrl: ENDPOINT });

      expect(res.status).toBe(400);
      expect((res.body as any).error.message).toBe('model or models is required');
    });

    // #705: every endpoint used to default to the literal label 'Custom', so the
    // panels that name a key by its label alone showed identical rows for every
    // relay the operator ran.
    it('names an unlabelled endpoint after its host', async () => {
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
      await post(app, '/api/keys/custom', { baseUrl: 'http://127.0.0.1:18081/v1', model: 'other-model', apiKey: 'other-secret' });

      expect(customKeys()[0]!.label).toBe('127.0.0.1:18080');
      expect(customKeys('http://127.0.0.1:18081/v1')[0]!.label).toBe('127.0.0.1:18081');
    });

    it('still prefers a label the operator supplied', async () => {
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret', label: 'My relay' });

      expect(customKeys()[0]!.label).toBe('My relay');
    });

    // The per-key switch the dashboard grew in #705 is only worth anything if
    // routing honours it, which it has all along.
    it('drops a disabled credential out of the endpoint rotation', async () => {
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, apiKey: 'second-secret' });
      const [first, second] = customKeys();

      await request(app, 'PATCH', `/api/keys/${second!.id}`, { enabled: false });

      const modelDbId = chatModel('relay-model')!.id;
      const used = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const route = routePinnedModel(modelDbId);
        used.add(route!.apiKey);
        route!.release?.();
      }
      expect([...used]).toEqual(['first-secret']);

      // ...and the endpoint stops routing entirely once the last one is off.
      await request(app, 'PATCH', `/api/keys/${first!.id}`, { enabled: false });
      expect(routePinnedModel(modelDbId)).toBeNull();
    });

    it('keeps a spare key when the model it arrived with is deleted', async () => {
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'first-secret' });
      await post(app, '/api/keys/custom', { baseUrl: ENDPOINT, model: 'placeholder', apiKey: 'second-secret' });
      expect(secrets()).toEqual(['first-secret', 'second-secret']);

      expect((await del(app, `/api/models/custom/${chatModel('placeholder')!.id}`)).status).toBe(200);

      // The endpoint still serves relay-model, so neither key is dead weight.
      expect(secrets()).toEqual(['first-secret', 'second-secret']);
    });
  });
});
