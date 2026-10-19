import { z } from 'zod';
import { registerEngine } from '../registry.js';
import { textContent, withTextContent } from '../helpers.js';
import { transformUnprotectedText } from '../preservation.js';
import type { CompressionEngine } from '../types.js';

const liteEngine: CompressionEngine = {
  id: 'lite',
  priority: 5,
  lossless: true,
  targets: ['messages', 'system', 'tool-results'],
  configSchema: z.object({ enabled: z.boolean() }).passthrough(),
  apply({ messages, context }) {
    const seenSystem = new Set<string>();
    let duplicateSystemMessages = 0;
    const output = messages.flatMap((message, index) => {
      const content = textContent(message);
      if (content == null || context.frozenMessageIndexes.has(index)) return [message];
      if (message.role === 'system') {
        if (seenSystem.has(content)) {
          duplicateSystemMessages += 1;
          return [];
        }
        seenSystem.add(content);
      }
      const next = transformUnprotectedText(content, part => part
        .replace(/[ \t]+$/gm, '')
        .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n'));
      return [next === content ? message : withTextContent(message, next)];
    });
    return { messages: output, details: { duplicateSystemMessages } };
  },
};

registerEngine(liteEngine);
