// ── Endpoint identity for custom relay models (#651) ────────────────────────
//
// Every custom relay is stored under platform = 'custom', so two relays that
// both offer `deepseek-v3.1` used to collapse into ONE `models` row: one
// enabled flag, one reliability/speed bucket, one binding anchor. Disabling the
// model because relay A was broken disabled it for relay B too, and relay A's
// timeouts dragged down the copy relay B served just fine (#619).
//
// The discriminator is `models.endpoint_scope`: the normalized base_url of the
// endpoint the row belongs to, '' for every catalog platform. Uniqueness is
// (platform, model_id, endpoint_scope), so catalog rows keep exactly their old
// (platform, model_id) semantics — '' is the same value for all of them — while
// two relays can each hold their own row for the same model id.
//
// Why base_url and not key_id: #640 settled that an endpoint is a base_url
// holding a POOL of credentials, and a model rotates across that pool. Keying
// identity on key_id would split one relay's model into one row per credential
// and undo that. Why a TEXT token and not a foreign key: the scope is opaque to
// everything except this module, so the per-key model groups of #657 can later
// refine it (`<base_url>#<group>`) without a second identity migration.

import type { Db } from '../db/types.js';

/** Trailing-slash-insensitive endpoint identity, matching how base_url is stored. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** The scope token for a custom endpoint; '' means "not endpoint-scoped". */
export function endpointScopeForBaseUrl(baseUrl: string | null | undefined): string {
  return baseUrl ? normalizeBaseUrl(baseUrl) : '';
}

/**
 * The scope a model bound to `keyId` belongs to. '' when the key is gone or
 * carries no base_url — a legacy custom row that predates per-endpoint binding
 * keeps the un-scoped identity it has always had, so nothing about it changes.
 */
export function endpointScopeOfKey(db: Db, keyId: number | null | undefined): string {
  if (keyId == null) return '';
  const row = db.prepare("SELECT base_url FROM api_keys WHERE id = ? AND platform = 'custom'")
    .get(keyId) as { base_url: string | null } | undefined;
  return endpointScopeForBaseUrl(row?.base_url);
}

/**
 * A short, typable handle for a scope, used only for naming: the host (with
 * port) plus path, slugified. Derived purely from the scope, so it is stable —
 * adding or removing OTHER endpoints never renames an existing one.
 *
 *   https://relay-a.example.com/v1  →  relay-a.example.com-v1
 *   http://127.0.0.1:11434/v1       →  127.0.0.1-11434-v1
 */
export function endpointHandle(scope: string): string {
  const withoutScheme = scope.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slug = withoutScheme
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'endpoint';
}

/**
 * The bucket key for reliability/speed stats and the routing round-robin.
 * Unchanged (`platform:model_id`) for every catalog model and for un-scoped
 * legacy custom rows; endpoint-qualified only for rows that actually carry a
 * scope, so a single-endpoint install keeps its existing history verbatim.
 */
export function modelStatsKey(
  platform: string,
  modelId: string,
  endpointScope: string | null | undefined,
): string {
  return endpointScope ? `${platform}:${modelId}@${endpointScope}` : `${platform}:${modelId}`;
}

// The separator between a member id and its endpoint handle. '#' reads as a
// fragment and — unlike ':', '@' or '/' — does not occur in provider model ids.
export const ENDPOINT_ID_SEPARATOR = '#';

/**
 * The endpoint-qualified model id a client can send to pin ONE relay's copy:
 * `custom:deepseek-v3.1#relay-a.example.com-v1`. Null for rows with no scope,
 * whose plain `platform:model_id` member id is already unambiguous — which is
 * why a single-endpoint install never sees a qualified id anywhere.
 */
export function qualifiedModelMemberId(
  platform: string,
  modelId: string,
  endpointScope: string | null | undefined,
): string | null {
  if (!endpointScope) return null;
  return `${platform}:${modelId}${ENDPOINT_ID_SEPARATOR}${endpointHandle(endpointScope)}`;
}

/**
 * Whether `requested` names this row's endpoint after the separator. Accepts
 * the handle or the raw base_url (with or without scheme / trailing slash), so
 * a user who pastes the endpoint URL they typed into the dashboard is right.
 */
export function endpointRefMatches(requested: string, endpointScope: string): boolean {
  const ref = requested.trim();
  if (!ref || !endpointScope) return false;
  // Slugifying BOTH sides is what makes the handle and the raw URL equivalent:
  // endpointHandle is idempotent, so handle→handle and url→handle both land on
  // the same token.
  return endpointHandle(ref) === endpointHandle(endpointScope);
}

/**
 * The typable handle for an endpoint GROUP (#1176) — the operator's label run
 * through the same slug as endpoint handles, so `My Relays` is `my-relays`.
 * Used after the separator: `custom:deepseek-v3.1#my-relays`.
 */
export function groupHandle(label: string): string {
  return endpointHandle(label);
}

/** Whether `requested` (after the separator) names the group `groupLabel`. */
export function groupRefMatches(requested: string, groupLabel: string | null | undefined): boolean {
  const ref = requested.trim();
  if (!ref || !groupLabel) return false;
  return endpointHandle(ref) === endpointHandle(groupLabel);
}
