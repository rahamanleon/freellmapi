import { providerHttpError, type KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const SERPSEARCH_BASE_URL = 'https://api.serpsearch.com/api/v1';

export class SerpSearchProvider extends SearchOnlyProvider {
  readonly platform = 'serpsearch' as const;
  readonly name = 'SerpSearch';

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    // Authentication runs before query validation: a valid key gets 400 with
    // quota headers, an invalid key gets 401. No query means no credit spent.
    // Live checked against both cases; do not turn this into a real search.
    const res = await this.fetchWithTimeout(`${SERPSEARCH_BASE_URL}/search`, {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}` },
    }, 10_000, { timeoutBounds: 'request' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    const quota = res.headers.get('x-quota-limit');
    if (res.status === 400 && quota !== null && /^\d+$/.test(quota)) {
      const text = await res.text();
      if (/missing field [`'"]?query|INVALID_QUERY/i.test(text)) return true;
    }
    throw providerHttpError(res, 'SerpSearch key validation is inconclusive');
  }
}
