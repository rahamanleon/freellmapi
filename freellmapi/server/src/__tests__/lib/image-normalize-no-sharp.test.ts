import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';

// sharp is a NATIVE module. It is loaded with a dynamic import precisely so a
// missing or mismatched prebuilt libvips cannot take the gateway down at
// import time — the desktop build only electron-rebuilds better-sqlite3, and
// slim/musl containers routinely ship without the matching binary. This is the
// degraded path: images must ride through untouched and the request must still
// be served.
//
// Own file because the resolved module is cached in module state after the
// first call; vitest isolates the registry per file, so the failure is only
// observable from a file that has never loaded the real sharp.
vi.mock('sharp', () => ({
  get default(): never {
    throw new Error(
      "Could not load the 'sharp' module using the linux-x64 runtime",
    );
  },
}));

const { normalizeMessageImages } = await import('../../lib/image-normalize.js');

// A data URL big enough to clear every threshold — it must survive byte-for-byte.
const BIG_IMAGE = `data:image/png;base64,${'A'.repeat(2_000_000)}`;

function imageTurn(url: string): ChatMessage[] {
  return [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url } },
    ],
  } as any];
}

describe('inbound image normalization without sharp', () => {
  it('passes images through untouched instead of throwing', async () => {
    const messages = imageTurn(BIG_IMAGE);

    const summary = await normalizeMessageImages(messages, { thresholdBytes: 0 });

    expect(summary.normalized).toBe(0);
    expect(summary.bytesBefore).toBe(0);
    expect(summary.bytesAfter).toBe(0);
    // Same array, same bytes: the request is served exactly as it was before
    // this module existed.
    expect(summary.messages).toBe(messages);
    expect((messages[0].content as any[])[1].image_url.url).toBe(BIG_IMAGE);
  });

  it('warns once, not once per image', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await normalizeMessageImages(imageTurn(BIG_IMAGE), { thresholdBytes: 0 });
      await normalizeMessageImages(imageTurn(BIG_IMAGE), { thresholdBytes: 0 });
      // The failed load is remembered, so a busy gateway does not reprint the
      // warning (or retry the import) on every vision request.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('still honours the disable switch', async () => {
    const messages = imageTurn(BIG_IMAGE);
    const summary = await normalizeMessageImages(messages, { enabled: false });
    expect(summary.normalized).toBe(0);
    expect(summary.messages).toBe(messages);
  });
});
