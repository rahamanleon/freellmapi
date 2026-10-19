import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

// Inline `<think>…</think>` extraction (DeepSeek-style reasoning models).
//
// Some models serialize their reasoning trace INTO `content` as a leading
// `<think>…</think>` block instead of the separate `reasoning_content` field
// other providers use (Z.ai, Ollama, Gemini thought parts — all already
// normalized elsewhere). Forwarding the tags verbatim makes downstream tools
// render thinking as answer text. This module splits it back out into the
// OpenAI-convention `reasoning_content` field (non-streaming) and
// `delta.reasoning_content` chunks (streaming).
//
// Deliberately conservative: only a `<think>` that OPENS the message (after
// optional whitespace) starts extraction — a model *quoting* the literal tag
// mid-answer is left untouched. Once the block closes, everything after it is
// passed through verbatim (no re-arming), so at most one block per message is
// extracted. Matching is exact and lowercase — the only spelling observed live.
//
// Streaming buffer strategy (the tag can split across chunk boundaries):
//  - 'lead': holds at most leading whitespace plus a strict prefix of
//    `<think>` (7 chars); decides passthrough the moment a byte diverges.
//  - 'thinking': emits reasoning incrementally, holding back only the longest
//    trailing run that is a strict prefix of `</think>` (≤ 7 chars).
//  - 'passthrough': zero-copy.
// The whole stream is never buffered. An unclosed tag at stream end flushes
// the held bytes as reasoning; an undecided lead buffer (e.g. a message that
// is just "<thi") flushes as content — text is never lost.

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';
// A lead buffer longer than this cannot plausibly be "whitespace before
// <think>" — bail to passthrough so a pathological all-whitespace stream
// can't grow the hold buffer unboundedly.
const MAX_LEAD_HOLD = 512;

export interface ThinkSplit {
  content: string;
  reasoning: string;
}

