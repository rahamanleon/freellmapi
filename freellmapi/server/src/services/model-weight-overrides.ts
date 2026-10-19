import { getDb, getSetting } from '../db/index.js';

// Written by catalog-sync on every completed run (services/catalog-sync.ts).
// Its presence is the only "the catalog is real, not just the migration seed"
// signal available at boot.
const CATALOG_LAST_SYNC_SETTING = 'catalog_last_sync_ms';

// ── Per-model routing weight overrides (#738) ────────────────────────────────
//
// Operators who run a relay with several models sometimes want to keep a model
// around (manual priority may still select it) while making the bandit far less
// likely to pick it — a slow, poor-quality, or just less-preferred model should
// be demoted without being disabled outright. The routing strategies only offer
// GLOBAL weight vectors (per-strategy presets or the user's 'custom' vector), so
// there was no way to single out one model.
//
// `MODEL_ROUTING_OVERRIDES` is a JSON object mapping model ids to a score
// multiplier, e.g.
//
//     MODEL_ROUTING_OVERRIDES='{"gpt-4o": 0.2, "deepseek-v3": 0.8}'
//
// The multiplier is applied to a model's bandit score AFTER combineScore:
//   1.0  → unchanged (explicit no-op)
//   <1.0 → demoted (0.0 is the extreme: never picked by the bandit, but a
//          manual 'priority' chain can still route to it — "not disabled")
//   >1.0 → promoted
// Out-of-range (negative, >2) or non-finite values are dropped, never applied;
// an empty or malformed variable is ignored entirely. Matching is by model_id
// alone (not platform-qualified), consistent with "individual models" in #738.
//
// The override is orthogonal to the strategy's weight vector: it multiplies the
// final score rather than replacing any weight, so it composes with every
// strategy (except 'priority', which has no score — the bandit branch only).

export type ModelWeightOverrides = ReadonlyMap<string, number>;

/** Overrides parsed from `MODEL_ROUTING_OVERRIDES`, cached after first read. */
let cache: ModelWeightOverrides | null = null;

/** Parse the env var. Pure and exported for tests: unknown keys are dropped,
 *  values must be finite and in [0, 2]. Returns an empty map on any malformed
 *  input (not an object, or unparsable JSON) rather than throwing. */
export function parseModelWeightOverrides(raw: string | undefined): Map<string, number> {
  if (raw === undefined || raw.trim() === '') return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();

  const out = new Map<string, number>();
  for (const [modelId, value] of Object.entries(parsed)) {
    if (!modelId.trim()) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) continue;
    out.set(modelId, value);
  }
  return out;
}

/** The active overrides — parsed lazily from the environment on first use and
 *  cached for the life of the process (the env is fixed at boot). */
export function getModelWeightOverrides(): ModelWeightOverrides {
  if (cache === null) cache = parseModelWeightOverrides(process.env.MODEL_ROUTING_OVERRIDES);
  return cache;
}

/** Test seam: forget the cached parse so a changed env var takes effect. */
export function resetModelWeightOverrides(): void {
  cache = null;
}

/** Apply a model's override to a bandit score. `overrides` is injectable for
 *  tests; it defaults to the process-wide parsed map. */
export function applyModelWeightOverride(
  score: number,
  modelId: string,
  overrides: ModelWeightOverrides = getModelWeightOverrides(),
): number {
  const override = overrides.get(modelId);
  return override === undefined ? score : score * override;
}

/** What `warnOnRoutingOverrideDrift` found. Returned for tests; the caller at
 *  boot only wants the log lines. */
export interface RoutingOverrideDrift {
  /** The variable is set but did not parse into a usable object. */
  malformed: boolean;
  /** Keys present in the JSON but dropped: not a finite number in [0, 2]. */
  rejectedValues: string[];
  /** Keys that parsed fine but match no model_id in the catalog. Always empty
   *  when the catalog has not synced yet — see `warnOnRoutingOverrideDrift`. */
  unknownModels: string[];
}

/**
 * Report `MODEL_ROUTING_OVERRIDES` entries that will never do anything.
 *
 * Every rejection path in this module is deliberately silent so a bad variable
 * can never break boot — but silence is the wrong answer for an operator who
 * has just written one. A typo in a model id, a value of 5, or a stray trailing
 * comma all produce exactly the same observable result as not setting the
 * variable at all: the model keeps its normal score and nothing says why.
 *
 * Log-only, and never throws: an unreadable catalog just skips the model-id
 * check rather than failing a boot over a diagnostic.
 *
 * The unknown-model half is SKIPPED until the catalog has synced at least once.
 * This runs at boot, before startCatalogSync, so on a first run the models table
 * holds only what the migrations seeded (110 rows) against a real catalog of
 * ~460: every override naming one of the ~350 not in the seed would be reported
 * as bogus on exactly the boot an operator is most likely to be reading. A
 * warning that cries wolf on its first outing teaches people to skip the line
 * that would have caught the real typo, so it stays quiet until it can be
 * right. The malformed-JSON and bad-multiplier halves need no catalog and
 * always run.
 */
export function warnOnRoutingOverrideDrift(
  logger: Pick<Console, 'warn'> = console,
): RoutingOverrideDrift | null {
  const raw = process.env.MODEL_ROUTING_OVERRIDES;
  if (raw === undefined || raw.trim() === '') return null;

  const drift: RoutingOverrideDrift = { malformed: false, rejectedValues: [], unknownModels: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    drift.malformed = true;
    logger.warn(
      `[config] MODEL_ROUTING_OVERRIDES is not valid JSON and is being ignored entirely `
      + `(${err?.message ?? err}). Expected an object like {"gpt-4o": 0.2}.`,
    );
    return drift;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    drift.malformed = true;
    logger.warn(
      '[config] MODEL_ROUTING_OVERRIDES must be a JSON object mapping model ids to multipliers, '
      + 'e.g. {"gpt-4o": 0.2} — the current value is being ignored entirely.',
    );
    return drift;
  }

  const accepted = parseModelWeightOverrides(raw);
  for (const [modelId, value] of Object.entries(parsed)) {
    if (!modelId.trim() || accepted.has(modelId)) continue;
    drift.rejectedValues.push(modelId);
    logger.warn(
      `[config] MODEL_ROUTING_OVERRIDES entry "${modelId}" was dropped: `
      + `${JSON.stringify(value)} is not a finite multiplier in [0, 2].`,
    );
  }

  if (accepted.size > 0) {
    try {
      // Read-only, and gated on a completed sync: before the first one the
      // models table is just the migration seed, so "unknown" would mean
      // "not seeded yet" rather than "wrong".
      if (getSetting(CATALOG_LAST_SYNC_SETTING)) {
        const known = new Set(
          (getDb().prepare('SELECT DISTINCT model_id FROM models').all() as { model_id: string }[])
            .map(r => r.model_id),
        );
        for (const modelId of accepted.keys()) {
          if (known.has(modelId)) continue;
          drift.unknownModels.push(modelId);
          logger.warn(
            `[config] MODEL_ROUTING_OVERRIDES names "${modelId}", which is not a model id in this `
            + "install's catalog, so the override is not applying. Overrides match model_id alone, "
            + 'unqualified by platform, and the match is exact and case-sensitive. A model gated '
            + 'behind a provider you have no key for appears once that key is added.',
          );
        }
      }
    } catch {
      // Catalog unreadable (DB not ready, mid-migration). The value half of the
      // report is still useful; skip the existence check rather than throw.
    }
  }

  return drift;
}
