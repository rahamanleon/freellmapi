import { z } from 'zod';
import { registerEngine } from '../registry.js';
import { hasProtectedContent } from '../preservation.js';
import { textContent, withTextContent } from '../helpers.js';
import type { CompressionEngine } from '../types.js';

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []));
}

function sentences(text: string): string[] {
  return text.match(/[^.!?\n]+(?:[.!?]+|$)|[^\n]+\n/g)?.filter(Boolean) ?? [text];
}

const relevanceEngine: CompressionEngine = {
  id: 'relevance',
  priority: 18,
  lossless: false,
  targets: ['messages'],
  configSchema: z.object({
    enabled: z.boolean(),
    maxChars: z.number().int().positive().default(18_000),
  }).passthrough(),
  apply({ messages, config, context }) {
    const maxChars = typeof config.maxChars === 'number' ? config.maxChars : 18_000;
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user' && typeof messages[index].content === 'string') {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex < 0) return { messages };
    const query = textContent(messages[lastUserIndex]) ?? '';
    const queryWords = words(query);
    if (queryWords.size === 0) return { messages };
    const eligible = messages
      .map((message, index) => ({ message, index, content: textContent(message) }))
      .filter(row =>
        row.content != null
        && row.index !== lastUserIndex
        && row.message.role !== 'system'
        && row.message.role !== 'tool'
        && !row.message.tool_calls?.length
        && !context.frozenMessageIndexes.has(row.index));
    const eligibleChars = eligible.reduce((sum, row) => sum + row.content!.length, 0);
    if (eligibleChars <= maxChars) return { messages };
    const perMessage = Math.max(240, Math.floor(maxChars / Math.max(1, eligible.length)));
    let sentencesDropped = 0;
    const output = [...messages];
    for (const row of eligible) {
      if (row.content!.length <= perMessage) continue;
      const units = sentences(row.content!).map((text, index) => {
        const overlap = [...words(text)].filter(word => queryWords.has(word)).length;
        return { text, index, score: hasProtectedContent(text) ? Number.POSITIVE_INFINITY : overlap };
      });
      const selected = new Set<number>();
      let used = 0;
      for (const unit of [...units].sort((a, b) => b.score - a.score || a.index - b.index)) {
        if (unit.score !== Number.POSITIVE_INFINITY && used + unit.text.length > perMessage) continue;
        selected.add(unit.index);
        used += unit.text.length;
      }
      const next = units.filter(unit => selected.has(unit.index)).map(unit => unit.text).join('').trim();
      if (next && next.length < row.content!.length) {
        sentencesDropped += units.length - selected.size;
        output[row.index] = withTextContent(row.message, next);
      }
    }
    return { messages: output, details: { sentencesDropped } };
  },
};

registerEngine(relevanceEngine);
