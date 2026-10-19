import { z } from 'zod';
import { registerEngine } from '../registry.js';
import { textContent, withTextContent } from '../helpers.js';
import type { CompressionEngine, ToolCallOrigin } from '../types.js';

const READ_TOOLS = new Set(['read', 'read_file', 'view', 'cat', 'open_file', 'get_file']);
const WRITE_TOOLS = new Set(['write', 'write_file', 'edit', 'str_replace_editor', 'apply_patch', 'replace']);
const PATH_KEYS = ['path', 'file_path', 'filepath', 'file', 'target'];

function commandPath(command: string): string | null {
  const match = command.match(/(?:^|[;&|]\s*)(?:cat|sed\s+-n\s+\S+|head(?:\s+-\S+)*|tail(?:\s+-\S+)*)\s+["']?([^"'|;&\n]+)["']?/);
  return match?.[1]?.trim() ?? null;
}

function originInfo(origin: ToolCallOrigin): { kind: 'read' | 'write'; path: string } | null {
  const name = origin.name.toLowerCase();
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(origin.arguments);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    // Shell tools often carry a plain command string.
  }
  const explicitPath = PATH_KEYS.map(key => args[key]).find(value => typeof value === 'string') as string | undefined;
  const command = typeof args.command === 'string' ? args.command : origin.arguments;
  const path = explicitPath ?? commandPath(command);
  if (!path) return null;
  if (READ_TOOLS.has(name) || /\b(?:cat|sed|head|tail)\b/.test(command)) return { kind: 'read', path };
  if (WRITE_TOOLS.has(name)) return { kind: 'write', path };
  return null;
}

const readLifecycleEngine: CompressionEngine = {
  id: 'read-lifecycle',
  priority: 6,
  lossless: false,
  targets: ['tool-results'],
  configSchema: z.object({ enabled: z.boolean() }).passthrough(),
  apply({ messages, context }) {
    const resultIndexes = new Map<string, number>();
    messages.forEach((message, index) => {
      if (message.role === 'tool' && message.tool_call_id) resultIndexes.set(message.tool_call_id, index);
    });
    const events = [...context.toolCallOrigins.values()]
      .map(origin => ({ origin, info: originInfo(origin), resultIndex: resultIndexes.get(origin.id) }))
      .filter((event): event is typeof event & { info: NonNullable<typeof event.info>; resultIndex: number } =>
        event.info != null && event.resultIndex != null)
      .sort((a, b) => a.origin.messageIndex - b.origin.messageIndex);

    const superseded = new Map<number, string>();
    events.forEach((event, index) => {
      if (event.info.kind !== 'read') return;
      const later = events.slice(index + 1).find(candidate => candidate.info.path === event.info.path);
      if (later) superseded.set(event.resultIndex, event.info.path);
    });

    let readsSuperseded = 0;
    const output = messages.map((message, index) => {
      const path = superseded.get(index);
      const content = textContent(message);
      if (!path || content == null || context.frozenMessageIndexes.has(index)) return message;
      readsSuperseded += 1;
      return withTextContent(message, `[read superseded — "${path}" was re-read or modified later]`);
    });
    return { messages: output, details: { readsSuperseded } };
  },
};

registerEngine(readLifecycleEngine);
