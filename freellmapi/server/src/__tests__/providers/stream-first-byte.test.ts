import http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { GoogleProvider } from '../../providers/google.js';
import { resetTimeoutWarnings } from '../../lib/provider-timeout.js';
import { isClientAbortError, isRetryableError, newClientAbortError } from '../../lib/error-classify.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

/**
 * First-byte grace period for streaming (issue #584).
 *
 * The stream stall watchdog (readWithStallTimeout, default 90s) also bounded
 * TIME-TO-FIRST-BYTE: on streaming requests the per-platform chat timeout is
 * disarmed the moment response HEADERS arrive, and providers like NVIDIA NIM
 * send SSE headers instantly then prefill for minutes on 100k-token prompts.
 * Healthy long prefills died at 90s with "stream stalled: no data for 90000ms".
 *
 * The fix gives the FIRST read its own budget — the platform's already-tuned
 * chat timeout (env-overridable via PROVIDER_TIMEOUT_<PLATFORM>), floored at
 * the stall budget so it can never be stricter than before — while subsequent
 * reads keep the mid-stream stall budget (PROVIDER_STREAM_STALL_TIMEOUT_MS,
 * now also per-platform via PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM>).
 */

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const STALL_ENV_VARS = [
  'PROVIDER_STREAM_STALL_TIMEOUT_MS',
  'PROVIDER_STREAM_STALL_TIMEOUT_GROQ',
  'PROVIDER_STREAM_STALL_TIMEOUT_NVIDIA',
  'PROVIDER_STREAM_STALL_TIMEOUT_GOOGLE',
  'PROVIDER_TIMEOUT_GROQ',
  'PROVIDER_TIMEOUT_GOOGLE',
];

function makeProvider(timeoutMs: number): OpenAICompatProvider {
  return new OpenAICompatProvider({
    platform: 'groq',
    name: 'TestProvider',
    baseUrl: 'https://api.test.com/v1',
    timeoutMs,
  });
}

/** SSE response whose body emits each segment after its own delay (ms from
 * the PREVIOUS segment), then closes. */
function delayedSseResponse(segments: Array<{ afterMs: number; data: string }>): any {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let at = 0;
      for (const seg of segments) {
        at += seg.afterMs;
        setTimeout(() => {
          try { controller.enqueue(encoder.encode(seg.data)); } catch { /* closed */ }
        }, at);
      }
      setTimeout(() => {
        try { controller.close(); } catch { /* closed */ }
      }, at + 10);
    },
  });
  return { ok: true, body: stream, headers: new Headers() };
}

async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

const CONTENT_FRAME = 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n';
const FINISH_FRAME = 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

afterEach(() => {
  for (const name of STALL_ENV_VARS) delete process.env[name];
  resetTimeoutWarnings();
  vi.restoreAllMocks();
});

describe('first-byte grace period (issue #584)', () => {
  it('a stream silent past the stall timeout, then delivering, succeeds under the chat-timeout grace (the #584 repro)', async () => {
    // Stall budget 100ms; chat timeout (= first-byte grace) 1500ms. The
    // upstream sends nothing for 400ms — over the stall budget, within the
    // grace — then a normal completion. Pre-fix this died at the stall budget.
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '100';
    const provider = makeProvider(1500);
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 400, data: CONTENT_FRAME },
      { afterMs: 10, data: FINISH_FRAME },
    ]));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
  });

  it('a mid-stream gap past the stall timeout still fails fast with the stall message', async () => {
    // First byte arrives instantly (grace satisfied); the stream then goes
    // silent past the stall budget — the watchdog must still fire.
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '100';
    const provider = makeProvider(1500);
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 0, data: CONTENT_FRAME },
      { afterMs: 600, data: FINISH_FRAME },
    ]));

    const err = await collect(provider.streamChatCompletion('k', MESSAGES, 'm')).then(() => null, e => e);
    expect(err).not.toBeNull();
    expect(err.message).toContain('stream stalled: no data for 100ms');
    expect(isRetryableError(err)).toBe(true);
  });

  it('no first byte within the grace budget fails with the distinct first-byte message', async () => {
    // Chat timeout 200ms, stall 100ms → first-byte budget max(200,100)=200ms.
    // The upstream stays silent for 800ms. The error must say "no first byte",
    // not "stream stalled" — distinct wording for the attempt-trace summary.
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '100';
    const provider = makeProvider(200);
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 800, data: CONTENT_FRAME + FINISH_FRAME },
    ]));

    const err = await collect(provider.streamChatCompletion('k', MESSAGES, 'm')).then(() => null, e => e);
    expect(err).not.toBeNull();
    expect(err.message).toContain('no first byte within 200ms');
    expect(err.message).not.toContain('stream stalled');
    // Fires before any byte reached the client — must fail over invisibly.
    expect(isRetryableError(err)).toBe(true);
  });

  it('the first-byte grace never tightens below the stall budget (short chat timeout)', async () => {
    // Chat timeout 100ms but stall budget 600ms: pre-grace the first read had
    // the full stall budget, and the grace must not make it stricter. First
    // byte at 300ms — over the chat timeout, under the stall budget — succeeds.
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '600';
    const provider = makeProvider(100);
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 300, data: CONTENT_FRAME + FINISH_FRAME },
    ]));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hello');
  });

  it('PROVIDER_TIMEOUT_<PLATFORM>=0 disables the first-byte bound but keeps the mid-stream watchdog', async () => {
    process.env.PROVIDER_TIMEOUT_GROQ = '0';
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '100';
    const provider = makeProvider(200); // env 0 overrides the constructor value
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 500, data: CONTENT_FRAME }, // way past both budgets: only OK if unbounded
      { afterMs: 600, data: FINISH_FRAME },  // mid-stream gap: watchdog must still fire
    ]));

    const startedAt = Date.now();
    const err = await collect(provider.streamChatCompletion('k', MESSAGES, 'm')).then(() => null, e => e);
    expect(err).not.toBeNull();
    expect(err.message).toContain('stream stalled: no data for 100ms');
    // The failure must be the MID-STREAM gap (after the 500ms unbounded first
    // byte), not a stall-bounded first read firing at 100ms.
    expect(Date.now() - startedAt).toBeGreaterThan(450);
  });
});

