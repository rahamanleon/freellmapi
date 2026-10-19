import { describe, expect, it } from 'vitest';
import { parseKeysFromFile, parseModelList } from '../../lib/key-parser.js';

// #382: a paste can declare the models a custom endpoint serves next to its
// key, either as CUSTOM_<n>_MODELS beside the paired CUSTOM_<n>_* lines or as
// <PREFIX>_CUSTOM_MODELS beside <PREFIX>_BASE_URL + <PREFIX>_API_KEY/_KEY.

describe('parseModelList (#382)', () => {
  it('splits on commas and strips trailing capability suffixes', () => {
    expect(parseModelList('llama3, qwen3-TOOLS,pixtral-VISION')).toEqual([
      { id: 'llama3' },
      { id: 'qwen3', supportsTools: true },
      { id: 'pixtral', supportsVision: true },
    ]);
  });

  it('accepts both suffixes in either order', () => {
    expect(parseModelList('m1-TOOLS-VISION,m2-VISION-TOOLS')).toEqual([
      { id: 'm1', supportsTools: true, supportsVision: true },
      { id: 'm2', supportsTools: true, supportsVision: true },
    ]);
  });

  it('never touches a TOOLS/VISION that is not trailing', () => {
    expect(parseModelList('qwen-TOOLS-preview,llama-VISION-8b')).toEqual([
      { id: 'qwen-TOOLS-preview' },
      { id: 'llama-VISION-8b' },
    ]);
  });

  it('treats lowercase suffixes as part of the model id', () => {
    expect(parseModelList('devstral-tools,moondream-vision')).toEqual([
      { id: 'devstral-tools' },
      { id: 'moondream-vision' },
    ]);
  });

  it('drops blanks and dedupes ids after stripping', () => {
    expect(parseModelList('a, ,a-TOOLS,')).toEqual([{ id: 'a' }]);
  });
});

describe('model lists in .env pastes (#382)', () => {
  it('attaches CUSTOM_<n>_MODELS to its own endpoint only', () => {
    const env = [
      'CUSTOM_1_BASE_URL=http://relay-a.example/v1',
      'CUSTOM_1_KEY=sk-a',
      'CUSTOM_1_MODELS=llama3,qwen3-TOOLS',
      'CUSTOM_2_BASE_URL=http://relay-b.example/v1',
      'CUSTOM_2_KEY=sk-b',
    ].join('\n');
    const result = parseKeysFromFile(env, 'keys.env');
    expect(result.keys).toEqual([
      {
        rawKey: 'CUSTOM_1_KEY=sk-a',
        prefix: 'CUSTOM_',
        platform: 'custom',
        baseUrl: 'http://relay-a.example/v1',
        models: [{ id: 'llama3' }, { id: 'qwen3', supportsTools: true }],
      },
      {
        rawKey: 'CUSTOM_2_KEY=sk-b',
        prefix: 'CUSTOM_',
        platform: 'custom',
        baseUrl: 'http://relay-b.example/v1',
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('folds <PREFIX>_BASE_URL + <PREFIX>_API_KEY + <PREFIX>_CUSTOM_MODELS into a custom endpoint', () => {
    const env = [
      'MYRELAY_BASE_URL=http://myrelay.example/v1',
      'MYRELAY_API_KEY=sk-relay',
      'MYRELAY_CUSTOM_MODELS=deepseek-v3,text-embedding-qwen',
    ].join('\n');
    const result = parseKeysFromFile(env, 'keys.env');
    expect(result.keys).toEqual([
      expect.objectContaining({
        rawKey: 'MYRELAY_API_KEY=sk-relay',
        platform: 'custom',
        baseUrl: 'http://myrelay.example/v1',
        models: [{ id: 'deepseek-v3' }, { id: 'text-embedding-qwen' }],
      }),
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('accepts <PREFIX>_KEY as the key spelling', () => {
    const env = [
      'MYRELAY_BASE_URL=http://myrelay.example/v1',
      'MYRELAY_KEY=sk-relay',
      'MYRELAY_CUSTOM_MODELS=deepseek-v3',
    ].join('\n');
    const result = parseKeysFromFile(env, 'keys.env');
    expect(result.keys).toEqual([
      expect.objectContaining({
        platform: 'custom',
        baseUrl: 'http://myrelay.example/v1',
        models: [{ id: 'deepseek-v3' }],
      }),
    ]);
  });

  it('leaves a <PREFIX>_BASE_URL pair alone when no models line makes it endpoint-defining', () => {
    const env = [
      'MYRELAY_BASE_URL=http://myrelay.example/v1',
      'MYRELAY_API_KEY=sk-relay',
    ].join('\n');
    const result = parseKeysFromFile(env, 'keys.env');
    expect(result.keys.every(k => k.platform !== 'custom')).toBe(true);
  });

  it('consumes and reports a models line with nothing to attach to', () => {
    const env = [
      'CUSTOM_1_MODELS=llama3',
      'ORPHAN_CUSTOM_MODELS=qwen',
    ].join('\n');
    const result = parseKeysFromFile(env, 'keys.env');
    // The list values must never fall through and be mistaken for key material.
    expect(result.keys).toEqual([]);
    expect(result.skipped).toEqual([
      expect.stringContaining('CUSTOM_1_MODELS'),
      expect.stringContaining('ORPHAN_CUSTOM_MODELS'),
    ]);
  });
});
