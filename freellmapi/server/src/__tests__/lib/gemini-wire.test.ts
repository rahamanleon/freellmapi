import { describe, expect, it } from 'vitest';
import {
  effortFromGeminiThinking,
  estimateGeminiTokens,
  geminiContentsToMessages,
  geminiPartsFromResult,
  geminiResponseFormat,
  geminiToolChoice,
  geminiToolsToChatTools,
  sanitizeForGemini,
} from '../../lib/gemini-wire.js';

describe('Gemini wire translation', () => {
  it('keeps text, images, function calls, and paired function responses', () => {
    const messages = geminiContentsToMessages({
      systemInstruction: { parts: [{ text: 'Use tools carefully.' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Inspect this image' },
            { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
          ],
        },
        {
          role: 'model',
          parts: [{
            functionCall: { id: 'call_read', name: 'read_file', args: { path: 'README.md' } },
            thoughtSignature: 'signed-thought',
          }],
        },
        {
          role: 'user',
          parts: [{
            functionResponse: { name: 'read_file', response: { content: 'hello' } },
          }],
        },
      ],
    });

    expect(messages[0]).toEqual({ role: 'system', content: 'Use tools carefully.' });
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{
        id: 'call_read',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        thought_signature: 'signed-thought',
      }],
    });
    expect(messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call_read',
      name: 'read_file',
      content: '{"content":"hello"}',
    });
  });

  it('maps tool declarations, tool choice, structured output, and thinking budgets', () => {
    expect(geminiToolsToChatTools([{
      functionDeclarations: [{
        name: 'write_file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    }])?.[0].function.name).toBe('write_file');
    expect(geminiToolChoice({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['write_file'] },
    })).toEqual({ type: 'function', function: { name: 'write_file' } });
    expect(geminiResponseFormat({
      responseMimeType: 'application/json',
      responseSchema: { type: 'object' },
    })).toEqual({
      type: 'json_schema',
      json_schema: { name: 'gemini_response', schema: { type: 'object' } },
    });
    expect(effortFromGeminiThinking({ thinkingConfig: { thinkingBudget: 8_000 } })).toBe('medium');
  });

  it('sanitizes unsupported schema keywords and emits Gemini function-call parts', () => {
    expect(sanitizeForGemini({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        value: {
          type: 'string',
          const: 'fixed',
          'x-private': true,
        },
      },
      additionalProperties: false,
    })).toEqual({
      type: 'object',
      properties: { value: { type: 'string' } },
    });

    expect(geminiPartsFromResult({
      text: 'Done',
      reasoning: 'Checking',
      toolCalls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"a.txt"}' },
      }],
    })).toEqual([
      { text: 'Checking', thought: true },
      { text: 'Done' },
      { functionCall: { id: 'call_1', name: 'write_file', args: { path: 'a.txt' } } },
    ]);
  });

  it('omits tool_choice entirely when the request has no toolConfig', () => {
    expect(geminiToolChoice(undefined)).toBeUndefined();
    expect(geminiToolChoice({})).toBeUndefined();
    expect(geminiToolChoice({ functionCallingConfig: { mode: 'AUTO' } })).toBe('auto');
  });

  it('treats thinkingBudget -1 as model-managed, not disabled', () => {
    expect(effortFromGeminiThinking({ thinkingConfig: { thinkingBudget: -1 } })).toBeUndefined();
    expect(effortFromGeminiThinking({ thinkingConfig: { thinkingBudget: 0 } })).toBe('none');
    expect(effortFromGeminiThinking({ thinkingConfig: { thinkingBudget: 2048 } })).toBe('low');
  });

  it('accepts parametersJsonSchema and normalizes the Gemini schema dialect', () => {
    const tools = geminiToolsToChatTools([{
      functionDeclarations: [{
        name: 'lookup',
        parametersJsonSchema: {
          type: 'OBJECT',
          properties: { city: { type: 'STRING', nullable: true } },
        },
      }],
    }]);
    expect(tools?.[0].function.parameters).toEqual({
      type: 'object',
      properties: { city: { type: ['string', 'null'] } },
    });
  });

  it('emits tool results before new user text and matches parallel same-name calls FIFO', () => {
    const messages = geminiContentsToMessages({
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'read', args: { path: 'a' } } },
            { functionCall: { name: 'read', args: { path: 'b' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            { text: 'Now continue.' },
            { functionResponse: { name: 'read', response: 'A' } },
            { functionResponse: { name: 'read', response: 'B' } },
          ],
        },
      ],
    });
    const assistant = messages[0];
    const toolIds = messages.filter(m => m.role === 'tool').map(m => m.tool_call_id);
    expect(assistant.tool_calls).toHaveLength(2);
    expect(toolIds).toEqual(assistant.tool_calls!.map(call => call.id));
    // Ordering: assistant, tool, tool, then the new user text.
    expect(messages.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
  });

  it('skips replayed thought parts and prices images per-image in estimates', () => {
    const messages = geminiContentsToMessages({
      contents: [{ role: 'model', parts: [{ text: 'internal reasoning', thought: true }, { text: 'visible' }] }],
    });
    expect(JSON.stringify(messages)).not.toContain('internal reasoning');

    const big = 'A'.repeat(400_000);
    const tokens = estimateGeminiTokens({
      contents: [{ role: 'user', parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: big } }] }],
    });
    expect(tokens).toBeLessThan(1000);
  });
});
