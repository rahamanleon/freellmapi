import { z } from 'zod';
import { registerEngine } from '../registry.js';
import { hasProtectedContent } from '../preservation.js';
import { messageChars, textContent, withTextContent } from '../helpers.js';
import type { CompressionEngine } from '../types.js';

const hardBudgetEngine: CompressionEngine = {
  id: 'hard-budget',
  priority: 40,
  lossless: false,
  targets: ['messages', 'tool-results'],
  configSchema: z.object({ enabled: z.boolean() }).passthrough(),
  apply({ messages, context }) {
    const targetTokens = context.targetTokens;
    if (!targetTokens || messageChars(messages) <= targetTokens * 4) return { messages };
    const targetChars = targetTokens * 4;
    const output = [...messages];
    const candidates: Array<{ messageIndex: number; lineIndex: number; length: number; score: number }> = [];
    output.forEach((message, messageIndex) => {
      const content = textContent(message);
      if (content == null || message.role === 'system' || context.frozenMessageIndexes.has(messageIndex)) return;
      content.split('\n').forEach((line, lineIndex) => {
        if (!line.trim() || hasProtectedContent(line)) return;
        const recency = messageIndex / Math.max(1, output.length);
        const role = message.role === 'tool' ? 0.2 : message.role === 'assistant' ? 0.5 : 0.8;
        candidates.push({ messageIndex, lineIndex, length: line.length + 1, score: recency + role });
      });
    });
    const removed = new Map<number, Set<number>>();
    let currentChars = messageChars(output);
    for (const candidate of candidates.sort((a, b) => a.score - b.score || b.length - a.length)) {
      if (currentChars <= targetChars) break;
      const set = removed.get(candidate.messageIndex) ?? new Set<number>();
      set.add(candidate.lineIndex);
      removed.set(candidate.messageIndex, set);
      currentChars -= candidate.length;
    }
    let linesDropped = 0;
    for (const [messageIndex, indexes] of removed) {
      const message = output[messageIndex];
      const content = textContent(message)!;
      const kept = content.split('\n').filter((_line, lineIndex) => !indexes.has(lineIndex));
      linesDropped += indexes.size;
      output[messageIndex] = withTextContent(message, kept.join('\n'));
    }
    return { messages: output, details: { linesDropped, targetTokens } };
  },
};

registerEngine(hardBudgetEngine);
