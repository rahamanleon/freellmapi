import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// The dashboard Audio tab lists speech-to-text rows (modality='transcription',
// synced from the catalog's `transcriptionModels`) next to TTS. These tests pin
// the contract that page relies on: GET /api/media returns transcription rows
// unfiltered, and PUT /api/media/:id toggles them like any other media row.

let dashToken = '';

async function get(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function put(app: Express, path: string, body: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function seedTranscriptionRows() {
  const insert = getDb().prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES (?, ?, ?, 'transcription', ?, 1, ?)
  `);
  insert.run('groq', 'whisper-large-v3', 'Whisper large v3', 1, '~2000 min/day');
  insert.run('cloudflare', '@cf/openai/whisper', 'Whisper', 2, '10 min/day free');
}

describe('transcription models on the media dashboard API', () => {
  let app: Express;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('lists transcription rows alongside the other media modalities', async () => {
    seedTranscriptionRows();
    getDb().prepare(`
      INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
      VALUES ('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'FLUX.1 [schnell]', 'image', 1, 1, 'free tier')
    `).run();

    const { status, body } = await get(app, '/api/media');
    expect(status).toBe(200);

    const stt = body.models.filter((m: any) => m.modality === 'transcription');
    expect(stt.map((m: any) => `${m.platform}:${m.modelId}`)).toEqual([
      'groq:whisper-large-v3',
      'cloudflare:@cf/openai/whisper',
    ]);
    expect(stt[0]).toMatchObject({
      displayName: 'Whisper large v3',
      enabled: true,
      quotaLabel: '~2000 min/day',
      keyCount: 0,
      isCustom: false,
    });
    // Image rows keep their shape — transcription rides along, nothing filtered.
    expect(body.models.some((m: any) => m.modality === 'image')).toBe(true);
  });

  it('counts healthy keys for a transcription row’s platform', async () => {
    seedTranscriptionRows();
    const { encrypted, iv, authTag } = encrypt('not-a-real-key');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);

    const { body } = await get(app, '/api/media');
    const byPlatform = new Map(body.models
      .filter((m: any) => m.modality === 'transcription')
      .map((m: any) => [m.platform, m.keyCount]));
    expect(byPlatform.get('groq')).toBe(1);
    expect(byPlatform.get('cloudflare')).toBe(0);
  });

  it('toggles a transcription row off and back on via PUT /api/media/:id', async () => {
    seedTranscriptionRows();
    const row = getDb().prepare(
      "SELECT id FROM media_models WHERE modality = 'transcription' AND platform = 'groq'",
    ).get() as { id: number };

    expect((await put(app, `/api/media/${row.id}`, { enabled: false })).status).toBe(200);
    let listed = await get(app, '/api/media');
    expect(listed.body.models.find((m: any) => m.id === row.id).enabled).toBe(false);

    expect((await put(app, `/api/media/${row.id}`, { enabled: true })).status).toBe(200);
    listed = await get(app, '/api/media');
    expect(listed.body.models.find((m: any) => m.id === row.id).enabled).toBe(true);
  });
});
