import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { parseStatedRetryMs, providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const AURAY_BASE_URL = 'https://api.auray.ai/openai/v1';

function checkResponse(value: { model?: string; error?: unknown }, requested: string): void {
  // Deferred failures can arrive under HTTP 200 or after valid SSE chunks.
  // Never expose them (or an auto-routed substitute) as a successful answer.
  if (value.error) {
    const error = value.error as { code?: string; type?: string };
    const rateLimited = error.code === 'rate_limited' || error.type === 'insufficient_quota';
    throw Object.assign(new Error('Auray returned an upstream completion error'), {
      status: rateLimited ? 429 : 502,
      retryAfterMs: parseStatedRetryMs(value),
    });
  }
  if (value.model !== requested) {
    throw Object.assign(new Error('Auray returned a different or missing model identity'), { status: 502 });
  }
}

/** Free credits renew monthly and are shared across chat and embeddings.
 * Only the signed catalog decides which models qualify; no bundled seeds.
 * https://www.auray.ai/docs/clients/openai */
export class AurayProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'auray', name: 'Auray', baseUrl: AURAY_BASE_URL,
      validateUrl: 'https://api.auray.ai/v1/me', timeoutMs: 180_000 });
  }

  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if ([401, 403].includes(response.status)) return super.validationResult(response);
    if (!response.ok) throw providerHttpError(response, 'Auray key validation is temporarily inconclusive');
    const body = await response.json().catch(() => null) as { plan?: unknown; credits?: { balance?: unknown } } | null;
    if (typeof body?.plan !== 'string' || typeof body.credits?.balance !== 'number' || !Number.isFinite(body.credits.balance)) {
      throw Object.assign(new Error('Auray returned an invalid account response'), { status: 502 });
    }
    // An exhausted free wallet is still an authenticated key. /models is a
    // roster, not an authentication probe; /me never generates paid tokens.
    return true;
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkResponse(response, modelId);
    if (!Array.isArray(response.choices) || response.choices.length === 0 || response.choices.some(c => !c.message)) {
      throw Object.assign(new Error('Auray returned a malformed completion'), { status: 502 });
    }
    return response;
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    let identified = false;
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      checkResponse(chunk, modelId);
      if (!Array.isArray(chunk.choices) || chunk.choices.some(c => !c.delta)) {
        throw Object.assign(new Error('Auray returned a malformed stream event'), { status: 502 });
      }
      identified = true;
      yield chunk;
    }
    if (!identified) throw Object.assign(new Error('Auray returned an empty stream'), { status: 502 });
  }
}
