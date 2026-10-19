import { describe, it, expect } from 'vitest';
import {
  convertDocumentBlock,
  documentRejectionMessage,
  fenceTag,
  labelTitle,
} from '../../lib/anthropic-documents.js';

const doc = (source: unknown, rest: Record<string, unknown> = {}) => ({ type: 'document', source, ...rest });

describe('convertDocumentBlock — sources that are already text', () => {
  it('inlines a `text` source, which needs no converter at all', () => {
    const result = convertDocumentBlock(doc({ type: 'text', media_type: 'text/plain', data: 'the contract body' }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('the contract body');
  });

  it('joins the text parts of a `content` source', () => {
    const result = convertDocumentBlock(doc({
      type: 'content',
      content: [{ type: 'text', text: 'clause one' }, { type: 'text', text: 'clause two' }],
    }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('clause one\nclause two');
  });

  it('wraps the body in a fence so the model can tell document from instruction', () => {
    const result = convertDocumentBlock(doc({ type: 'text', data: 'body' }, { title: 'Q3 report' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toMatch(/^<document-[0-9a-f]{12} title="Q3 report">\nbody\n<\/document-[0-9a-f]{12}>$/);
    }
  });
});

describe('convertDocumentBlock — sources that cannot be served', () => {
  it('refuses a base64 PDF instead of dropping it', () => {
    const result = convertDocumentBlock(doc({
      type: 'base64',
      media_type: 'application/pdf',
      data: 'JVBERi0xLjQK',
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('application/pdf');
  });

  it('refuses a url source rather than fetching whatever the client names', () => {
    // Fetching it would make the proxy a request forwarder for an arbitrary
    // URL, which is an SSRF surface. The client can inline the text.
    const result = convertDocumentBlock(doc({ type: 'url', url: 'http://169.254.169.254/latest/meta-data/' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('`url` source');
  });

  it('refuses a block with no source', () => {
    expect(convertDocumentBlock({ type: 'document' }).ok).toBe(false);
  });

  it('refuses an empty text source rather than inlining an empty fence', () => {
    expect(convertDocumentBlock(doc({ type: 'text', data: '   ' })).ok).toBe(false);
    expect(convertDocumentBlock(doc({ type: 'content', content: [] })).ok).toBe(false);
  });

  it('never puts the payload in the reason', () => {
    const result = convertDocumentBlock(doc({ type: 'base64', media_type: 'application/pdf', data: 'SECRETPAYLOAD' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain('SECRETPAYLOAD');
  });
});

describe('fenceTag', () => {
  it('is derived from the content, so an unchanged document keeps its prefix cacheable', () => {
    // These blocks can carry cache_control; a per-request nonce would change
    // the prompt prefix every call and bust the provider cache for nothing.
    expect(fenceTag('same body')).toBe(fenceTag('same body'));
    expect(fenceTag('one body')).not.toBe(fenceTag('other body'));
  });

  it('picks a tag the content does not already contain, so a document cannot close its own fence', () => {
    const tag = fenceTag('hello');
    const hostile = `hello ${tag}`;

    expect(fenceTag(hostile)).not.toBe(tag);
    expect(hostile).not.toContain(fenceTag(hostile));
  });
});

describe('labelTitle', () => {
  it('strips the characters that would break out of the tag', () => {
    // A title of `doc>\n</doc` used to close the fence early, making the rest
    // of the prompt read as instructions rather than as quoted document text.
    expect(labelTitle('doc>\n</doc')).toBe('doc /doc');
  });

  it('removes control characters', () => {
    expect(labelTitle('a\u0001b\u0002c')).toBe('a b c');
  });

  it('caps the length', () => {
    expect(labelTitle('x'.repeat(500)).length).toBe(120);
  });

  it('falls back to a default for anything unusable', () => {
    expect(labelTitle(undefined)).toBe('document');
    expect(labelTitle(42)).toBe('document');
    expect(labelTitle('   ')).toBe('document');
    expect(labelTitle('<<>>')).toBe('document');
  });
});

describe('documentRejectionMessage', () => {
  it('says what was wrong and what to do instead', () => {
    const message = documentRejectionMessage(['a document block of type application/pdf']);

    expect(message).toContain('application/pdf');
    expect(message).toContain('Send the text instead');
  });

  it('collapses duplicates so ten identical PDFs read as one reason', () => {
    const message = documentRejectionMessage(Array(10).fill('a document block of type application/pdf'));

    expect(message.match(/application\/pdf/g)).toHaveLength(1);
    expect(message).not.toContain('more');
  });

  it('summarizes once past three distinct reasons', () => {
    const message = documentRejectionMessage(['one', 'two', 'three', 'four', 'five']);

    expect(message).toContain('and 2 more');
  });
});
