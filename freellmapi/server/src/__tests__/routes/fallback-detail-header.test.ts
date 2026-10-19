import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// X-Fallback-Detail: the opt-in companion to X-Fallback-Trail.
//
// The trail already says WHICH hops burned and WHY. What a caller cannot
// reconstruct is what each hop COST: a request answered in 40s reads
// identically whether one provider stalled for 39s or four failed fast. The
// per-hop timings are already collected for request_attempts; this header
// exposes them without a dashboard round trip.

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey, setSetting } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');
const {
  EXPOSE_FALLBACK_DETAIL_SETTING,
  formatAttemptDetail,
  isFallbackDetailHeaderEnabled,
  setFallbackHeaders,
} = await import('../../lib/fallback-loop.js');
const { newRequestTrace, runWithRequestTrace } = await import('../../lib/attempt-trace.js');

/** Remove the row entirely, so the env-var fallback is actually reachable —
 *  storing '0' is a decision, not an absence. */
function clearDetailSetting(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(EXPOSE_FALLBACK_DETAIL_SETTING);
}

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* SSE */ }
  return { status: res.status, body: json, raw, headers: res.headers };
}

const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'a real answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
};

const record = (over: Partial<Parameters<typeof formatAttemptDetail>[0][number]> = {}) => ({
  ordinal: 0,
  platform: 'groq',
  modelId: 'llama-3.3-70b',
  keyOrdinal: 1,
  outcome: 'rate_limited' as const,
  startOffsetMs: 0,
  durationMs: 11,
  errorSummary: null,
  ...over,
});

describe('formatAttemptDetail', () => {
  it('leads with the same shape as X-Fallback-Trail so the two headers line up', () => {
    expect(formatAttemptDetail([record()])).toBe('groq/llama-3.3-70b key1=rate_limited t=0+11ms');
  });

  it('carries the per-hop timing that the trail cannot express', () => {
    const value = formatAttemptDetail([
      record({ startOffsetMs: 0, durationMs: 39_000 }),
      record({ ordinal: 1, platform: 'google', modelId: 'gemini-2.5-flash', keyOrdinal: 2, outcome: 'timeout', startOffsetMs: 39_000, durationMs: 12 }),
    ]);
    // A 39s stall followed by a fast failure — indistinguishable in the trail.
    expect(value).toBe(
      'groq/llama-3.3-70b key1=rate_limited t=0+39000ms; ' +
      'google/gemini-2.5-flash key2=timeout t=39000+12ms',
    );
  });

  it('appends the redacted provider message when there is one', () => {
    const value = formatAttemptDetail([record({ errorSummary: 'Groq API error 429: rate limit' })]);
    expect(value).toBe('groq/llama-3.3-70b key1=rate_limited t=0+11ms msg=Groq API error 429: rate limit');
  });

  it('replaces semicolons in the message so they cannot forge a record boundary', () => {
    const value = formatAttemptDetail([record({ errorSummary: 'first; second' })]);
    expect(value).toBe('groq/llama-3.3-70b key1=rate_limited t=0+11ms msg=first, second');
    expect(value.split('; ')).toHaveLength(1);
  });

  it('truncates a long message rather than letting ten hops blow the header budget', () => {
    const value = formatAttemptDetail([record({ errorSummary: 'x'.repeat(500) })]);
    expect(value).toContain('msg=' + 'x'.repeat(120));
    expect(value).not.toContain('x'.repeat(121));
  });

  it('caps the hop count and says how many it dropped', () => {
    const many = Array.from({ length: 14 }, (_, i) => record({ ordinal: i }));
    const value = formatAttemptDetail(many);
    expect(value.split('; ')).toHaveLength(11); // 10 hops + the "+4 more" marker
    expect(value.endsWith('; +4 more')).toBe(true);
  });

  it('is empty for an empty trace', () => {
    expect(formatAttemptDetail([])).toBe('');
  });
});

describe('isFallbackDetailHeaderEnabled', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    clearDetailSetting();
  });

  afterEach(() => {
    delete process.env.FALLBACK_DETAIL_HEADER;
    clearDetailSetting();
  });

  it('is off by default — this widens what the surface reveals', () => {
    expect(isFallbackDetailHeaderEnabled()).toBe(false);
  });

  it('honours the settings-table value', () => {
    setSetting(EXPOSE_FALLBACK_DETAIL_SETTING, '1');
    expect(isFallbackDetailHeaderEnabled()).toBe(true);
  });

  it('falls back to the env var when no setting is stored', () => {
    process.env.FALLBACK_DETAIL_HEADER = 'true';
    expect(isFallbackDetailHeaderEnabled()).toBe(true);
  });

  it('lets the settings table win over the env var, like the failover budget', () => {
    setSetting(EXPOSE_FALLBACK_DETAIL_SETTING, '0');
    process.env.FALLBACK_DETAIL_HEADER = '1';
    expect(isFallbackDetailHeaderEnabled()).toBe(false);
  });
});

