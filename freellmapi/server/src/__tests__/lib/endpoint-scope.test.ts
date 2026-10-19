import { describe, it, expect } from 'vitest';
import {
  endpointHandle,
  endpointRefMatches,
  endpointScopeForBaseUrl,
  modelStatsKey,
  normalizeBaseUrl,
  qualifiedModelMemberId,
} from '../../lib/endpoint-scope.js';

describe('endpoint scope (#651)', () => {
  it('normalizes a base_url the way registration stores it', () => {
    expect(normalizeBaseUrl('  https://relay.example.com/v1/  ')).toBe('https://relay.example.com/v1');
    expect(endpointScopeForBaseUrl(null)).toBe('');
    expect(endpointScopeForBaseUrl('')).toBe('');
  });

  it('derives a stable, typable handle from the endpoint alone', () => {
    expect(endpointHandle('https://relay-a.example.com/v1')).toBe('relay-a.example.com-v1');
    expect(endpointHandle('http://127.0.0.1:11434/v1')).toBe('127.0.0.1-11434-v1');
    // Idempotent, which is what lets a handle and the raw URL both resolve.
    expect(endpointHandle(endpointHandle('https://relay-a.example.com/v1')))
      .toBe(endpointHandle('https://relay-a.example.com/v1'));
    // Different endpoints never collapse onto one handle.
    expect(endpointHandle('https://relay-a.example.com/v1'))
      .not.toBe(endpointHandle('https://relay-b.example.com/v1'));
  });

  it('leaves catalog stat keys exactly as they were', () => {
    expect(modelStatsKey('groq', 'llama-3.3-70b', '')).toBe('groq:llama-3.3-70b');
    expect(modelStatsKey('groq', 'llama-3.3-70b', null)).toBe('groq:llama-3.3-70b');
    // Un-scoped legacy custom rows keep their old bucket too.
    expect(modelStatsKey('custom', 'relay-model', '')).toBe('custom:relay-model');
    expect(modelStatsKey('custom', 'relay-model', 'https://a/v1'))
      .toBe('custom:relay-model@https://a/v1');
  });

  it('only qualifies model ids that need it', () => {
    expect(qualifiedModelMemberId('groq', 'llama-3.3-70b', '')).toBeNull();
    expect(qualifiedModelMemberId('custom', 'relay-model', '')).toBeNull();
    expect(qualifiedModelMemberId('custom', 'deepseek-v3.1', 'https://relay-a.example.com/v1'))
      .toBe('custom:deepseek-v3.1#relay-a.example.com-v1');
  });

  it('matches an endpoint reference written either way', () => {
    const scope = 'https://relay-a.example.com/v1';
    expect(endpointRefMatches('relay-a.example.com-v1', scope)).toBe(true);
    expect(endpointRefMatches(scope, scope)).toBe(true);
    expect(endpointRefMatches('relay-a.example.com/v1', scope)).toBe(true);
    expect(endpointRefMatches('https://relay-b.example.com/v1', scope)).toBe(false);
    expect(endpointRefMatches('', scope)).toBe(false);
    expect(endpointRefMatches('anything', '')).toBe(false);
  });
});
