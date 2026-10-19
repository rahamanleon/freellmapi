import type { Platform } from '@freellmapi/shared/types.js';
import type { KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const EXA_BASE_URL = 'https://api.exa.ai';

// Exa (exa.ai): recurring monthly free credits. Exa has no free "who am I"
// endpoint and the health checker validates every key every few minutes, so a
// real search probe would burn the free credits within days. Instead the probe
// sends a search with no query: Exa authenticates first, so a bad key answers
// 401 while a good one fails body validation with a 400 and spends nothing.
export class ExaProvider extends SearchOnlyProvider {
  readonly platform: Platform = 'exa';
  readonly name = 'Exa';

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    return this.probe(`${EXA_BASE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({}),
    });
  }
}
