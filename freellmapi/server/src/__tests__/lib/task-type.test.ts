import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { parseTaskTypeHeader, deriveTaskType, resolveTaskType, TASK_TYPE_HEADER } from '../../lib/task-type.js';

function reqWith(headerValue: string | undefined): Request {
  const headers: Record<string, string | string[] | undefined> = {};
  if (headerValue !== undefined) headers[TASK_TYPE_HEADER] = headerValue;
  return { headers } as unknown as Request;
}

describe('parseTaskTypeHeader', () => {
  it('reads an explicit code/chat declaration', () => {
    expect(parseTaskTypeHeader(reqWith('code'))).toBe('code');
    expect(parseTaskTypeHeader(reqWith('chat'))).toBe('chat');
  });

  it('treats the header as case-insensitive and trims whitespace', () => {
    expect(parseTaskTypeHeader(reqWith('  CODE '))).toBe('code');
    expect(parseTaskTypeHeader(reqWith('Chat'))).toBe('chat');
  });

  it('accepts an explicit auto and defaults to auto for anything else', () => {
    expect(parseTaskTypeHeader(reqWith('auto'))).toBe('auto');
    expect(parseTaskTypeHeader(reqWith('nonsense'))).toBe('auto');
    expect(parseTaskTypeHeader(reqWith(''))).toBe('auto');
    expect(parseTaskTypeHeader(reqWith(undefined))).toBe('auto');
  });

  it('takes the first value of a repeated header', () => {
    const req = { headers: { [TASK_TYPE_HEADER]: ['code', 'chat'] } } as unknown as Request;
    expect(parseTaskTypeHeader(req)).toBe('code');
  });
});

describe('deriveTaskType', () => {
  it('classifies a tool-bearing request as code', () => {
    expect(deriveTaskType([{ type: 'function' }], [{ role: 'user', content: 'hello' }])).toBe('code');
  });

  it('classifies a code-marked last user message as code', () => {
    const codeSamples = [
      '```python\nprint(1)\n```',
      'const x = 1;',
      'let total = items.length',
      'why does function parse(input) return null here?',
      'def build_index(rows):',
      'class Cache extends Map {',
      "import { render } from 'react-dom'",
      'from pathlib import Path',
      "const fs = require('fs')",
      '#include <stdio.h>',
      '$ npm run build fails on a clean checkout',
      'it blows up at server/src/services/router.ts:214',
      'crash in main.c:42',
      '    at handle (/app/dist/index.js:12:9)',
      'Traceback (most recent call last)',
      '  File "app/main.py", line 30',
    ];
    for (const sample of codeSamples) {
      expect(deriveTaskType(undefined, [{ role: 'user', content: sample }]), sample).toBe('code');
    }
  });

  it('does not mistake ordinary prose for code (#1127)', () => {
    // The derivation is silent, so it has to err toward chat: these all matched
    // the first revision's bare-word markers (function/class/cargo/docker/=>).
    const proseSamples = [
      'What class of animals are dolphins?',
      'Explain the function of the mitochondria.',
      'Summarize this article about cargo ships',
      'Can you refactor my morning routine to fit a gym session?',
      'Which method works best for brewing coffee at home?',
      'I want to import olive oil from Italy, what paperwork do I need?',
      'Write a short poem about a docker on the night shift',
      'Is git a common surname in Norway?',
      'The curl of a vector field, explained simply',
      'She teaches a class on Renaissance painting',
      'Chapter 4.c: what does the clause actually mean?',
      'Rent is $ 1400 a month, is that reasonable?',
    ];
    for (const sample of proseSamples) {
      expect(deriveTaskType(undefined, [{ role: 'user', content: sample }]), sample).toBe('chat');
    }
  });

  it('falls back to chat for plain text, even with earlier code messages', () => {
    expect(deriveTaskType(undefined, [{ role: 'user', content: 'what is the weather in Berlin?' }])).toBe('chat');
    // Only the LAST user message counts — a stale code block from a previous turn is not intent.
    expect(deriveTaskType(undefined, [
      { role: 'user', content: '```js\nconst a = 1;\n```' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks!' },
    ])).toBe('chat');
  });

  it('handles missing tools/messages and array content blocks', () => {
    expect(deriveTaskType(undefined, undefined)).toBe('chat');
    expect(deriveTaskType(undefined, [])).toBe('chat');
    expect(deriveTaskType(undefined, [{ role: 'user', content: [{ type: 'text', text: '```sql\nSELECT 1\n```' }] }])).toBe('code');
  });
});

describe('resolveTaskType', () => {
  it('explicit declaration always wins over derivation', () => {
    expect(resolveTaskType(reqWith('chat'), [{ type: 'function' }], [{ role: 'user', content: '```js\nx\n```' }])).toBe('chat');
    expect(resolveTaskType(reqWith('code'), undefined, [{ role: 'user', content: 'hi' }])).toBe('code');
  });

  it('auto derives code upward and stays undefined otherwise (preset weights untouched)', () => {
    expect(resolveTaskType(reqWith('auto'), undefined, [{ role: 'user', content: '```rust\nfn main() {}\n```' }])).toBe('code');
    expect(resolveTaskType(reqWith('auto'), [{ type: 'function' }], undefined)).toBe('code');
    expect(resolveTaskType(reqWith('auto'), undefined, [{ role: 'user', content: 'hello there' }])).toBeUndefined();
    expect(resolveTaskType(reqWith(undefined), undefined, [{ role: 'user', content: 'hello there' }])).toBeUndefined();
  });
});
