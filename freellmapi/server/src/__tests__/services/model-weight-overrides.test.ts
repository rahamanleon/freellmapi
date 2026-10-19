import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseModelWeightOverrides,
  applyModelWeightOverride,
  getModelWeightOverrides,
  resetModelWeightOverrides,
  warnOnRoutingOverrideDrift,
} from '../../services/model-weight-overrides.js';
import { initDb, getDb, setSetting } from '../../db/index.js';

const ORIGINAL_ENV = process.env.MODEL_ROUTING_OVERRIDES;

describe('model weight overrides', () => {
  beforeEach(() => {
    resetModelWeightOverrides();
  });

  afterEach(() => {
    resetModelWeightOverrides();
    if (ORIGINAL_ENV === undefined) {
      delete process.env.MODEL_ROUTING_OVERRIDES;
    } else {
      process.env.MODEL_ROUTING_OVERRIDES = ORIGINAL_ENV;
    }
  });

  it('parses a valid JSON object of model multipliers', () => {
    const map = parseModelWeightOverrides('{"gpt-4o": 0.2, "deepseek-v3": 0.8, "claude-3.5": 1}');
    expect([...map.entries()]).toEqual([
      ['gpt-4o', 0.2],
      ['deepseek-v3', 0.8],
      ['claude-3.5', 1],
    ]);
  });

  it('drops out-of-range, non-finite and non-number values instead of applying them', () => {
    const map = parseModelWeightOverrides('{"ok": 0.5, "neg": -1, "big": 3, "nan": "x", "inf": 1e999}');
    expect([...map.entries()]).toEqual([['ok', 0.5]]);
  });

  it('ignores blank, malformed or non-object input', () => {
    expect(parseModelWeightOverrides(undefined).size).toBe(0);
    expect(parseModelWeightOverrides('').size).toBe(0);
    expect(parseModelWeightOverrides('   ').size).toBe(0);
    expect(parseModelWeightOverrides('not json').size).toBe(0);
    expect(parseModelWeightOverrides('42').size).toBe(0);
    expect(parseModelWeightOverrides('[1,2]').size).toBe(0);
  });

  it('accepts the extremes: 0 demotes hard, 2 promotes', () => {
    const map = parseModelWeightOverrides('{"never": 0, "boost": 2}');
    expect(map.get('never')).toBe(0);
    expect(map.get('boost')).toBe(2);
  });

  it('multiplies only the scores of overridden models', () => {
    const overrides = new Map([['gpt-4o', 0.2]]);
    expect(applyModelWeightOverride(0.8, 'gpt-4o', overrides)).toBeCloseTo(0.16);
    expect(applyModelWeightOverride(0.8, 'other-model', overrides)).toBe(0.8);
  });

  it('a zero multiplier zeros the score without disabling the model', () => {
    const overrides = new Map([['slow', 0]]);
    expect(applyModelWeightOverride(0.7, 'slow', overrides)).toBe(0);
    expect(applyModelWeightOverride(0.7, 'fine', overrides)).toBe(0.7);
  });

  it('reads the process env lazily and caches it', () => {
    process.env.MODEL_ROUTING_OVERRIDES = '{"cached": 0.3}';
    expect(getModelWeightOverrides().get('cached')).toBe(0.3);

    // The cache is stable even if the env changes afterwards (fixed at boot).
    process.env.MODEL_ROUTING_OVERRIDES = '{"other": 0.9}';
    expect(getModelWeightOverrides().get('cached')).toBe(0.3);

    // ...and the test seam forgets it so a new value takes effect.
    resetModelWeightOverrides();
    expect(getModelWeightOverrides().get('other')).toBe(0.9);
  });

  // Every rejection path above is silent by design so a bad variable cannot
  // break boot. That is the right call for routing and the wrong one for the
  // operator who just wrote the variable: a typo'd model id, an out-of-range
  // multiplier and a stray comma are all indistinguishable from not setting it.
  describe('warnOnRoutingOverrideDrift', () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string) => { warnings.push(m); } };

    beforeEach(() => {
      warnings.length = 0;
      process.env.ENCRYPTION_KEY = '0'.repeat(64);
      initDb(':memory:');
    });

    it('says nothing when the variable is unset or empty', () => {
      delete process.env.MODEL_ROUTING_OVERRIDES;
      expect(warnOnRoutingOverrideDrift(logger)).toBeNull();
      process.env.MODEL_ROUTING_OVERRIDES = '   ';
      expect(warnOnRoutingOverrideDrift(logger)).toBeNull();
      expect(warnings).toEqual([]);
    });

    it('reports unparsable JSON instead of ignoring it silently', () => {
      process.env.MODEL_ROUTING_OVERRIDES = '{"gpt-4o": 0.2,}';
      const drift = warnOnRoutingOverrideDrift(logger)!;
      expect(drift.malformed).toBe(true);
      expect(warnings.join()).toContain('not valid JSON');
    });

    it('reports a non-object value', () => {
      process.env.MODEL_ROUTING_OVERRIDES = '["gpt-4o"]';
      const drift = warnOnRoutingOverrideDrift(logger)!;
      expect(drift.malformed).toBe(true);
      expect(warnings.join()).toContain('must be a JSON object');
    });

    it('names entries dropped for an out-of-range or non-numeric multiplier', () => {
      const real = (getDb().prepare('SELECT model_id FROM models LIMIT 1').get() as { model_id: string }).model_id;
      process.env.MODEL_ROUTING_OVERRIDES = JSON.stringify({ [real]: 5, ['x-' + real]: 'fast' });
      const drift = warnOnRoutingOverrideDrift(logger)!;
      expect(drift.rejectedValues).toContain(real);
      expect(drift.rejectedValues).toContain('x-' + real);
      expect(warnings.join()).toContain('not a finite multiplier');
    });

    it('names an override that matches no model in the catalog', () => {
      setSetting('catalog_last_sync_ms', String(Date.now()));
      process.env.MODEL_ROUTING_OVERRIDES = '{"gpt-4o-typo-not-real": 0.2}';
      const drift = warnOnRoutingOverrideDrift(logger)!;
      expect(drift.unknownModels).toEqual(['gpt-4o-typo-not-real']);
      expect(warnings.join()).toContain("not a model id in this install's catalog");
    });

    // This runs at boot, BEFORE startCatalogSync, so on a first run the models
    // table holds only the migration seed (110 rows) against a real catalog of
    // ~460. Without this gate every override naming one of the ~350 unseeded
    // models is reported as bogus on exactly the boot someone is watching, and
    // a warning that cries wolf first time out gets ignored forever after.
    it('stays silent about unknown models until the catalog has synced once', () => {
      // No catalog_last_sync_ms: a fresh install that has never synced.
      process.env.MODEL_ROUTING_OVERRIDES = '{"a-real-model-not-yet-synced": 0.2}';
      const drift = warnOnRoutingOverrideDrift(logger)!;
      expect(drift.unknownModels).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it('still reports malformed JSON before the catalog has synced', () => {
      // The value halves need no catalog, so the gate must not silence them.
      process.env.MODEL_ROUTING_OVERRIDES = '{"gpt-4o": 0.2,}';
      expect(warnOnRoutingOverrideDrift(logger)!.malformed).toBe(true);
      warnings.length = 0;
      process.env.MODEL_ROUTING_OVERRIDES = '{"gpt-4o": 5}';
      expect(warnOnRoutingOverrideDrift(logger)!.rejectedValues).toEqual(['gpt-4o']);
      expect(warnings.join()).toContain('not a finite multiplier');
    });

    it('stays quiet for a well-formed override naming a real model', () => {
      const real = (getDb().prepare('SELECT model_id FROM models LIMIT 1').get() as { model_id: string }).model_id;
      process.env.MODEL_ROUTING_OVERRIDES = JSON.stringify({ [real]: 0.2 });
      const drift = warnOnRoutingOverrideDrift(logger)!;
      expect(drift).toEqual({ malformed: false, rejectedValues: [], unknownModels: [] });
      expect(warnings).toEqual([]);
    });
  });
});
