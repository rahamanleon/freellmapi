import { describe, it, expect } from 'vitest';
import {
  isRetryableError,
  isTransportError,
  newClientAbortError,
  newHedgeAbortError,
} from '../../lib/error-classify.js';

/** Build `new Error(message)` with an undici-style `code`, wrapped in `depth`
 * generic wrappers whose own messages match NONE of the top-level substring
 * rules — the exact shape that used to slip through as fatal. */
function wrapped(depth: number, inner: Error): Error {
  let cur: Error = inner;
  for (let i = 0; i < depth; i++) {
    cur = new Error('Provider request failed', { cause: cur });
  }
  return cur;
}

function coded(code: string, message = 'read ECONN'): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = code;
  return err;
}

describe('transport errors carried in err.cause', () => {
  describe('codes anywhere in the chain are retryable', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN']) {
      it(`${code} behind a generic wrapper`, () => {
        const err = wrapped(1, coded(code, 'socket failure'));
        expect(isTransportError(err)).toBe(true);
        expect(isRetryableError(err)).toBe(true);
      });
    }

    for (const code of ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
      it(`undici ${code} behind a generic wrapper`, () => {
        const err = wrapped(1, coded(code, 'undici transport failure'));
        expect(isRetryableError(err)).toBe(true);
      });
    }

    it('matches a transport code on the top-level error itself (depth 0)', () => {
      expect(isRetryableError(coded('ECONNRESET', 'boom'))).toBe(true);
    });
  });

  describe('message hints anywhere in the chain are retryable', () => {
    for (const message of [
      'socket hang up',
      'Premature close',
      'other side closed',
      'Client network socket disconnected before secure TLS connection was established',
    ]) {
      it(`"${message}" behind a generic wrapper`, () => {
        const err = wrapped(1, new Error(message));
        expect(isTransportError(err)).toBe(true);
        expect(isRetryableError(err)).toBe(true);
      });
    }

    it('undici\'s bare "terminated" body error is retryable', () => {
      expect(isRetryableError(new Error('terminated'))).toBe(true);
      expect(isRetryableError(wrapped(2, new Error('terminated')))).toBe(true);
    });

    // "terminated" is matched as a WHOLE message only: a terminated ACCOUNT is
    // fatal and must not be retried around the entire chain.
    it('does not treat "account has been terminated" as transport', () => {
      const err: any = new Error('API error 403: your account has been terminated');
      // Retryable via the 403 rule, but NOT because of the transport walk.
      expect(isTransportError(err)).toBe(false);
    });
  });

  describe('walk is bounded and cycle-safe', () => {
    it('finds a cause nested at depth 5', () => {
      expect(isTransportError(wrapped(5, coded('ECONNRESET', 'socket failure')))).toBe(true);
    });

    it('stops before an absurdly deep chain', () => {
      expect(isTransportError(wrapped(40, coded('ECONNRESET', 'socket failure')))).toBe(false);
    });

    it('does not hang on a self-referential cause', () => {
      const err: any = new Error('Provider request failed');
      err.cause = err;
      expect(isTransportError(err)).toBe(false);
    });

    it('does not hang on a two-link cause cycle', () => {
      const a: any = new Error('Provider request failed');
      const b: any = new Error('Also failed', { cause: a });
      a.cause = b;
      expect(isTransportError(a)).toBe(false);
    });

    it('tolerates non-object and null causes', () => {
      expect(isTransportError(null)).toBe(false);
      expect(isTransportError(undefined)).toBe(false);
      expect(isTransportError(new Error('nope', { cause: 'ECONNRESET' }))).toBe(false);
      expect(isTransportError(new Error('nope', { cause: undefined }))).toBe(false);
    });
  });

  describe('fatal classes stay non-retryable', () => {
    it('a 401 bad key is not made retryable by the cause walk', () => {
      const err: any = new Error('API error 401: Invalid API key');
      err.status = 401;
      expect(isTransportError(err)).toBe(false);
      expect(isRetryableError(err)).toBe(false);
    });

    // undici labels an aborted socket UND_ERR_ABORTED — the same family a real
    // mid-flight socket death carries — so the marked abort errors must win.
    it('a client abort wrapped in an undici UND_ERR_ABORTED stays non-retryable', () => {
      const abort = newClientAbortError();
      const err = new Error('Provider request failed', { cause: abort });
      (err as any).code = 'UND_ERR_ABORTED';
      expect(isTransportError(err)).toBe(false);
      expect(isRetryableError(err)).toBe(false);
    });

    it('a bare client abort stays non-retryable', () => {
      expect(isTransportError(newClientAbortError())).toBe(false);
      expect(isRetryableError(newClientAbortError())).toBe(false);
    });

    it('the fallback time-budget hedge abort stays non-retryable', () => {
      const hedge = newHedgeAbortError();
      (hedge as any).code = 'UND_ERR_ABORTED';
      expect(isTransportError(hedge)).toBe(false);
      expect(isRetryableError(hedge)).toBe(false);
    });

    it('an ordinary validation 400 is untouched', () => {
      const err: any = new Error('Bad Request: messages must be an array');
      err.status = 400;
      expect(isTransportError(err)).toBe(false);
      expect(isRetryableError(err)).toBe(false);
    });

    it('a generic wrapper with no transport evidence stays non-retryable', () => {
      expect(isTransportError(wrapped(3, new Error('model refused the prompt')))).toBe(false);
    });
  });
});
