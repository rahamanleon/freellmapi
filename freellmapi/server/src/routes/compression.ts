import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ChatMessage, ChatToolDefinition } from '@freellmapi/shared/types.js';
import { z } from 'zod';
import { COMPRESSION_MODES, type CompressionMode } from '../services/compression/types.js';
import { compressRequest } from '../services/compression/pipeline.js';
import { getCompressionConfig } from '../services/compression/config.js';
import { getCompressionStats } from '../services/compression/stats.js';

export const compressionRouter = Router();

const previewMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([
    z.string(),
    z.null(),
    z.array(z.union([z.string(), z.record(z.string(), z.unknown())])),
  ]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }),
  }).passthrough()).optional(),
}).passthrough();

compressionRouter.get('/stats', (_req: Request, res: Response) => {
  res.json({ config: getCompressionConfig(), ...getCompressionStats() });
});

function previewMessages(body: unknown): ChatMessage[] | null {
  if (typeof body === 'string') return [{ role: 'user', content: body }];
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (Array.isArray(value.messages)) {
    const parsed = z.array(previewMessageSchema).safeParse(value.messages);
    return parsed.success ? parsed.data as ChatMessage[] : null;
  }
  if (typeof value.body === 'string') return [{ role: 'user', content: value.body }];
  if (value.body && typeof value.body === 'object' && Array.isArray((value.body as Record<string, unknown>).messages)) {
    const parsed = z.array(previewMessageSchema).safeParse((value.body as Record<string, unknown>).messages);
    return parsed.success ? parsed.data as ChatMessage[] : null;
  }
  return null;
}

compressionRouter.post('/preview', (req: Request, res: Response) => {
  const messages = previewMessages(req.body);
  if (!messages || messages.length === 0) {
    res.status(400).json({
      error: {
        message: 'Preview requires `messages`, a request `body` containing messages, or a string `body`.',
        type: 'invalid_request_error',
      },
    });
    return;
  }
  const rawMode = (req.body as { mode?: unknown })?.mode;
  const mode: CompressionMode = typeof rawMode === 'string'
    && (COMPRESSION_MODES as readonly string[]).includes(rawMode)
      ? rawMode as CompressionMode
      : getCompressionConfig().mode;
  const targetTokens = (req.body as { targetTokens?: unknown })?.targetTokens;
  const tools = Array.isArray((req.body as { tools?: unknown })?.tools)
    ? (req.body as { tools: ChatToolDefinition[] }).tools
    : undefined;
  const result = compressRequest(messages, {
    previewMode: mode,
    targetTokens: typeof targetTokens === 'number' && targetTokens > 0 ? Math.floor(targetTokens) : undefined,
    tools,
    recordStats: false,
  });
  res.json({
    mode: result.mode,
    original: messages,
    compressed: result.messages,
    diff: {
      beforeChars: result.stats.originalChars,
      afterChars: result.stats.compressedChars,
      savedChars: result.stats.originalChars - result.stats.compressedChars,
    },
    stats: result.stats,
  });
});
