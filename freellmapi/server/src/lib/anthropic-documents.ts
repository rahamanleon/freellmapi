import crypto from 'crypto';

/**
 * Anthropic `document` content blocks on a surface whose providers are all
 * text-and-image only.
 *
 * Today such a block passes the permissive envelope schema and is then dropped
 * with every other unrecognised type, so a client that attaches a PDF gets a
 * confident answer about a document the model never saw. That is the worst of
 * the available behaviours: worse than refusing, because nothing tells the
 * caller their attachment went nowhere.
 *
 * Anthropic defines four source kinds, and they split cleanly:
 *
 *   text, content  — the document IS text already. Converting it costs nothing
 *                    and needs nothing installed, so we do it.
 *   base64, url    — the bytes need a real converter (PDF, DOCX, XLSX…). No
 *                    provider in the pool accepts them and nothing here can
 *                    decode them, so these are refused with an actionable
 *                    message instead of being silently discarded.
 *
 * Stringifying the block instead — which is what a naive passthrough does —
 * would inject an entire base64 payload into the prompt. That is not a cheaper
 * version of support; it is a way to burn a context window on nothing.
 */

/** Source kinds that are already text, so they need no converter. */
const TEXTUAL_SOURCE_TYPES = new Set(['text', 'content']);

/** Longest title we will echo into the prompt. */
const MAX_TITLE_LENGTH = 120;

/** C0 controls, DEL, and the C1 range — they can carry terminal escapes. */
// eslint-disable-next-line no-control-regex -- matching control chars is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface DocumentBlockOk {
  ok: true;
  /** The text block body to substitute for the document block. */
  text: string;
}

export interface DocumentBlockRejected {
  ok: false;
  /** Caller-facing reason, already phrased to slot into an error response. */
  reason: string;
}

export type DocumentBlockResult = DocumentBlockOk | DocumentBlockRejected;

/**
 * A fence tag derived from the CONTENT, as `document-<12 hex>`.
 *
 * Deliberately not random: these blocks can carry `cache_control`, and a
 * per-request nonce would change the prompt prefix on every call and bust the
 * provider's cache for no benefit.
 *
 * Deliberately not the client's title either. A title of `doc>\n</doc` closes
 * the fence early, and everything after it reads to the model as instructions
 * rather than as quoted document text.
 */
export function fenceTag(content: string): string {
  const digest = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  for (let offset = 0; offset + 12 <= digest.length; offset += 12) {
    const candidate = `document-${digest.slice(offset, offset + 12)}`;
    // A tag that already appears in the content would let the document close
    // its own fence. Walk to the next slice rather than giving up.
    if (!content.includes(candidate)) return candidate;
  }
  return `document-${digest.slice(0, 12)}`;
}

/**
 * A title safe to echo inside the fence: no control characters, no angle
 * brackets or quotes (they break out of the tag), collapsed whitespace,
 * bounded length.
 */
export function labelTitle(raw: unknown): string {
  if (typeof raw !== 'string') return 'document';
  const cleaned = raw
    .replace(CONTROL_CHARS, ' ')
    .replace(/[<>"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : 'document';
}

/** The text carried by a `content` source: its text blocks, joined. */
function textFromContentSource(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object' && typeof (block as any).text === 'string') return (block as any).text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Convert one Anthropic `document` block into the text that stands in for it,
 * or explain why it cannot be converted.
 */
export function convertDocumentBlock(block: unknown): DocumentBlockResult {
  const source = (block as any)?.source;
  if (!source || typeof source !== 'object') {
    return { ok: false, reason: 'a document block without a `source`' };
  }

  const sourceType = typeof source.type === 'string' ? source.type : '';

  if (!TEXTUAL_SOURCE_TYPES.has(sourceType)) {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : '';
    if (sourceType === 'url') return { ok: false, reason: 'a document block with a `url` source' };
    return {
      ok: false,
      reason: `a document block of type ${mediaType || sourceType || 'unknown'}`,
    };
  }

  const body = sourceType === 'text'
    ? (typeof source.data === 'string' ? source.data : '')
    : textFromContentSource(source.content);

  if (body.trim().length === 0) {
    return { ok: false, reason: 'a document block whose text source is empty' };
  }

  const tag = fenceTag(body);
  const title = labelTitle((block as any)?.title);
  return { ok: true, text: `<${tag} title="${title}">\n${body}\n</${tag}>` };
}

/**
 * The error message for one or more unconvertible documents. Names what was
 * wrong and then what to do instead — a caller that only learns "unsupported"
 * has to guess at the fix.
 */
export function documentRejectionMessage(reasons: string[]): string {
  const unique = [...new Set(reasons)];
  const listed = unique.slice(0, 3).join(', ');
  const extra = unique.length > 3 ? `, and ${unique.length - 3} more` : '';
  return (
    `This request contains ${listed}${extra}. ` +
    'Binary document attachments are not supported: no provider in the pool accepts them, ' +
    'and forwarding the request anyway would silently drop the attachment from the prompt. ' +
    'Send the text instead — either a `text` content block, or a document block with a ' +
    '`text` or `content` source, both of which are passed through.'
  );
}
