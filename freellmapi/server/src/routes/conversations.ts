import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';

// Playground conversation storage, mounted under /api/conversations behind the
// dashboard session gate like every other admin route. The Playground page is
// the only client: it lists conversations in its sidebar (summaries, no
// bodies), loads one when you switch to it, and PUTs the whole transcript back
// after each completed exchange.
//
// The transcript is stored as the client's own ChatMessage[] — `meta` routing
// info and `reasoning` included — so a restored conversation renders exactly
// like the live one. Validation is therefore shape-checking, not
// normalisation: unknown keys are stripped, everything the page draws survives.

export const conversationsRouter = Router();

const MAX_TITLE_LEN = 200;
// A conversation is prose plus, occasionally, inlined image data URIs. 2 MB of
// serialised JSON is far more than any readable chat and still small enough to
// hand back on every switch without thinking about it. Over that we refuse the
// write rather than silently truncating someone's history.
export const MAX_MESSAGES_BYTES = 2 * 1024 * 1024;

// Mirrors the client's ChatMessage. Kept permissive on `content` (an empty
// assistant bubble is legitimate mid-fusion) and strict on `role`, which is the
// one field the renderer branches on.
const metaSchema = z.object({
  platform: z.string().optional(),
  model: z.string().optional(),
  latency: z.number().optional(),
  fallbackAttempts: z.number().optional(),
  fusionPanel: z.array(z.object({
    platform: z.string(),
    model: z.string(),
    status: z.enum(['ok', 'failed']).optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  })).optional(),
  fusionJudge: z.object({ platform: z.string(), model: z.string() }).nullable().optional(),
  // Playground "Search the web" (#1174): the engine that ran and the sources
  // shown under the answer, so a reloaded chat keeps its citations.
  webSearch: z.object({
    engine: z.string().max(200).optional(),
    latency: z.number().optional(),
    sources: z.array(z.object({ title: z.string().max(1000), url: z.string().max(4000) })).max(50).optional(),
  }).optional(),
});

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  images: z.array(z.string()).optional(),
  isError: z.boolean().optional(),
  reasoning: z.string().optional(),
  meta: metaSchema.optional(),
});
// `streaming: true` is deliberately absent above (and so stripped): a stored
// message is finished by definition, and persisting the flag would restore a
// transcript stuck mid-answer.

const messagesSchema = z.array(messageSchema);

// 'auto', 'fusion', or a canonical model id — whatever the picker held. Not
// enumerated: the catalog changes under us, and a conversation pinned to a
// model that has since gone away should still load.
const modelSchema = z.string().max(200).nullable();
const systemPromptSchema = z.string().max(32_000).nullable();

const createSchema = z.object({
  title: z.string().max(MAX_TITLE_LEN).optional(),
  messages: messagesSchema.optional(),
  model: modelSchema.optional(),
  systemPrompt: systemPromptSchema.optional(),
}).strict();

// PUT is a full upsert of the mutable state: every field the page owns, written
// in one statement. Fields left out keep their stored value, so a rename does
// not have to re-send the transcript (and cannot race one away).
const updateSchema = z.object({
  title: z.string().max(MAX_TITLE_LEN).optional(),
  messages: messagesSchema.optional(),
  model: modelSchema.optional(),
  systemPrompt: systemPromptSchema.optional(),
}).strict();

interface ConversationRow {
  id: number;
  title: string;
  messages_json: string;
  model: string | null;
  system_prompt: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface SummaryRow {
  id: number;
  title: string;
  model: string | null;
  message_count: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function toJson(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    // Stored JSON is only ever written from a validated array, so a parse
    // failure means the row was corrupted outside this router: hand back an
    // empty transcript rather than 500-ing the whole sidebar.
    messages: parseMessages(row.messages_json),
    model: row.model,
    systemPrompt: row.system_prompt,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

function parseMessages(json: string): unknown[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getConversation(id: number): ConversationRow | undefined {
  return getDb()
    .prepare('SELECT * FROM playground_conversations WHERE id = ?')
    .get(id) as ConversationRow | undefined;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid conversation id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Conversation not found' } });
}

/**
 * Serialise a validated transcript, refusing anything past the storage cap.
 * Returns null after answering with a 413 so callers can `return` on it.
 */
function serialiseMessages(messages: unknown[], res: Response): string | null {
  const json = JSON.stringify(messages);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_MESSAGES_BYTES) {
    res.status(413).json({
      error: {
        message:
          `Conversation is too large to save (${Math.round(bytes / 1024)} KB; the limit is ` +
          `${Math.round(MAX_MESSAGES_BYTES / 1024)} KB). Start a new conversation to keep going.`,
        type: 'conversation_too_large',
      },
    });
    return null;
  }
  return json;
}

// Summaries for the sidebar: no message bodies cross the wire, so the list stays
// small no matter how long the conversations are. json_array_length reads the
// count straight out of the stored blob (SQLite's JSON1, present in both the
// better-sqlite3 and node:sqlite drivers) instead of parsing every transcript.
conversationsRouter.get('/', (_req: Request, res: Response) => {
  const rows = getDb().prepare(`
    SELECT id,
           title,
           model,
           json_array_length(messages_json) AS message_count,
           created_at_ms,
           updated_at_ms
      FROM playground_conversations
     ORDER BY updated_at_ms DESC, id DESC
  `).all() as SummaryRow[];
  res.json(rows.map(row => ({
    id: row.id,
    title: row.title,
    model: row.model,
    messageCount: row.message_count ?? 0,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  })));
});

conversationsRouter.get('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const row = getConversation(id);
  if (!row) return notFound(res);
  res.json(toJson(row));
});

conversationsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid conversation' } });
    return;
  }
  const messagesJson = serialiseMessages(parsed.data.messages ?? [], res);
  if (messagesJson === null) return;

  const now = Date.now();
  const info = getDb().prepare(`
    INSERT INTO playground_conversations
      (title, messages_json, model, system_prompt, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    parsed.data.title ?? '',
    messagesJson,
    parsed.data.model ?? null,
    parsed.data.systemPrompt ?? null,
    now,
    now,
  );
  res.status(201).json(toJson(getConversation(Number(info.lastInsertRowid))!));
});

conversationsRouter.put('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid conversation update' } });
    return;
  }
  const row = getConversation(id);
  if (!row) return notFound(res);

  const { title, messages, model, systemPrompt } = parsed.data;
  const messagesJson = messages === undefined
    ? row.messages_json
    : serialiseMessages(messages, res);
  if (messagesJson === null) return;

  // One statement for the whole conversation: title, transcript, model and
  // system prompt always move together, so a save can never leave a row half
  // updated (the transcript of one exchange under the title of another).
  getDb().prepare(`
    UPDATE playground_conversations
       SET title = ?, messages_json = ?, model = ?, system_prompt = ?, updated_at_ms = ?
     WHERE id = ?
  `).run(
    title ?? row.title,
    messagesJson,
    model === undefined ? row.model : model,
    systemPrompt === undefined ? row.system_prompt : systemPrompt,
    Date.now(),
    id,
  );
  res.json(toJson(getConversation(id)!));
});

conversationsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const info = getDb().prepare('DELETE FROM playground_conversations WHERE id = ?').run(id);
  if (info.changes === 0) return notFound(res);
  res.json({ success: true });
});
