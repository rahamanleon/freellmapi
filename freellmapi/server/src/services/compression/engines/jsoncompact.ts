import { z } from 'zod';
import { registerEngine } from '../registry.js';
import { textContent, withTextContent } from '../helpers.js';
import type { CompressionEngine } from '../types.js';

const HEADER_RE = /\[\[json-table:v1 columns=(\[[^\n]+\]) rows=(\d+)\]\]\n([\s\S]*?)\n\[\[\/json-table\]\]/g;

function uniformKeys(value: unknown, minRows: number): { rows: Record<string, unknown>[]; keys: string[] } | null {
  if (!Array.isArray(value) || value.length < minRows) return null;
  if (!value.every(row => row != null && typeof row === 'object' && !Array.isArray(row))) return null;
  const rows = value as Record<string, unknown>[];
  const keys = Object.keys(rows[0]);
  if (keys.length === 0) return null;
  const signature = [...keys].sort().join('\u0000');
  if (!rows.every(row => Object.keys(row).length === keys.length && [...Object.keys(row)].sort().join('\u0000') === signature)) {
    return null;
  }
  return { rows, keys };
}

export function encodeJsonTable(value: unknown, minRows = 8): string | null {
  const table = uniformKeys(value, minRows);
  if (!table) return null;
  const body = table.rows.map(row => JSON.stringify(table.keys.map(key => row[key]))).join('\n');
  return `[[json-table:v1 columns=${JSON.stringify(table.keys)} rows=${table.rows.length}]]\n${body}\n[[/json-table]]`;
}

export function decodeJsonTables(text: string): string {
  return text.replace(HEADER_RE, (full, rawColumns: string, rawCount: string, rawRows: string) => {
    try {
      const columns = JSON.parse(rawColumns) as string[];
      const rows = rawRows.split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown[]);
      if (rows.length !== Number(rawCount) || !rows.every(row => row.length === columns.length)) return full;
      return JSON.stringify(rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))));
    } catch {
      return full;
    }
  });
}

interface ArrayCandidate {
  start: number;
  end: number;
  value: unknown;
}

function jsonArrayCandidates(text: string): ArrayCandidate[] {
  const spans: Array<{ start: number; end: number }> = [];
  const stack: Array<{ opener: '[' | '{'; start: number }> = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && stack.length > 0) {
      inString = true;
      continue;
    }
    if (char === '[' || char === '{') {
      stack.push({ opener: char, start: index });
      continue;
    }
    if (char !== ']' && char !== '}') continue;

    const expected = char === ']' ? '[' : '{';
    const opened = stack.pop();
    if (!opened || opened.opener !== expected) {
      stack.length = 0;
      continue;
    }
    if (opened.opener === '[') spans.push({ start: opened.start, end: index + 1 });
  }

  // Parse the largest candidates first so a useful outer table wins over its
  // nested arrays. Bounds keep valid-but-pathological nesting from turning
  // parsing into quadratic work after the linear structural scan.
  spans.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const candidates: ArrayCandidate[] = [];
  const parseCharBudget = Math.max(text.length * 4, 100_000);
  let parsedChars = 0;
  for (const span of spans) {
    const size = span.end - span.start;
    if (candidates.length >= 512 || parsedChars + size > parseCharBudget) break;
    parsedChars += size;
    try {
      candidates.push({
        ...span,
        value: JSON.parse(text.slice(span.start, span.end)),
      });
    } catch {
      // Structurally balanced text is not necessarily valid JSON.
    }
  }
  return candidates;
}

function compactText(text: string, minRows: number): { text: string; tables: number } {
  const candidates = jsonArrayCandidates(text);
  let output = text;
  let tables = 0;
  const used: Array<{ start: number; end: number }> = [];
  for (const candidate of candidates) {
    if (used.some(range => candidate.start < range.end && candidate.end > range.start)) continue;
    const encoded = encodeJsonTable(candidate.value, minRows);
    const original = text.slice(candidate.start, candidate.end);
    if (!encoded || encoded.length >= original.length) continue;
    used.push({ start: candidate.start, end: candidate.end });
    tables += 1;
  }
  for (const range of used.sort((a, b) => b.start - a.start)) {
    const candidate = candidates.find(item => item.start === range.start && item.end === range.end)!;
    output = output.slice(0, range.start) + encodeJsonTable(candidate.value, minRows)! + output.slice(range.end);
  }
  return { text: output, tables };
}

const jsonCompactEngine: CompressionEngine = {
  id: 'jsoncompact',
  priority: 15,
  lossless: true,
  targets: ['tool-results'],
  configSchema: z.object({
    enabled: z.boolean(),
    minRows: z.number().int().min(2).default(8),
  }).passthrough(),
  apply({ messages, config, context }) {
    const minRows = typeof config.minRows === 'number' ? config.minRows : 8;
    let tables = 0;
    const output = messages.map((message, index) => {
      const content = textContent(message);
      if (message.role !== 'tool' || content == null || context.frozenMessageIndexes.has(index)) return message;
      const compacted = compactText(content, minRows);
      tables += compacted.tables;
      return compacted.text === content ? message : withTextContent(message, compacted.text);
    });
    return { messages: output, details: { tables } };
  },
};

registerEngine(jsonCompactEngine);
