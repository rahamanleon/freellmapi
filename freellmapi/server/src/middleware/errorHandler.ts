import type { Request, Response, NextFunction } from 'express';
import { logRequest } from '../lib/request-log.js';

// The inference wire surfaces whose over-limit bodies deserve an analytics
// row — the dashboard renders them like any failed request instead of the
// rejection being visible only in the container log.
const INFERENCE_PATH_PREFIXES = ['/v1', '/v1beta', '/mcp'];

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';
  console.error('[Error]', isProduction ? err : err.message);

  if (res.headersSent) return next(err);

  const status = (err as any).status ?? 500;

  // body-parser rejects bodies over the configured limit with its own error
  // shape ('PayloadTooLargeError', type 'entity.too.large'). Agents reading
  // the OpenAI error contract saw an opaque 413; normalize it, and record the
  // rejection in request analytics so it shows up in the dashboard like the
  // upstream-413 path that the fallback loop already logs.
  if ((err as any).type === 'entity.too.large' || status === 413) {
    const limit = (err as any).limit;
    const received = (err as any).length ?? (err as any).expected;
    const message = `Request body too large${typeof received === 'number' ? ` (${received} bytes)` : ''}` +
      `${typeof limit === 'number' ? ` for the ${limit}-byte limit` : ''}. ` +
      'Vision requests embed base64 images in the body; raise REQUEST_BODY_LIMIT_MB (default 25) to accept larger payloads.';
    if (INFERENCE_PATH_PREFIXES.some(prefix => req.path.startsWith(prefix))) {
      logRequest('proxy', 'payload-too-large', null, 'error', 0, 0, 0, message);
    }
    res.status(413).json({
      error: {
        message,
        type: 'invalid_request_error',
        code: 'request_too_large',
      },
    });
    return;
  }

  const message = isProduction && status >= 500
    ? 'Internal server error'
    : err.message;
  res.status(status).json({
    error: {
      message,
      type: err.name ?? 'server_error',
    },
  });
}
