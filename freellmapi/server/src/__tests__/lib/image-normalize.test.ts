import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { normalizeMessageImages } from '../../lib/image-normalize.js';

async function solidPng(width: number, height: number, alpha: false | number = false): Promise<string> {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: alpha === false ? 3 : 4,
      background: alpha === false
        ? { r: 255, g: 0, b: 0 }
        : { r: 255, g: 0, b: 0, alpha },
    },
  }).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// Random-noise fixture so lossy re-encoding has real bytes to squeeze
// (solid colors compress to nothing and hide compression regressions).
async function noiseJpeg(width: number, height: number, quality: number): Promise<string> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function smallJpeg(width = 64, height = 64): Promise<string> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 128, b: 255 } },
  }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function dims(dataUrl: string): Promise<{ width?: number; height?: number }> {
  const meta = await sharp(Buffer.from(dataUrl.split(',')[1]!, 'base64')).metadata();
  return { width: meta.width, height: meta.height };
}

// thresholdBytes: 0 forces the decode path for every image regardless of
// size, keeping fixtures tiny; dimension behavior is what's under test.
const FORCE = { thresholdBytes: 0 };

describe('inbound image normalization', () => {
  it('downscales an oversized image to the long-edge cap and re-encodes to JPEG', async () => {
    const url = await solidPng(3000, 2000);
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url, detail: 'high' } },
      ],
    } as any];

    const summary = await normalizeMessageImages(messages, FORCE);
    expect(summary.normalized).toBe(1);

    const block = (messages[0].content as any[])[1];
    expect(block.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    // detail hint and the sibling text block survive untouched.
    expect(block.image_url.detail).toBe('high');
    expect((messages[0].content as any[])[0]).toEqual({ type: 'text', text: 'what is this?' });
    const d = await dims(block.image_url.url);
    expect(d.width).toBeLessThanOrEqual(2048);
    expect(d.height).toBeLessThanOrEqual(2048);
  });

  it('handles the shorthand string image_url form', async () => {
    const url = await solidPng(2600, 1300);
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: url }],
    } as any];

    const summary = await normalizeMessageImages(messages, FORCE);
    expect(summary.normalized).toBe(1);
    const next = (messages[0].content as any[])[0].image_url;
    expect(typeof next).toBe('string');
    expect(next.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('keeps PNG when the alpha channel actually carries transparency', async () => {
    const url = await solidPng(3000, 2000, 0.5);
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url } }],
    } as any];

    await normalizeMessageImages(messages, FORCE);
    const next = (messages[0].content as any[])[0].image_url.url;
    expect(next.startsWith('data:image/png;base64,')).toBe(true);
    const d = await dims(next);
    expect(d.width).toBeLessThanOrEqual(2048);
  });

  it('flattens opaque RGBA screenshots to JPEG (the macOS-screenshot shape)', async () => {
    // RGBA PNG, fully opaque, already under the dimension cap — exactly the
    // shape that used to stay on PNG and "compress" 2.0MB → 1.9MB.
    const url = await solidPng(1920, 1080, 1.0);
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url } }],
    } as any];

    const summary = await normalizeMessageImages(messages, FORCE);
    expect(summary.normalized).toBe(1);
    const next = (messages[0].content as any[])[0].image_url.url;
    expect(next.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('re-encodes an over-threshold JPEG that is already under the dimension cap', async () => {
    // Noisy q100 JPEG at 400px: no resize needed, but a q90 re-encode wins.
    const url = await noiseJpeg(400, 300, 100);
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url } }],
    } as any];

    const summary = await normalizeMessageImages(messages, FORCE);
    const next = (messages[0].content as any[])[0].image_url.url;
    expect(next.startsWith('data:image/jpeg;base64,')).toBe(true);
    if (summary.normalized === 1) {
      expect(summary.bytesAfter).toBeLessThan(summary.bytesBefore);
    } else {
      // The never-grow guard kept the original — it must be byte-identical.
      expect(next).toBe(url);
    }
  });

  it('leaves small compact JPEGs under the threshold untouched', async () => {
    const url = await smallJpeg();
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url } }],
    } as any];

    const summary = await normalizeMessageImages(messages); // default 1MB threshold
    expect(summary.normalized).toBe(0);
    expect((messages[0].content as any[])[0].image_url.url).toBe(url);
  });

  it('converts webp and tiff inputs to JPEG (formats most upstreams reject)', async () => {
    const raw = Buffer.alloc(300 * 200 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
    const make = (encoder: (s: any) => any) => encoder(sharp(raw, { raw: { width: 300, height: 200, channels: 3 } })).toBuffer();
    const [webpBuf, tiffBuf] = await Promise.all([make(s => s.webp({ quality: 95 })), make(s => s.tiff({ quality: 95 }))]);

    for (const buf of [webpBuf, tiffBuf]) {
      const url = `data:image/${buf[0] === 0x52 ? 'webp' : 'tiff'};base64,${buf.toString('base64')}`;
      const messages: ChatMessage[] = [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url } }],
      } as any];
      const summary = await normalizeMessageImages(messages, FORCE);
      expect(summary.normalized).toBe(1);
      expect((messages[0].content as any[])[0].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    }
  });

  it('clamps an out-of-range quality instead of failing', async () => {
    const url = await solidPng(1920, 1080, 1.0);
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url } }],
    } as any];

    // 999 must not reach sharp as-is; the pipeline still produces a JPEG.
    const summary = await normalizeMessageImages(messages, { thresholdBytes: 0, quality: 999 });
    expect(summary.normalized).toBe(1);
    expect((messages[0].content as any[])[0].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('leaves http(s) URLs alone (providers fetch them themselves)', async () => {
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
    } as any];

    const summary = await normalizeMessageImages(messages, FORCE);
    expect(summary.normalized).toBe(0);
    expect((messages[0].content as any[])[0].image_url.url).toBe('https://example.com/x.png');
  });

  it('is a no-op when disabled', async () => {
    const url = await solidPng(3000, 2000);
    const messages: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url } }],
    } as any];

    const summary = await normalizeMessageImages(messages, { ...FORCE, enabled: false });
    expect(summary.normalized).toBe(0);
    expect((messages[0].content as any[])[0].image_url.url).toBe(url);
  });

  it('never throws on a corrupt image and keeps the original', async () => {
    const bad = 'data:image/png;base64,not-really-base64-image-bytes';
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: bad } }] } as any,
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ];

    const summary = await normalizeMessageImages(messages, FORCE);
    expect(summary.normalized).toBe(0);
    expect((messages[0].content as any[])[0].image_url.url).toBe(bad);
    // Non-image messages pass through byte-identical.
    expect(messages[1].tool_calls?.[0].id).toBe('c1');
  });

  it('respects IMAGE_NORMALIZE env knobs read lazily', async () => {
    process.env.IMAGE_NORMALIZE = 'off';
    try {
      const url = await solidPng(3000, 2000);
      const messages: ChatMessage[] = [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url } }],
      } as any];
      const summary = await normalizeMessageImages(messages); // no overrides: env wins
      expect(summary.normalized).toBe(0);
    } finally {
      delete process.env.IMAGE_NORMALIZE;
    }
  });
});
