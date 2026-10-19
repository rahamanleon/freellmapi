// Task-type-aware routing (#1127): lets a client declare what kind of work a
// request is (code vs chat) so the router can bias the bandit weights toward
// quality or speed. A coding turn is quality-sensitive — a weak model
// "completes" it with wrong code the user must manually verify; a chat turn is
// budget/speed-sensitive. The declared header is the strongest signal; when it
// is absent or `auto`, a cheap bounded rule derives the type from the request
// shape (tool-bearing requests → code; code markers in the last user message →
// code). The result is a SOFT preference: capability gates and the failover
// chain are untouched, and `undefined` means "leave the preset weights alone".

import type { Request } from 'express';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { contentToString } from './content.js';

export type TaskType = 'code' | 'chat' | 'auto';

export const TASK_TYPE_HEADER = 'x-freellm-task-type';

// Bounded scan so a huge user message never costs the router a full read.
const MAX_SCAN_CHARS = 4000;

/**
 * Markers that a turn is about code. Every one of these is SYNTAX, not
 * vocabulary: an earlier revision matched bare English words (`function`,
 * `class`, `cargo`, `docker`, `git`) and a bare `=>`, which classified
 * "What class of animals are dolphins?" and "Explain the function of the
 * mitochondria" as code. Auto-derivation is silent — the user never asked for
 * it — so it has to err toward `chat`: a missed code turn just routes the way
 * it always did, while a false positive quietly re-weights ordinary chat
 * traffic. Hence: a marker has to be something that essentially cannot occur
 * in prose.
 */
const CODE_MARKERS: readonly RegExp[] = [
  // Fenced code block (with or without a language tag).
  /```/,
  // Shell prompt at the start of a line, followed by a command-looking word.
  // The word gate keeps "$ 20 per seat" out.
  /^[ \t]*\$[ \t]+[a-z][\w./-]*(?=[ \t]|$)/m,
  // Declarations and definitions.
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
  /\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(/,
  /\bdef\s+[A-Za-z_]\w*\s*\(/,
  // `class Foo:` / `class Foo {` / `class Foo(Base)` at the start of a line,
  // or `class Foo extends Bar` anywhere. Bare "class" never matches.
  /^[ \t]*class\s+[A-Za-z_$][\w$]*\s*[({:]/m,
  /\bclass\s+[A-Za-z_$][\w$]*\s+extends\s+[A-Za-z_$][\w$]*/,
  // ES imports: `import {` , or an import whose source is a quoted module.
  /\bimport\s*\{/,
  /\bimport\s[^\n;]{0,200}?\bfrom\s*['"][^'"\n]+['"]/,
  // Python: `from x.y import z` at the start of a line.
  /^[ \t]*from\s+[A-Za-z_.][\w.]*\s+import\s+\S/m,
  /\brequire\s*\(\s*['"]/,
  /^[ \t]*#\s*include\s*[<"]/m,
  // A source file path next to a line number: `src/router.ts:214`.
  /\b[\w./-]+\.(?:[jt]sx?|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs|cpp|cc|hpp|sh|sql|css|scss|html|vue|svelte|ya?ml|json|toml)\s*:\s*\d+/,
  // Same, for the one-letter C extensions — the base name must start with a
  // letter so an enumerated prose clause ("4.c: twelve") cannot match.
  /\b[A-Za-z_][\w./-]*\.[ch]\s*:\s*\d+/,
  // Stack frames: V8 (`at fn (file.js:1:2)`), Python (`File "x.py", line 3`).
  /^\s*at\s+\S.*\(.*:\d+:\d+\)/m,
  /^\s*File\s+"[^"\n]+",\s*line\s+\d+/m,
  /\bTraceback\s+\(most recent call last\)/,
];

/** Read the client-declared task type from the request header (default 'auto'). */
export function parseTaskTypeHeader(req: Request): TaskType {
  const raw = req.headers[TASK_TYPE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim().toLowerCase();
  return trimmed === 'code' || trimmed === 'chat' || trimmed === 'auto' ? trimmed : 'auto';
}

/** True when `text` carries at least one unambiguous code marker. */
function hasCodeMarker(text: string): boolean {
  return CODE_MARKERS.some(re => re.test(text));
}

/** Derive a concrete task type from the request shape. Bounded, never throws. */
export function deriveTaskType(tools: unknown[] | undefined, messages: ChatMessage[] | undefined): 'code' | 'chat' {
  // Tool-bearing requests are overwhelmingly agent/coding turns.
  if (tools && tools.length > 0) return 'code';
  const lastUser = messages ? [...messages].reverse().find((m) => m.role === 'user') : undefined;
  const text = lastUser ? contentToString(lastUser.content) : '';
  if (text.length > 0 && hasCodeMarker(text.slice(0, MAX_SCAN_CHARS))) return 'code';
  return 'chat';
}

/**
 * Resolve the effective task bias for a request: the explicit header wins;
 * `auto` falls back to derivation. Returns undefined when there is no signal
 * worth biasing for — callers then leave the routing weights untouched, so the
 * default behaviour is unchanged. `auto` only ever biases UP toward `code`:
 * `chat` is the ordinary case, and silently re-weighting the bulk of traffic
 * in `auto` mode would defeat the point of an opt-in knob.
 */
export function resolveTaskType(
  req: Request,
  tools: unknown[] | undefined,
  messages: ChatMessage[] | undefined,
): 'code' | 'chat' | undefined {
  const declared = parseTaskTypeHeader(req);
  if (declared === 'code' || declared === 'chat') return declared;
  return deriveTaskType(tools, messages) === 'code' ? 'code' : undefined;
}
