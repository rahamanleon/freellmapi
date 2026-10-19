import { createHash } from 'node:crypto';
import { OpenAICompatProvider } from './openai-compat.js';
import type { KeyValidationResult } from './base.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

const MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.cn/v1';

// A successful validation is cached per key for this long. The 5-minute
// health pass would otherwise burn ~288 paid 1-token completions per key
// per day against the account's magic-grain (魔粒) quota — observed as
// 2 魔粒 per ultra-tier request (2026-08-14). A revoked key is still caught
// by the next real request's 401 handling (error-classify disables it), so
// the cache only delays proactive detection, never hides a live failure.
const DEFAULT_VALIDATE_CACHE_MS = 24 * 60 * 60 * 1000;

function modelscopeValidateCacheMs(): number {
  const raw = process.env.MODELSCOPE_VALIDATE_CACHE_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return DEFAULT_VALIDATE_CACHE_MS;
}

/**
 * ModelScope (魔搭社区, Alibaba) — OpenAI-compatible inference API.
 *
 * Everything except key validation is stock OpenAI-compat. validateKey is
 * overridden because of a trap in ModelScope's API surface:
 *
 *   GET /v1/models returns 200 WITHOUT auth — and, verified keyless on
 *   2026-07-26, it also returns 200 with a GARBAGE Bearer token. The default
 *   openai-compat validateKey (GET /v1/models with the key) would therefore
 *   mark any invalid key healthy forever. /v1/models is useless for
 *   validation on this platform.
 *
 * The only endpoint verified to enforce auth is POST /v1/chat/completions:
 * a garbage token gets a clean
 *   401 {"error":{"message":"Authentication failed, please make sure that a
 *        valid ModelScope token is supplied."}}
 * before any generation happens. So validation makes a 1-token chat
 * completion. The model id is picked dynamically from GET /v1/models (first
 * entry) because the roster churns — a hardcoded id would rot.
 *
 * COST: a successful validation burns 1 paid 1-token completion per health
 * check against the account's magic-grain (魔粒) quota — observed as 2 魔粒
 * per ultra-tier request (2026-08-14), not the historical 2000-requests/day
 * free API quota. With the default 5-minute health pass that would be ~288
 * paid probes per key per day. A successful validation is therefore cached
 * per key for MODELSCOPE_VALIDATE_CACHE_MS (default 24h) — repeat health
 * passes return true without re-probing, taking the steady-state cost to one
 * probe per key per day. A failed-auth validation is rejected before
 * generation and, per maintainer reports, does not count against quota.
 *
 * Community testers must confirm (we have NO real token for this platform):
 * the maintainer-documented bad-binding failure is
 *   `401 please bind your alibaba cloud account before use`
 * — a token minted without binding the ModelScope account to an Alibaba
 * Cloud CHINA-site account fails every call with that message. It flows
 * through validationResult() into the health error verbatim so users see the
 * actionable reason instead of a generic "invalid key". See issue #581.
 */
export class ModelScopeProvider extends OpenAICompatProvider {
  /** key-material fingerprint → last successful validation wall-clock (ms).
   *  Keyed on the token itself, not the row id, so editing a key in place
   *  re-probes instead of inheriting the old token's verdict. */
  private readonly lastValidatedAt = new Map<string, number>();

  constructor() {
    super({
      platform: 'modelscope',
      name: 'ModelScope',
      // Serves large reasoning models (DeepSeek-V4, Qwen3 Thinking variants)
      // from cn-region infrastructure; cross-region TTFB plus buffered
      // reasoning phases blow the 60s default. 90s matches NVIDIA NIM's
      // allowance for the same model class.
      baseUrl: MODELSCOPE_BASE_URL,
      timeoutMs: 90_000,
    });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // Validation cache: a key validated successfully within
    // MODELSCOPE_VALIDATE_CACHE_MS is trusted without re-probing. The
    // 5-minute health pass would otherwise burn ~288 paid 1-token
    // completions per key per day against the magic-grain quota. A revoked
    // key is still caught by the next real request's 401 handling, so this
    // only delays proactive detection.
    const cacheMs = modelscopeValidateCacheMs();
    const fingerprint = createHash('sha256').update(apiKey).digest('hex');
    if (cacheMs > 0) {
      const last = this.lastValidatedAt.get(fingerprint);
      if (last !== undefined && Date.now() - last < cacheMs) {
        return true;
      }
    }

    // Transport errors (DNS / timeout / TLS) propagate — health.ts marks
    // status='error' without counting toward auto-disable; only a confirmed
    // 401/403 disables a key.

    // Step 1: pick a live model id for the auth probe. This call is NOT the
    // validation (it answers 200 for any token, see class comment) — it only
    // keeps the probe's model id in sync with the churning roster.
    const modelsRes = await this.fetchWithTimeout(`${MODELSCOPE_BASE_URL}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 30000, { timeoutBounds: 'request' });
    if (!modelsRes.ok) {
      // Auth failures cannot happen here (endpoint is unauthenticated); treat
      // any non-200 as an upstream outage → status='error', never 'invalid'.
      throw new Error(`ModelScope /models returned HTTP ${modelsRes.status} while picking a validation probe model`);
    }
    const roster = await modelsRes.json().catch(() => null) as { data?: Array<{ id?: string }> } | null;
    const probeModel = roster?.data?.[0]?.id;
    if (!probeModel) {
      throw new Error('ModelScope /models returned no models to probe key validity against');
    }

    // Step 2: the actual auth check — a minimal 1-token completion.
    const res = await this.fetchWithTimeout(`${MODELSCOPE_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: probeModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    }, 30000, { timeoutBounds: 'request' });

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId: probeModel,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'chat/completions',
    });

    // validationResult: 401/403 → {valid:false, error:<upstream message>}
    // (surfaces the alibaba-binding reason); everything else — 200, but also
    // 400/404 (probe model quirk), 429 (quota) — proves the token
    // authenticated and returns true.
    const result = await this.validationResult(res);
    if (result === true && cacheMs > 0) {
      this.lastValidatedAt.set(fingerprint, Date.now());
    }
    return result;
  }
}