/** Length of the longest suffix of `s` that is a strict prefix of `tag`. */
function partialTagSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (s.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

type FilterState = 'lead' | 'thinking' | 'afterClose' | 'passthrough';

export class ThinkTagStreamFilter {
  private state: FilterState = 'lead';
  // 'lead': optional whitespace + a strict prefix of OPEN_TAG.
  // 'thinking': a strict prefix of CLOSE_TAG.
  // Other states: always empty.
  private pending = '';

  /** Feed a text delta; returns the content/reasoning to emit for it. */
  push(text: string): ThinkSplit {
    let content = '';
    let reasoning = '';
    let input = this.pending + text;
    this.pending = '';

    while (input.length > 0) {
      if (this.state === 'lead') {
        const trimmed = input.replace(/^\s+/, '');
        if (trimmed.length === 0) {
          // All whitespace so far — could still precede a tag. Hold (bounded).
          if (input.length > MAX_LEAD_HOLD) {
            this.state = 'passthrough';
            content += input;
          } else {
            this.pending = input;
          }
          input = '';
        } else if (trimmed.startsWith(OPEN_TAG)) {
          this.state = 'thinking';
          input = trimmed.slice(OPEN_TAG.length);
        } else if (OPEN_TAG.startsWith(trimmed)) {
          // Strict prefix of the tag — wait for the next delta to decide.
          this.pending = input;
          input = '';
        } else {
          // Provably not a think-opened message: everything is content.
          this.state = 'passthrough';
          content += input;
          input = '';
        }
      } else if (this.state === 'thinking') {
        const idx = input.indexOf(CLOSE_TAG);
        if (idx !== -1) {
          reasoning += input.slice(0, idx);
          input = input.slice(idx + CLOSE_TAG.length);
          this.state = 'afterClose';
        } else {
          const hold = partialTagSuffix(input, CLOSE_TAG);
          reasoning += input.slice(0, input.length - hold);
          this.pending = hold > 0 ? input.slice(input.length - hold) : '';
          input = '';
        }
      } else if (this.state === 'afterClose') {
        // Drop the whitespace models emit between `</think>` and the answer.
        const trimmed = input.replace(/^\s+/, '');
        if (trimmed.length > 0) this.state = 'passthrough';
        input = trimmed;
      } else {
        content += input;
        input = '';
      }
    }
    return { content, reasoning };
  }

  /** Stream ended: release whatever is held. Unclosed `<think>` flushes as
   *  reasoning; an undecided lead buffer flushes as content. */
  flush(): ThinkSplit {
    const held = this.pending;
    this.pending = '';
    if (this.state === 'thinking') {
      this.state = 'passthrough';
      return { content: '', reasoning: held };
    }
    this.state = 'passthrough';
    return { content: held, reasoning: '' };
  }
}

/** Non-streaming split of a complete message body. Returns the original text
 *  as `content` (reasoning: '') when the message doesn't open with `<think>`. */
export function splitThinkTag(text: string): ThinkSplit {
  const filter = new ThinkTagStreamFilter();
  const main = filter.push(text);
  const tail = filter.flush();
  return { content: main.content + tail.content, reasoning: main.reasoning + tail.reasoning };
}

/**
 * In-place extraction for a non-streaming choice message: moves a leading
 * `<think>…</think>` block out of `content` into `reasoning_content`
 * (appending when the provider already set one). No-op for messages without
 * an opening tag, so no-knob/no-tag responses are byte-identical.
 */
export function extractThinkFromMessage(msg: { content?: unknown; reasoning_content?: string }): void {
  if (typeof msg.content !== 'string' || !msg.content.includes(OPEN_TAG)) return;
  const { content, reasoning } = splitThinkTag(msg.content);
  if (reasoning.length === 0) return;
  msg.content = content;
  msg.reasoning_content = msg.reasoning_content && msg.reasoning_content.length > 0
    ? `${msg.reasoning_content}\n${reasoning}`
    : reasoning;
}

/**
 * Streaming wrapper: rewrites `choices[0].delta.content` through the filter,
 * emitting extracted reasoning as `delta.reasoning_content` on the same
 * chunk. Chunks without text (role preambles, tool_call deltas, usage frames,
 * native reasoning deltas) pass through untouched. When the source ends with
 * held bytes (unclosed tag / undecided prefix) a final synthetic chunk
 * carries them, so text is never lost.
 */
export async function* extractThinkTagsFromStream(
  source: AsyncGenerator<ChatCompletionChunk>,
): AsyncGenerator<ChatCompletionChunk> {
  const filter = new ThinkTagStreamFilter();
  let meta: { id: string; model: string; created: number } | null = null;

  for await (const chunk of source) {
    if (chunk?.id) meta = { id: chunk.id, model: chunk.model, created: chunk.created };
    const choice = chunk?.choices?.[0];
    const raw = choice?.delta?.content;
    if (typeof raw !== 'string' || raw.length === 0) {
      yield chunk;
      continue;
    }
    const { content, reasoning } = filter.push(raw);
    if (content === raw && reasoning.length === 0) {
      // Fast path (passthrough state): forward untouched.
      yield chunk;
      continue;
    }
    // Chunks are parsed fresh from JSON per SSE frame, so in-place mutation is
    // safe — same rationale as normalizeOutboundContent.
    choice.delta.content = content;
    if (reasoning.length > 0) {
      choice.delta.reasoning_content = choice.delta.reasoning_content
        ? choice.delta.reasoning_content + reasoning
        : reasoning;
    }
    yield chunk;
  }

  const tail = filter.flush();
  if (tail.content.length > 0 || tail.reasoning.length > 0) {
    yield {
      id: meta?.id ?? `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: meta?.created ?? Math.floor(Date.now() / 1000),
      model: meta?.model ?? '',
      choices: [{
        index: 0,
        delta: {
          ...(tail.content.length > 0 ? { content: tail.content } : {}),
          ...(tail.reasoning.length > 0 ? { reasoning_content: tail.reasoning } : {}),
        },
        finish_reason: null,
      }],
    };
  }
}