describe('per-platform stall override PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM>', () => {
  it('wins over the global PROVIDER_STREAM_STALL_TIMEOUT_MS', async () => {
    // Global would allow the 400ms mid-stream gap; the per-platform 100ms
    // must be the one that fires.
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '60000';
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_GROQ = '100';
    const provider = makeProvider(1500);
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 0, data: CONTENT_FRAME },
      { afterMs: 400, data: FINISH_FRAME },
    ]));

    const err = await collect(provider.streamChatCompletion('k', MESSAGES, 'm')).then(() => null, e => e);
    expect(err).not.toBeNull();
    expect(err.message).toContain('stream stalled: no data for 100ms');
  });

  it('an override for a DIFFERENT platform leaves this one on the global value', async () => {
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '60000';
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_NVIDIA = '100';
    const provider = makeProvider(1500); // platform groq
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 0, data: CONTENT_FRAME },
      { afterMs: 300, data: FINISH_FRAME },
    ]));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.some(c => c.choices?.[0]?.finish_reason === 'stop')).toBe(true);
  });
});

describe('google adapter first-byte grace (own stream reader)', () => {
  const GOOGLE_FRAME = 'data: {"candidates":[{"content":{"parts":[{"text":"hi there"}]},"finishReason":"STOP"}]}\n\n';

  it('a Gemini stream silent past the stall timeout, then delivering, succeeds under the grace', async () => {
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '100';
    const provider = new GoogleProvider({ timeoutMs: 1500 });
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 400, data: GOOGLE_FRAME },
    ]));

    const chunks = await collect(provider.streamChatCompletion('k', MESSAGES, 'gemini-test'));
    expect(chunks.map(c => c.choices?.[0]?.delta?.content ?? '')).toContain('hi there');
  });

  it('a Gemini stream with no first byte within the grace fails with the first-byte message', async () => {
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '100';
    const provider = new GoogleProvider({ timeoutMs: 200 });
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 800, data: GOOGLE_FRAME },
    ]));

    const err = await collect(provider.streamChatCompletion('k', MESSAGES, 'gemini-test')).then(() => null, e => e);
    expect(err).not.toBeNull();
    expect(err.message).toContain('no first byte within 200ms');
  });

  it('a Gemini mid-stream gap past the stall timeout still fails fast', async () => {
    process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS = '100';
    const provider = new GoogleProvider({ timeoutMs: 1500 });
    const partial = 'data: {"candidates":[{"content":{"parts":[{"text":"start"}]}}]}\n\n';
    vi.spyOn(global, 'fetch').mockResolvedValue(delayedSseResponse([
      { afterMs: 0, data: partial },
      { afterMs: 500, data: GOOGLE_FRAME },
    ]));

    const err = await collect(provider.streamChatCompletion('k', MESSAGES, 'gemini-test')).then(() => null, e => e);
    expect(err).not.toBeNull();
    expect(err.message).toContain('stream stalled: no data for 100ms');
  });
});

describe('client abort composition under the grace period (#601 non-regression)', () => {
  it('a client abort while waiting for the first byte rejects promptly with the marked reason, not a timeout', async () => {
    // Real loopback upstream: undici's signal wiring is the behavior under
    // test. SSE headers arrive instantly, then no body bytes — the consumer is
    // parked in the FIRST read, under a long grace budget. The disconnect must
    // surface immediately as the marked client abort, not wait out any budget.
    let sawClose!: () => void;
    const closed = new Promise<void>(resolve => { sawClose = resolve; });
    const server = http.createServer((_req, res) => {
      res.on('close', sawClose);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // hold the connection open, silent
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const provider = new OpenAICompatProvider({
        platform: 'groq', name: 'TestProvider',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        timeoutMs: 30_000, // long grace: the abort must NOT wait for it
      });
      const clientAbort = new AbortController();
      const startedAt = Date.now();
      const pending = collect(provider.streamChatCompletion('k', MESSAGES, 'm', { signal: clientAbort.signal }));
      setTimeout(() => clientAbort.abort(newClientAbortError()), 100);

      const err = await pending.then(() => null, e => e);
      expect(err).not.toBeNull();
      expect(isClientAbortError(err)).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(3000);
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
