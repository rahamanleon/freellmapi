import crypto from 'crypto';
import type { Request, Response } from 'express';
import { runSearch, SearchError, searchAvailable } from '../services/search.js';

// Shared plumbing for answering an agent's built-in web search from the
// gateway's own search pool (#1174): Codex's Responses `web_search` tool and
// Claude Code's Anthropic `web_search_*` server tool. Both surfaces hand the
// routed model a plain function tool named `web_search`, run the model's calls
// here through runSearch, and replay the results until the model answers.
//
// With no search-capable key the surfaces never reach this module and keep
// their previous behaviour (the built-in tool is dropped or passed through).

/** The function name the routed model sees. Matches both protocols' built-in
 *  tool name, so a model that already knows the convention calls it naturally. */
export const WEB_SEARCH_TOOL_NAME = 'web_search';

export const WEB_SEARCH_FUNCTION_DESCRIPTION =
  'Search the web for current information. Use it when the answer depends on recent events, prices, '
  + 'releases or anything that may have changed since your training data. Returns titles, URLs and '
  + 'short extracts; cite the URLs you rely on.';

export const WEB_SEARCH_FUNCTION_PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'The search query.' },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

/** Default and ceiling for searches per request when the client sets none. */
export const DEFAULT_MAX_SEARCHES = 5;
export const MAX_SEARCHES_CEILING = 20;
const RESULTS_PER_SEARCH = 5;
const MAX_QUERY_CHARS = 400;
const EXTRACT_CHARS = 1_200;

/** True when at least one enabled search engine has a usable key — the same
 *  check /v1/search routes with, so agents' web search only switches on when a
 *  search can actually run. */
export function hasSearchCapability(): boolean {
  try {
    return searchAvailable();
  } catch {
    return false;
  }
}

export interface WebSearchHit {
  title: string;
  url: string;
  content: string;
  score: number;
}

export type WebSearchErrorCode = 'too_many_requests' | 'invalid_tool_input' | 'max_uses_exceeded' | 'query_too_long' | 'unavailable';

export type WebSearchOutcome =
  | { ok: true; query: string; results: WebSearchHit[]; engine?: string; provider?: string }
  | { ok: false; query: string; errorCode: WebSearchErrorCode; message: string };

export interface DomainFilter {
  allowedDomains?: string[];
  blockedDomains?: string[];
}

function normalizeDomainRule(rule: string): { host: string; path: string } | null {
  const trimmed = rule.trim().toLowerCase().replace(/^[a-z]+:\/\//, '');
  if (!trimmed) return null;
  const slash = trimmed.indexOf('/');
  const host = (slash === -1 ? trimmed : trimmed.slice(0, slash)).replace(/^\*\./, '').replace(/^www\./, '');
  const path = slash === -1 ? '' : trimmed.slice(slash);
  return host ? { host, path } : null;
}

function urlMatchesRule(url: URL, rule: { host: string; path: string }): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== rule.host && !host.endsWith(`.${rule.host}`)) return false;
  return rule.path === '' || url.pathname.toLowerCase().startsWith(rule.path);
}

/** Apply allowed/blocked domain lists (Anthropic `allowed_domains`, Responses
 *  `filters.allowed_domains`). Search providers differ in native support, so
 *  the gateway filters the hits itself. */
export function filterHitsByDomain(hits: WebSearchHit[], filter: DomainFilter): WebSearchHit[] {
  const allowed = (filter.allowedDomains ?? []).map(normalizeDomainRule).filter((r): r is NonNullable<typeof r> => r != null);
  const blocked = (filter.blockedDomains ?? []).map(normalizeDomainRule).filter((r): r is NonNullable<typeof r> => r != null);
  if (allowed.length === 0 && blocked.length === 0) return hits;
  return hits.filter(hit => {
    let url: URL;
    try { url = new URL(hit.url); } catch { return false; }
    if (blocked.some(rule => urlMatchesRule(url, rule))) return false;
    if (allowed.length > 0 && !allowed.some(rule => urlMatchesRule(url, rule))) return false;
    return true;
  });
}

/** Restrict a query to the allowed domains with `site:` operators, so a
 *  provider returns in-scope hits instead of the post-filter emptying them. */
function scopedQuery(query: string, filter: DomainFilter): string {
  const allowed = (filter.allowedDomains ?? []).map(normalizeDomainRule).filter((r): r is NonNullable<typeof r> => r != null);
  if (allowed.length === 0 || allowed.length > 5) return query;
  const sites = allowed.map(r => `site:${r.host}`).join(' OR ');
  return `${query} (${sites})`;
}

/** Run one search on behalf of an agent. Never throws: failures become the
 *  protocol's in-band error result so the model can carry on without it. */
export async function performWebSearch(rawQuery: unknown, filter: DomainFilter = {}): Promise<WebSearchOutcome> {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (!query) return { ok: false, query: '', errorCode: 'invalid_tool_input', message: 'missing query' };
  if (query.length > MAX_QUERY_CHARS) return { ok: false, query, errorCode: 'query_too_long', message: 'query too long' };
  try {
    const response = await runSearch(scopedQuery(query, filter), { maxResults: RESULTS_PER_SEARCH * 2 });
    const hits = filterHitsByDomain(response.results, filter).slice(0, RESULTS_PER_SEARCH);
    const engine = (response as { engine?: unknown }).engine;
    return {
      ok: true,
      query,
      results: hits,
      provider: response.provider,
      ...(typeof engine === 'string' ? { engine } : {}),
    };
  } catch (err: unknown) {
    const status = err instanceof SearchError ? err.status : 502;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, query, errorCode: status === 429 ? 'too_many_requests' : 'unavailable', message };
  }
}

