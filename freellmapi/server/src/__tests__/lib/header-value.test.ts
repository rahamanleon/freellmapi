import { describe, it, expect } from 'vitest';
import { validateHeaderValue } from 'node:http';
import { safeHeaderValue, routedViaValue } from '../../lib/header-value.js';

// #619: relay model ids are arbitrary text. Whatever comes out of here has to
// be something Node will actually put on the wire, or an already-successful
// upstream call dies while the response is being written.
describe('safeHeaderValue', () => {
  it('leaves an ordinary provider/model pair byte-identical', () => {
    expect(safeHeaderValue('groq/llama-3.3-70b-versatile')).toBe('groq/llama-3.3-70b-versatile');
    expect(safeHeaderValue('openrouter/meta-llama/llama-4-scout:free')).toBe('openrouter/meta-llama/llama-4-scout:free');
  });

  it('percent-encodes non-ASCII so the value survives as something decodable', () => {
    const encoded = safeHeaderValue('custom/我的模型[test] v2');
    expect(encoded).toBe('custom/%E6%88%91%E7%9A%84%E6%A8%A1%E5%9E%8B[test] v2');
    expect(decodeURIComponent(encoded)).toBe('custom/我的模型[test] v2');
  });

  it('encodes control characters, so a model id cannot inject a header line', () => {
    const encoded = safeHeaderValue('custom/evil\r\nX-Admin: yes');
    expect(encoded).toBe('custom/evil%0D%0AX-Admin: yes');
    expect(encoded).not.toContain('\r');
    expect(encoded).not.toContain('\n');
  });

  it('escapes a literal % so the encoding round-trips unambiguously', () => {
    expect(safeHeaderValue('custom/100%-free')).toBe('custom/100%25-free');
    expect(decodeURIComponent(safeHeaderValue('custom/100%-free'))).toBe('custom/100%-free');
  });

  it('encodes astral code points as one UTF-8 sequence, not broken halves', () => {
    expect(decodeURIComponent(safeHeaderValue('custom/🚀-turbo'))).toBe('custom/🚀-turbo');
  });

  it('survives a lone surrogate instead of throwing', () => {
    const encoded = safeHeaderValue('custom/\uD800-model');
    expect(() => validateHeaderValue('X-Routed-Via', encoded)).not.toThrow();
    expect(encoded).toContain('-model');
  });

  it('caps the length without ever cutting an escape sequence in half', () => {
    const capped = safeHeaderValue(`${'a'.repeat(255)}我`, 256);
    expect(capped).toBe('a'.repeat(255));
    expect(safeHeaderValue('a'.repeat(1000)).length).toBe(256);
    expect(safeHeaderValue('a'.repeat(1000), 1024).length).toBe(1000);
  });

  it('returns an empty string for empty or missing input', () => {
    expect(safeHeaderValue('')).toBe('');
    expect(safeHeaderValue(undefined as unknown as string)).toBe('');
  });

  it('produces a value Node accepts for every hostile shape', () => {
    const hostile = [
      '我的模型[test] v2',
      'модель/тест',
      'model\u0000null',
      'model\u007Fdel',
      'tab\there',
      'a'.repeat(4000),
      '日本語モデル（高速）',
      'emoji 🚀 model',
      '%not-an-escape',
    ];
    for (const raw of hostile) {
      const value = safeHeaderValue(`custom/${raw}`);
      expect(() => validateHeaderValue('X-Routed-Via', value)).not.toThrow();
      expect(value).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it('composes the routed-via value from platform and model', () => {
    expect(routedViaValue('groq', 'llama-3.3-70b')).toBe('groq/llama-3.3-70b');
    expect(decodeURIComponent(routedViaValue('custom', '我的模型'))).toBe('custom/我的模型');
  });
});
