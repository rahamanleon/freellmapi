import crypto from 'node:crypto';
import { z } from 'zod';
import { registerEngine } from '../registry.js';
import { textContent, withTextContent } from '../helpers.js';
import type { CompressionEngine } from '../types.js';

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const slice = collapsed.slice(0, 60);
  const last = slice.charCodeAt(slice.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? slice.slice(0, -1) : slice;
}

const dedupEngine: CompressionEngine = {
  id: 'dedup',
  priority: 3,
  lossless: true,
  targets: ['messages', 'tool-results'],
  configSchema: z.object({
    enabled: z.boolean(),
    minBlockChars: z.number().int().min(1).default(80),
    minBlockLines: z.number().int().min(1).default(3),
  }).passthrough(),
  apply({ messages, config, context }) {
    const minChars = typeof config.minBlockChars === 'number' ? config.minBlockChars : 80;
    const minLines = typeof config.minBlockLines === 'number' ? config.minBlockLines : 3;
    const seen = new Map<string, string[]>();
    let blocksReplaced = 0;

    const output = messages.map((message, index) => {
      const content = textContent(message);
      if (
        content == null
        || message.role === 'system'
        || context.frozenMessageIndexes.has(index)
      ) return message;

      const parts = content.split(/(\n{2,})/);
      const next = parts.map((part, partIndex) => {
        if (partIndex % 2 === 1) return part;
        const lineCount = part.split('\n').length;
        if (part.length < minChars || lineCount < minLines) return part;
        const digest = hash(part);
        const bucket = seen.get(digest) ?? [];
        const exact = bucket.find(candidate => candidate === part);
        if (exact !== undefined) {
          blocksReplaced += 1;
          return `[repeated from earlier in this conversation: ${preview(part)}…]`;
        }
        // Protected content may seed exact-match deduplication because the
        // original copy stays in context; first occurrences remain untouched.
        bucket.push(part);
        seen.set(digest, bucket);
        return part;
      }).join('');
      return next === content ? message : withTextContent(message, next);
    });

    return { messages: output, details: { blocksReplaced } };
  },
};

registerEngine(dedupEngine);