/** The tool-result text the routed model reads for one search. */
export function formatOutcomeForModel(outcome: WebSearchOutcome): string {
  if (!outcome.ok) {
    if (outcome.errorCode === 'max_uses_exceeded') {
      return 'Web search is unavailable: the search limit for this request has been reached. Answer with what you already have.';
    }
    return `Web search failed (${outcome.errorCode}). Answer from what you already know, and say the search did not work if it matters.`;
  }
  if (outcome.results.length === 0) return `No web results found for "${outcome.query}".`;
  const lines = [`Web results for "${outcome.query}":`];
  outcome.results.forEach((hit, i) => {
    lines.push('', `[${i + 1}] ${hit.title || hit.url}`, `URL: ${hit.url}`);
    const extract = hit.content.replace(/\s+/g, ' ').trim().slice(0, EXTRACT_CHARS);
    if (extract) lines.push(extract);
  });
  return lines.join('\n');
}

// ── Replay of earlier search results ────────────────────────────────────────
// Clients send previous turns back verbatim. Anthropic results carry an opaque
// `encrypted_content` per hit; ours is a tagged base64url JSON of the extract,
// so a later turn can restore what the model read. Foreign (real Anthropic)
// blobs are left opaque and only the title/URL survive.

const CONTENT_TAG = 'fllm1.';

export function encodeHitContent(hit: WebSearchHit): string {
  const payload = JSON.stringify({ c: hit.content.slice(0, EXTRACT_CHARS) });
  return CONTENT_TAG + Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeHitContent(encrypted: unknown): string {
  if (typeof encrypted !== 'string' || !encrypted.startsWith(CONTENT_TAG)) return '';
  try {
    const parsed = JSON.parse(Buffer.from(encrypted.slice(CONTENT_TAG.length), 'base64url').toString('utf8'));
    return typeof parsed?.c === 'string' ? parsed.c : '';
  } catch {
    return '';
  }
}

export function newServerToolUseId(): string {
  return `srvtoolu_${crypto.randomBytes(12).toString('hex')}`;
}

export function newWebSearchCallId(): string {
  return `ws_${crypto.randomBytes(16).toString('hex')}`;
}

// ── In-process re-entry into a route handler ────────────────────────────────
// The search loop re-runs the surface's own handler (auth, routing, failover,
// analytics, tool repair — all unchanged) once per model turn, non-streaming,
// and captures what it would have sent. Only the response members those
// handlers touch are implemented.

export interface CapturedResponse {
  status: number;
  body: any;
  headers: Record<string, string>;
}

type Handler = (req: Request, res: Response) => Promise<void> | void;

class CaptureResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: any = undefined;
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  locals: Record<string, unknown> = {};
  private closeListeners: Array<() => void> = [];
  private chunks: string[] = [];

  status(code: number) { this.statusCode = code; return this; }
  setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = String(value); return this; }
  getHeader(name: string) { return this.headers[name.toLowerCase()]; }
  removeHeader(name: string) { delete this.headers[name.toLowerCase()]; }
  json(body: unknown) { this.body = body; this.finish(); return this; }
  send(body: unknown) { this.body = body; this.finish(); return this; }
  write(chunk: unknown) { this.headersSent = true; this.chunks.push(String(chunk)); return true; }
  end(chunk?: unknown) {
    if (chunk != null) this.chunks.push(String(chunk));
    if (this.body === undefined && this.chunks.length > 0) this.body = this.chunks.join('');
    this.finish();
    return this;
  }
  flushHeaders() { this.headersSent = true; }
  on(event: string, fn: () => void) { if (event === 'close') this.closeListeners.push(fn); return this; }
  once(event: string, fn: () => void) { return this.on(event, fn); }
  off() { return this; }
  removeListener() { return this; }
  /** The real client went away: tell the inner handler, as a socket close would. */
  abort() { this.destroyed = true; for (const fn of this.closeListeners) { try { fn(); } catch { /* ignore */ } } }
  private finish() {
    if (this.writableEnded) return;
    this.headersSent = true;
    this.writableEnded = true;
    for (const fn of this.closeListeners) { try { fn(); } catch { /* ignore */ } }
  }
}

/** Run `handler` with `body` in place of the client's body and capture its
 *  reply. A disconnect of the real client aborts the inner call. */
export async function invokeHandlerCaptured(handler: Handler, req: Request, outer: Response, body: unknown): Promise<CapturedResponse> {
  const capture = new CaptureResponse();
  const innerReq = Object.create(req) as Request;
  Object.defineProperty(innerReq, 'body', { value: body, writable: true, enumerable: true, configurable: true });
  const onOuterClose = () => { if (!outer.writableEnded) capture.abort(); };
  outer.on('close', onOuterClose);
  try {
    await handler(innerReq, capture as unknown as Response);
  } finally {
    outer.off('close', onOuterClose);
  }
  let parsed = capture.body;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { /* keep raw */ }
  }
  return { status: capture.statusCode, body: parsed, headers: capture.headers };
}

/** Copy the inner turn's diagnostic headers onto the real response. */
export function copyCapturedHeaders(captured: CapturedResponse, res: Response): void {
  for (const [name, value] of Object.entries(captured.headers)) {
    if (name === 'content-type' || name === 'content-length') continue;
    try { res.setHeader(name, value); } catch { /* headers already sent */ }
  }
}

/** Clamp a client-supplied max_uses. */
export function resolveMaxSearches(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_SEARCHES;
  return Math.min(Math.floor(raw), MAX_SEARCHES_CEILING);
}
