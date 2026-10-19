import { describe, it, expect } from 'vitest';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import {
  splitThinkTag,
  extractThinkFromMessage,
  ThinkTagStreamFilter,
  extractThinkTagsFromStream,
} from '../../lib/think-tags.js';

describe('splitThinkTag (non-streaming)', () => {
  it('extracts a leading <think> block into reasoning', () => {
    expect(splitThinkTag('<think>plan the answer</think>Hello!')).toEqual({
      content: 'Hello!',
      reasoning: 'plan the answer',
    });
  });

  it('tolerates whitespace before the opening tag and after the closing tag', () => {
    expect(splitThinkTag('\n <think>hmm</think>\n\nAnswer')).toEqual({
      content: 'Answer',
      reasoning: 'hmm',
    });
  });

  it('leaves a message without an opening tag untouched', () => {
    expect(splitThinkTag('Just a normal answer.')).toEqual({
      content: 'Just a normal answer.',
      reasoning: '',
    });
  });

  it('does NOT extract a tag quoted mid-answer (start-anchored on purpose)', () => {
    const text = 'The model emits <think>…</think> around its reasoning.';
    expect(splitThinkTag(text)).toEqual({ content: text, reasoning: '' });
  });

  it('unclosed tag: the whole body becomes reasoning, nothing is lost', () => {
    expect(splitThinkTag('<think>ran out of tokens mid-thought')).toEqual({
      content: '',
      reasoning: 'ran out of tokens mid-thought',
    });
  });

  it('extracts only the FIRST block; later literal tags stay in content', () => {
    expect(splitThinkTag('<think>a</think>x <think>b</think> y')).toEqual({
      content: 'x <think>b</think> y',
      reasoning: 'a',
    });
  });
});

describe('extractThinkFromMessage', () => {
  it('moves the block into reasoning_content in place', () => {
    const msg: { content?: unknown; reasoning_content?: string } = { content: '<think>why</think>because' };
    extractThinkFromMessage(msg);
    expect(msg.content).toBe('because');
    expect(msg.reasoning_content).toBe('why');
  });

  it('appends to a provider-set reasoning_content instead of clobbering it', () => {
    const msg = { content: '<think>more</think>ok', reasoning_content: 'native' };
    extractThinkFromMessage(msg);
    expect(msg.content).toBe('ok');
    expect(msg.reasoning_content).toBe('native\nmore');
  });

  it('is a no-op for tag-free content and non-string content', () => {
    const plain = { content: 'hello', reasoning_content: undefined as string | undefined };
    extractThinkFromMessage(plain);
    expect(plain).toEqual({ content: 'hello', reasoning_content: undefined });

    const nullContent: { content?: unknown; reasoning_content?: string } = { content: null };
    extractThinkFromMessage(nullContent);
    expect(nullContent.content).toBeNull();
  });
});

describe('ThinkTagStreamFilter (chunk-boundary handling)', () => {
  it('handles the opening tag split across pushes', () => {
    const f = new ThinkTagStreamFilter();
    expect(f.push('<thi')).toEqual({ content: '', reasoning: '' });
    expect(f.push('nk>deep')).toEqual({ content: '', reasoning: 'deep' });
    expect(f.push(' thought</think>Answer')).toEqual({ content: 'Answer', reasoning: ' thought' });
    expect(f.flush()).toEqual({ content: '', reasoning: '' });
  });

  it('handles the closing tag split across pushes', () => {
    const f = new ThinkTagStreamFilter();
    expect(f.push('<think>abc</thi')).toEqual({ content: '', reasoning: 'abc' });
    expect(f.push('nk>Done')).toEqual({ content: 'Done', reasoning: '' });
  });

  it('a lone "<" mid-reasoning is held then released as reasoning', () => {
    const f = new ThinkTagStreamFilter();
    expect(f.push('<think>a <')).toEqual({ content: '', reasoning: 'a ' });
    expect(f.push('b')).toEqual({ content: '', reasoning: '<b' });
  });

  it('unclosed tag at stream end: held partial close-tag bytes flush as reasoning', () => {
    const f = new ThinkTagStreamFilter();
    expect(f.push('<think>abc</thi')).toEqual({ content: '', reasoning: 'abc' });
    expect(f.flush()).toEqual({ content: '', reasoning: '</thi' });
  });

  it('an undecided opening prefix at stream end flushes as content (text never lost)', () => {
    const f = new ThinkTagStreamFilter();
    expect(f.push('<thi')).toEqual({ content: '', reasoning: '' });
    expect(f.flush()).toEqual({ content: '<thi', reasoning: '' });
  });

  it('passes non-think text through immediately (no buffering after decision)', () => {
    const f = new ThinkTagStreamFilter();
    expect(f.push('Hello')).toEqual({ content: 'Hello', reasoning: '' });
    // Once decided, even literal tags stream straight through.
    expect(f.push(' <think>x</think>')).toEqual({ content: ' <think>x</think>', reasoning: '' });
  });
});

