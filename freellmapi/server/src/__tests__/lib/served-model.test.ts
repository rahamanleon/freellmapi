import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizeModelIdForDrift,
  observeServedModel,
  resetServedModelObservations,
} from '../../lib/served-model.js';

// Served-model drift guard (#534 follow-up): the proxy overwrites the
// upstream `model` field before the caller sees it, which also destroys the
// only evidence when a provider silently serves a DIFFERENT model than the
// one requested (kilo-auto/small serving Gemma, etc.). This module compares
// the captured raw upstream value against the routed id, ignoring cosmetic
// spelling differences, and reports genuine drift once per tuple.

describe('normalizeModelIdForDrift', () => {
  it('ignores case differences', () => {
    expect(normalizeModelIdForDrift('Llama-3.3-70B-Versatile'))
      .toBe(normalizeModelIdForDrift('llama-3.3-70b-versatile'));
  });

  it('ignores a provider/org prefix', () => {
    expect(normalizeModelIdForDrift('meta-llama/llama-3.3-70b-versatile'))
      .toBe(normalizeModelIdForDrift('llama-3.3-70b-versatile'));
    // Multi-segment namespaces too (@cf/meta/...).
    expect(normalizeModelIdForDrift('@cf/meta/llama-3.1-8b-instruct'))
      .toBe(normalizeModelIdForDrift('llama-3.1-8b-instruct'));
  });

  it('ignores a ":free"-style pricing-tier suffix', () => {
    expect(normalizeModelIdForDrift('gemma-3-27b-it:free'))
      .toBe(normalizeModelIdForDrift('gemma-3-27b-it'));
  });

  it('ignores separator spelling (underscore vs hyphen vs space)', () => {
    expect(normalizeModelIdForDrift('qwen3_coder 480b'))
      .toBe(normalizeModelIdForDrift('qwen3-coder-480b'));
  });

  it('keeps genuinely different ids distinct', () => {
    expect(normalizeModelIdForDrift('kilo-auto/small'))
      .not.toBe(normalizeModelIdForDrift('google/gemma-3-27b-it'));
    expect(normalizeModelIdForDrift('llama-3.3-70b-versatile'))
      .not.toBe(normalizeModelIdForDrift('llama-3.1-8b-instant'));
  });
});

describe('observeServedModel', () => {
  beforeEach(() => {
    resetServedModelObservations();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the raw served id and warns on genuine drift', () => {
    const served = observeServedModel({
      platform: 'kilo', requestedModel: 'kilo-auto/small', servedModel: 'google/gemma-3-27b-it',
    });
    expect(served).toBe('google/gemma-3-27b-it');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0])
      .toContain('[ServedModel] platform=kilo requested=kilo-auto/small served=google/gemma-3-27b-it');
  });

  it('warns only once per (platform, requested, served) tuple', () => {
    for (let i = 0; i < 3; i++) {
      observeServedModel({ platform: 'kilo', requestedModel: 'kilo-auto/small', servedModel: 'google/gemma-3-27b-it' });
    }
    expect(console.warn).toHaveBeenCalledTimes(1);
    // A different tuple gets its own single warn.
    observeServedModel({ platform: 'kilo', requestedModel: 'kilo-auto/free', servedModel: 'google/gemma-3-27b-it' });
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('returns null for cosmetically-equal ids (case / prefix / tier suffix)', () => {
    expect(observeServedModel({
      platform: 'groq', requestedModel: 'llama-3.3-70b-versatile', servedModel: 'Meta-Llama/Llama-3.3-70B-Versatile:free',
    })).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns null for identical ids', () => {
    expect(observeServedModel({
      platform: 'groq', requestedModel: 'llama-3.3-70b-versatile', servedModel: 'llama-3.3-70b-versatile',
    })).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns null for missing or placeholder upstream values', () => {
    expect(observeServedModel({ platform: 'reka', requestedModel: 'reka-flash-3', servedModel: null })).toBeNull();
    expect(observeServedModel({ platform: 'reka', requestedModel: 'reka-flash-3', servedModel: undefined })).toBeNull();
    // Reka returns the literal placeholder "default" for every concrete model
    // (#568) — it names no model, so it is no evidence of drift.
    expect(observeServedModel({ platform: 'reka', requestedModel: 'reka-flash-3', servedModel: 'default' })).toBeNull();
    expect(observeServedModel({ platform: 'reka', requestedModel: 'reka-flash-3', servedModel: '  ' })).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
