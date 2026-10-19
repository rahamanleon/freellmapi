import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  TOOL_ARGUMENT_VALIDATION_SETTING,
  invalidToolArgumentsError,
  invalidToolCallReasons,
  isToolArgumentValidationEnabled,
  stableStringify,
  validateToolArguments,
} from '../../lib/tool-validate.js';
import { isRetryableError } from '../../lib/error-classify.js';
import { classifyAttemptError } from '../../lib/fallback-loop.js';
import { initDb, getDb, setSetting } from '../../db/index.js';

const WEATHER_SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' }, days: { type: 'number' } },
  required: ['city'],
};

const call = (name: string, args: string) => ({ function: { name, arguments: args } });

describe('validateToolArguments', () => {
  it('accepts arguments that satisfy the schema', () => {
    expect(validateToolArguments('get_weather', '{"city":"Berlin"}', WEATHER_SCHEMA)).toEqual({ ok: true });
  });

  it('reports a missing required property', () => {
    const verdict = validateToolArguments('get_weather', '{"days":3}', WEATHER_SCHEMA);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('city');
  });

  it('reports a wrong scalar type', () => {
    const verdict = validateToolArguments('get_weather', '{"city":"Berlin","days":"three"}', WEATHER_SCHEMA);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('days');
  });

  it('names the tool in the reason, so a multi-call turn is diagnosable', () => {
    const verdict = validateToolArguments('get_weather', '{}', WEATHER_SCHEMA);
    if (!verdict.ok) expect(verdict.reason.startsWith('get_weather:')).toBe(true);
  });
});

// Every branch where we cannot form an opinion must pass, because the cost of a
// verdict is a failover hop.
describe('validateToolArguments fails open', () => {
  it('with no schema', () => {
    expect(validateToolArguments('t', '{"anything":1}', undefined)).toEqual({ ok: true });
    expect(validateToolArguments('t', '{"anything":1}', null)).toEqual({ ok: true });
  });

  it('with a schema Ajv cannot compile', () => {
    expect(validateToolArguments('t', '{}', { type: 'not-a-real-type' })).toEqual({ ok: true });
  });

  it('with an unrecognised $schema dialect, which is stripped before compiling', () => {
    const schema = { $schema: 'https://example.invalid/draft-99', ...WEATHER_SCHEMA };
    expect(validateToolArguments('t', '{"city":"Berlin"}', schema)).toEqual({ ok: true });
    // Still a real check afterwards, not a blanket pass.
    expect(validateToolArguments('t', '{}', schema).ok).toBe(false);
  });

  it('with arguments that are not JSON at all', () => {
    // tool-args deliberately passes unparseable arguments through untouched;
    // reporting them is someone else's job.
    expect(validateToolArguments('t', '{not json', WEATHER_SCHEMA)).toEqual({ ok: true });
    expect(validateToolArguments('t', '', WEATHER_SCHEMA)).toEqual({ ok: true });
  });

  it('with arguments that are not an object', () => {
    expect(validateToolArguments('t', '[1,2]', WEATHER_SCHEMA)).toEqual({ ok: true });
    expect(validateToolArguments('t', '"a string"', WEATHER_SCHEMA)).toEqual({ ok: true });
  });

  it('tolerates vendor extensions rather than rejecting the schema', () => {
    const schema = { ...WEATHER_SCHEMA, 'x-vendor-hint': 'something', additionalProperties: false };
    expect(validateToolArguments('t', '{"city":"Berlin"}', schema)).toEqual({ ok: true });
  });
});

describe('stableStringify', () => {
  it('is order-independent, so key order does not fork the compile cache', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('still distinguishes different schemas', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it('handles nesting and arrays', () => {
    expect(stableStringify({ x: [{ b: 1, a: 2 }] })).toBe(stableStringify({ x: [{ a: 2, b: 1 }] }));
  });
});

describe('invalidToolCallReasons', () => {
  const schemas = new Map<string, unknown>([['get_weather', WEATHER_SCHEMA]]);

  it('is empty for a well-formed turn', () => {
    expect(invalidToolCallReasons([call('get_weather', '{"city":"Berlin"}')], schemas)).toEqual([]);
  });

  it('collects one reason per bad call', () => {
    const reasons = invalidToolCallReasons(
      [call('get_weather', '{}'), call('get_weather', '{"city":1}')],
      schemas,
    );
    expect(reasons).toHaveLength(2);
  });

  it('ignores a tool the caller declared no schema for', () => {
    expect(invalidToolCallReasons([call('unknown_tool', '{"whatever":1}')], schemas)).toEqual([]);
  });

  it('is empty for no calls at all', () => {
    expect(invalidToolCallReasons(undefined, schemas)).toEqual([]);
    expect(invalidToolCallReasons([], schemas)).toEqual([]);
  });
});

describe('invalidToolArgumentsError', () => {
  const err = invalidToolArgumentsError('Groq llama-3.3-70b', ['get_weather: /city must be string']);

  it('is recognised as retryable, so the loop fails over', () => {
    expect(isRetryableError(err)).toBe(true);
  });

  it('classifies honestly in the trail rather than as a bare error', () => {
    expect(classifyAttemptError(err)).toBe('invalid_tool_arguments');
  });

  it('spares the provider: the model misbehaved, not the endpoint', () => {
    // skipBench -> no cooldown or score penalty; skipModelForRequest -> a
    // sibling key would misbehave identically.
    expect((err as any).skipBench).toBe(true);
    expect((err as any).skipModelForRequest).toBe(true);
  });

  it('names the model and the reason', () => {
    expect(err.message).toContain('Groq llama-3.3-70b');
    expect(err.message).toContain('/city must be string');
  });
});

describe('isToolArgumentValidationEnabled', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    delete process.env.VALIDATE_TOOL_ARGUMENTS;
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(TOOL_ARGUMENT_VALIDATION_SETTING);
  });

  it('is off by default — a false positive costs a failover hop', () => {
    expect(isToolArgumentValidationEnabled()).toBe(false);
  });

  it('honours the settings-table value', () => {
    setSetting(TOOL_ARGUMENT_VALIDATION_SETTING, '1');
    expect(isToolArgumentValidationEnabled()).toBe(true);
  });

  it('falls back to the env var when nothing is stored', () => {
    process.env.VALIDATE_TOOL_ARGUMENTS = 'true';
    expect(isToolArgumentValidationEnabled()).toBe(true);
  });

  it('lets the settings table win over the env var', () => {
    setSetting(TOOL_ARGUMENT_VALIDATION_SETTING, '0');
    process.env.VALIDATE_TOOL_ARGUMENTS = '1';
    expect(isToolArgumentValidationEnabled()).toBe(false);
  });
});
