import { OpenAICompatProvider } from './openai-compat.js';
import type { KeyValidationResult } from './base.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

const POLLINATIONS_BASE_URL = 'https://gen.pollinations.ai/v1';
/** Authenticated key-introspection endpoint — note it sits OUTSIDE /v1. */
const POLLINATIONS_ACCOUNT_KEY_URL = 'https://gen.pollinations.ai/account/key';

/**
 * Pollinations — OpenAI-compatible shared-capacity tier.
 *
 * Everything except key validation is stock OpenAI-compat. validateKey is
 * overridden because Pollinations serves its catalog without auth:
 *
 *   GET /v1/models answers 200 for a revoked key (and for no key at all —
 *   verified live 2026-07-28), while POST /v1/chat/completions answers 401.
 *   The default openai-compat probe therefore reported dead keys as healthy
 *   and routing degraded silently. See issue #608.
 *
 * The probe is GET /account/key instead, which enforces auth (401 for a
 * garbage bearer, verified the same day) and costs no generation quota.
 * Response classification, all of it deliberate:
 *   200 → authenticated, key is live.
 *   401 → revoked/invalid; surfaces the upstream reason and feeds the
 *         consecutive-failure auto-disable, same as every other provider.
 *   402 → authenticated but out of pollen. The credential is fine; benching
 *         it belongs to the router's quota path, not to key validation.
 *   403 → Pollinations uses 403 for insufficient PERMISSIONS, so a restricted
 *         (but live) key can be refused this endpoint. Inconclusive: throw so
 *         health.ts keeps the previous verdict instead of disabling a good key.
 *   other non-2xx (endpoint moved, provider 5xx) → inconclusive, same as above.
 */
export class PollinationsProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'pollinations',
      name: 'Pollinations',
      baseUrl: POLLINATIONS_BASE_URL,
    });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // Transport errors (DNS / timeout / TLS) propagate — health.ts marks
    // status='error' without counting toward auto-disable; only a confirmed
    // 401 disables a key.
    const res = await this.fetchWithTimeout(POLLINATIONS_ACCOUNT_KEY_URL, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 30000, { timeoutBounds: 'request' });

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'account/key',
    });

    if (res.status === 401) return this.validationResult(res);
    if (res.ok || res.status === 402) return true;

    if (res.status === 403) {
      throw new Error(
        `Pollinations key validation inconclusive: HTTP 403 from /account/key. ` +
        `The key authenticated but lacks permission for the introspection endpoint, ` +
        `so it is NOT treated as revoked.`,
      );
    }
    throw new Error(`Pollinations /account/key returned HTTP ${res.status} — key validity unknown`);
  }
}
