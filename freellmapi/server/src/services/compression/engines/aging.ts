import { z } from 'zod';
import { registerEngine } from '../registry.js';
import { scanProtectedSpans } from '../preservation.js';
import { textContent, withTextContent } from '../helpers.js';
import type { CompressionEngine } from '../types.js';

function condense(text: string): string {
  const lines = text.split('\n');
  const intent = lines.filter(line => /\b(?:need|want|must|should|decid|implement|fix|change|because)\b/i.test(line)).slice(0, 4);
  const protectedValues = [...new Set(scanProtectedSpans(text).map(span => span.text))];
  const lead = lines.find(line => line.trim())?.trim().slice(0, 240) ?? '';
  const pieces = [...new Set([lead, ...intent.map(line => line.trim()), ...protectedValues].filter(Boolean))];
  return `[compressed older turn]\n${pieces.join('\n')}`;
}

const agingEngine: CompressionEngine = {
  id: 'aging',
  priority: 30,
  lossless: false,
  targets: ['messages'],
  configSchema: z.object({
    enabled: z.boolean(),
    liveTurns: z.number().int().min(1).default(3),
    condenseAfterTurns: z.number().int().min(2).default(8),
  }).passthrough(),
  apply({ messages, config, context }) {
    const liveTurns = typeof config.liveTurns === 'number' ? config.liveTurns : 3;
    const condenseAfter = Math.max(
      liveTurns + 1,
      typeof config.condenseAfterTurns === 'number' ? config.condenseAfterTurns : 8,
    );
    let distance = 0;
    const distances = new Array<number>(messages.length);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      distances[index] = distance;
      if (messages[index].role === 'user') distance += 1;
    }
    let messagesCondensed = 0;
    const output = messages.map((message, index) => {
      const content = textContent(message);
      if (
        content == null
        || message.role === 'system'
        || message.role === 'tool'
        || message.tool_calls?.length
        || distances[index] < condenseAfter
        || context.frozenMessageIndexes.has(index)
      ) return message;
      const next = condense(content);
      if (next.length >= content.length) return message;
      messagesCondensed += 1;
      return withTextContent(message, next);
    });
    return { messages: output, details: { messagesCondensed } };
  },
};

registerEngine(agingEngine);
