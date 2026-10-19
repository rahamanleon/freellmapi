// Per-key model scope (#657). api_keys.model_scope_json is an optional JSON
// array of model_id strings: relay stations hand out keys that only serve one
// model group, so a scoped key must never be picked — or counted as a usable
// sibling — for a model outside its list. NULL means "unscoped": the key
// serves every model of its platform, which is the pre-#657 behavior.

/**
 * Parse a stored scope into a Set for O(1) membership tests, or null when the
 * key is unscoped. Called once per key ROW, never per comparison. An empty or
 * corrupt value degrades to unscoped rather than silently benching the key.
 */
export function parseModelScope(json: string | null | undefined): Set<string> | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    if (!Array.isArray(raw)) return null;
    const ids = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return ids.length > 0 ? new Set(ids) : null;
  } catch {
    return null;
  }
}

/** Whether a key with this parsed scope may serve the model. */
export function scopeAllows(scope: Set<string> | null, modelId: string): boolean {
  return scope === null || scope.has(modelId);
}
