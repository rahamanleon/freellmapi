// Migration: media_models.meta_json — per-model adapter metadata from the catalog
// Created: 2026-07-26
//
// DOWN: reversible
//
// The transcription (STT) registry moves out of code and into the published
// catalog's `transcriptionModels` array, landing in media_models with
// modality='transcription'. Unlike image/TTS rows, transcription rows carry
// per-model facts the adapters need at request time:
//   - subtitleFormats: subtitle formats the provider produces natively (vtt)
//   - maxBytes:        provider upload ceiling in bytes
//   - requestStyle:    adapter request flavor where one platform hosts more
//                      than one deployment style (cloudflare 'json' = base64
//                      JSON body, 'binary' = raw bytes)
// These ride in one nullable JSON column rather than three sparse columns:
// they are opaque to SQL (never filtered or joined on), only parsed by the
// media service, and future modalities can reuse the column without another
// migration. NULL / absent keys mean "no special capability", which is the
// correct default for every pre-existing image/audio row.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'media_models', 'meta_json')) {
    db.prepare('ALTER TABLE media_models ADD COLUMN meta_json TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'media_models', 'meta_json')) {
    db.prepare('ALTER TABLE media_models DROP COLUMN meta_json').run();
  }
}
