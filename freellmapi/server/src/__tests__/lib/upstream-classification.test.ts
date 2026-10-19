import { describe, it, expect } from 'vitest';
import { isUpstreamClassificationOutput } from '../../lib/error-classify.js';

/**
 * #809: kilo's free relay sometimes answers with a bare "safe"/"unsafe" — an
 * upstream content filter's verdict standing in for the model's reply. The
 * surfaces treat that as an empty completion and fail over.
 *
 * The rule is deliberately scoped to that relay. "safe"/"unsafe" is a perfectly
 * valid one-word answer for moderation and guard-model work, so firing it on
 * every platform would discard correct responses and burn the whole fallback
 * chain for anyone doing classification.
 */
describe('isUpstreamClassificationOutput (#809)', () => {
  it('flags a bare classification verdict from the kilo relay', () => {
    expect(isUpstreamClassificationOutput('safe', 'kilo')).toBe(true);
    expect(isUpstreamClassificationOutput('unsafe', 'kilo')).toBe(true);
  });

  it('ignores surrounding whitespace and case', () => {
    expect(isUpstreamClassificationOutput('  Safe \n', 'kilo')).toBe(true);
    expect(isUpstreamClassificationOutput('UNSAFE', 'kilo')).toBe(true);
  });

  it('leaves the same answer alone on every other platform', () => {
    // A moderation/guard workload legitimately answering one word must survive.
    for (const platform of ['groq', 'cerebras', 'openrouter', 'custom', 'gemini']) {
      expect(isUpstreamClassificationOutput('safe', platform)).toBe(false);
      expect(isUpstreamClassificationOutput('unsafe', platform)).toBe(false);
    }
  });

  it('does not fire when the platform is unknown', () => {
    expect(isUpstreamClassificationOutput('safe')).toBe(false);
    expect(isUpstreamClassificationOutput('safe', '')).toBe(false);
    expect(isUpstreamClassificationOutput('safe', undefined)).toBe(false);
  });

  it('matches the platform case-insensitively', () => {
    expect(isUpstreamClassificationOutput('safe', 'Kilo')).toBe(true);
  });

  it('leaves a real answer that merely contains the word alone', () => {
    expect(isUpstreamClassificationOutput('This code is safe to run.', 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput('safe mode', 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput('unsafe: buffer overflow on line 12', 'kilo')).toBe(false);
  });

  it('ignores empty and non-string content', () => {
    expect(isUpstreamClassificationOutput('', 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput(null, 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput(undefined, 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput(42, 'kilo')).toBe(false);
  });
});