describe('X-Fallback-Detail on the wire', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('detail-header-test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'detail-header', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    setSetting(EXPOSE_FALLBACK_DETAIL_SETTING, '1');
  });

  afterEach(() => {
    setSetting(EXPOSE_FALLBACK_DETAIL_SETTING, '0');
    delete process.env.FALLBACK_DETAIL_HEADER;
  });

  it('reports the failed hops with timings alongside the existing trail', async () => {
    chatCompletion
      .mockRejectedValueOnce(Object.assign(new Error('Groq API error 429: rate limit'), { status: 429 }))
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'detail header test' }],
    }, key);

    expect(status).toBe(200); // failed over and served
    expect(headers.get('x-fallback-attempts')).toBe('1');
    expect(headers.get('x-fallback-trail')).toContain('key1=rate_limited');

    const detail = headers.get('x-fallback-detail');
    expect(detail).toBeTruthy();
    expect(detail).toMatch(/^groq\/\S+ key1=rate_limited t=\d+\+\d+ms msg=/);
    expect(detail).toContain('rate limit');
  });

  it('stays silent when the setting is off', async () => {
    setSetting(EXPOSE_FALLBACK_DETAIL_SETTING, '0');
    chatCompletion
      .mockRejectedValueOnce(Object.assign(new Error('Groq API error 429: rate limit'), { status: 429 }))
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'detail header off test' }],
    }, key);

    expect(status).toBe(200);
    // The always-on trail is unaffected by the toggle.
    expect(headers.get('x-fallback-attempts')).toBe('1');
    expect(headers.get('x-fallback-detail')).toBeNull();
  });

  it('is absent on a request that never failed over, rather than empty', async () => {
    chatCompletion.mockResolvedValueOnce(GOOD_RESULT);

    const { status, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'clean request' }],
    }, key);

    expect(status).toBe(200);
    expect(headers.get('x-fallback-detail')).toBeNull();
  });

  it('reaches the caller on the exhaustion path too, not just on success', async () => {
    chatCompletion.mockRejectedValue(
      Object.assign(new Error('Groq API error 429: rate limit'), { status: 429 }),
    );

    const { status, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'exhaustion detail test' }],
    }, key);

    expect(status).toBe(429);
    const detail = headers.get('x-fallback-detail');
    expect(detail).toBeTruthy();
    expect(detail).toContain('key1=rate_limited');
    expect(detail).toMatch(/t=\d+\+\d+ms/);
  });

});

// Driving setFallbackHeaders directly, rather than steering the router into
// picking a hostile model, keeps these about the header and not about routing.
describe('X-Fallback-Detail value safety', () => {
  function headersFor(records: Parameters<typeof formatAttemptDetail>[0]): Record<string, string> {
    const trace = newRequestTrace();
    trace.records.push(...records);
    const out: Record<string, string> = {};
    setSetting(EXPOSE_FALLBACK_DETAIL_SETTING, '1');
    runWithRequestTrace(trace, () => {
      setFallbackHeaders({ setHeader: (n: string, v: string) => { out[n] = v; } }, records.length, undefined);
    });
    return out;
  }

  afterEach(() => {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(EXPOSE_FALLBACK_DETAIL_SETTING);
  });

  it('encodes a control-laden model id instead of letting it inject a header line', () => {
    // #619: a non-ASCII or control-laden id used to make Node throw
    // ERR_INVALID_CHAR after a successful upstream call, and the throw was then
    // booked as a provider failure.
    const value = headersFor([record({ modelId: 'bad\r\nX-Injected: yes' })])['X-Fallback-Detail'];

    expect(value).toMatch(/^[\x20-\x7e]*$/);
    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
    expect(value).toContain('%0D%0A'); // encoded in place, not dropped
  });

  it('encodes a non-ASCII model id rather than rejecting the response', () => {
    const value = headersFor([record({ modelId: '我的模型' })])['X-Fallback-Detail'];

    expect(value).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeURIComponent(value.slice('groq/'.length).split(' ')[0])).toBe('我的模型');
  });

  it('keeps the whole value inside the header budget even at ten long hops', () => {
    const many = Array.from({ length: 10 }, (_, i) => record({
      ordinal: i,
      modelId: 'm'.repeat(80),
      errorSummary: 'e'.repeat(200),
    }));

    expect(headersFor(many)['X-Fallback-Detail'].length).toBeLessThanOrEqual(2048);
  });
});
