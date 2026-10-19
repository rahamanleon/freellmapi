import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';

// The Gemini REST API accepts the key either as a ?key= query param or an
// x-goog-api-key header. The query form leaks the credential into proxy access
// logs, browser history and any error string that echoes the request URL, so
// every call site must use the header and no URL may carry the key.
// Deliberately not key-shaped: these assertions only care where the string is
// placed, and a realistic-looking key here would trip credential scanners.
const KEY = 'test-google-key-not-a-real-credential';

function headerFrom(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('GoogleProvider credential placement', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = new GoogleProvider();
  });

  it('sends the key as x-goog-api-key on chatCompletion, never in the URL', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    } as any);

    await provider.chatCompletion(KEY, [{ role: 'user', content: 'Hi' }], 'gemini-2.5-pro');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).not.toContain(KEY);
    expect(String(url)).not.toContain('key=');
    expect(headerFrom(init as RequestInit)['x-goog-api-key']).toBe(KEY);
  });

  it('sends the key as x-goog-api-key on the streaming call, keeping alt=sse', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }) },
    } as any);

    const stream = provider.streamChatCompletion(
      KEY,
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    );
    // Drive the generator far enough to issue the request.
    await stream.next().catch(() => undefined);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).not.toContain(KEY);
    expect(String(url)).not.toContain('key=');
    expect(String(url)).toContain('alt=sse');
    expect(headerFrom(init as RequestInit)['x-goog-api-key']).toBe(KEY);
  });

  it('sends the key as x-goog-api-key on validateKey, never in the URL', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ models: [] }),
      headers: new Headers(),
    } as any);

    await provider.validateKey(KEY);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).not.toContain(KEY);
    expect(String(url)).not.toContain('key=');
    expect(headerFrom(init as RequestInit)['x-goog-api-key']).toBe(KEY);
  });
});