function chunk(delta: Record<string, unknown>, finish: string | null = null): ChatCompletionChunk {
  return {
    id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm',
    choices: [{ index: 0, delta: delta as ChatCompletionChunk['choices'][0]['delta'], finish_reason: finish }],
  };
}

async function* gen(chunks: ChatCompletionChunk[]): AsyncGenerator<ChatCompletionChunk> {
  for (const c of chunks) yield c;
}

async function collect(source: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of source) out.push(c);
  return out;
}

describe('extractThinkTagsFromStream', () => {
  it('rewrites think content into delta.reasoning_content across split chunks', async () => {
    const out = await collect(extractThinkTagsFromStream(gen([
      chunk({ role: 'assistant' }),
      chunk({ content: '<think>rea' }),
      chunk({ content: 'soning</th' }),
      chunk({ content: 'ink>Answer' }),
      chunk({}, 'stop'),
    ])));
    const reasoning = out.map(c => c.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    const content = out.map(c => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(reasoning).toBe('reasoning');
    expect(content).toBe('Answer');
  });

  it('leaves tag-free streams untouched (fast path)', async () => {
    const src = [chunk({ content: 'Hello ' }), chunk({ content: 'world' }), chunk({}, 'stop')];
    const out = await collect(extractThinkTagsFromStream(gen(src)));
    expect(out).toHaveLength(3);
    expect(out[0].choices[0].delta.content).toBe('Hello ');
    expect(out[0].choices[0].delta.reasoning_content).toBeUndefined();
    expect(out[1].choices[0].delta.content).toBe('world');
  });

  it('unclosed tag at stream end: held bytes flush as a final reasoning chunk', async () => {
    const out = await collect(extractThinkTagsFromStream(gen([
      chunk({ content: '<think>abc</thi' }),
      chunk({}, 'length'),
    ])));
    const tail = out[out.length - 1];
    expect(tail.choices[0].delta.reasoning_content).toBe('</thi');
    const reasoning = out.map(c => c.choices?.[0]?.delta?.reasoning_content ?? '').join('');
    expect(reasoning).toBe('abc</thi');
    expect(out.map(c => c.choices?.[0]?.delta?.content ?? '').join('')).toBe('');
  });

  it('an undecided opening prefix flushes as a final content chunk', async () => {
    const out = await collect(extractThinkTagsFromStream(gen([
      chunk({ content: '<thi' }),
      chunk({}, 'stop'),
    ])));
    const tail = out[out.length - 1];
    expect(tail.choices[0].delta.content).toBe('<thi');
    expect(tail.choices[0].delta.reasoning_content).toBeUndefined();
  });

  it('passes non-content frames (tool calls, usage) through untouched', async () => {
    const toolChunk = chunk({ tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] });
    const usageChunk = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } as unknown as ChatCompletionChunk;
    const out = await collect(extractThinkTagsFromStream(gen([toolChunk, usageChunk, chunk({}, 'tool_calls')])));
    expect(out[0]).toBe(toolChunk);
    expect(out[1]).toBe(usageChunk);
  });
});
