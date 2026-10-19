import { describe, it, expect, beforeAll } from 'vitest';
import { initDb } from '../../db/index.js';
import { encrypt, decrypt, maskKey } from '../../lib/crypto.js';

describe('Crypto', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('should encrypt and decrypt a key round-trip', () => {
    const original = 'gsk_test1234567890abcdef';
    const { encrypted, iv, authTag } = encrypt(original);
    const decrypted = decrypt(encrypted, iv, authTag);
    expect(decrypted).toBe(original);
  });

  it('should produce different ciphertext for same input (random IV)', () => {
    const original = 'same-key';
    const a = encrypt(original);
    const b = encrypt(original);
    expect(a.encrypted).not.toBe(b.encrypted);
    expect(a.iv).not.toBe(b.iv);
  });

  it('should fail to decrypt with wrong auth tag', () => {
    const { encrypted, iv } = encrypt('test-key');
    expect(() => decrypt(encrypted, iv, 'a'.repeat(32))).toThrow();
  });

  it('should reject truncated auth tags (< 16 bytes) to block forgery brute-force', () => {
    const { encrypted, iv, authTag } = encrypt('test-key');
    for (const truncatedBytes of [4, 8, 12, 13, 14, 15]) {
      const truncated = authTag.slice(0, truncatedBytes * 2);
      expect(() => decrypt(encrypted, iv, truncated)).toThrow();
    }
  });

  describe('maskKey', () => {
    it('should mask long keys', () => {
      expect(maskKey('gsk_test1234567890abcdef')).toBe('gsk_...cdef');
    });

    // Regression: the old short-key branch was '****' + key.slice(-4), which
    // echoed a 4-character key back IN FULL and revealed 4 of 5 characters of a
    // 5-character key. Short keys are real (proxy credentials, self-hosted
    // Ollama tokens), and the mask is display-only — it must never be enough to
    // reconstruct the secret.
    it('should reveal nothing at all for keys shorter than 5 characters', () => {
      expect(maskKey('abcd')).toBe('****');
      expect(maskKey('abc')).toBe('****');
      expect(maskKey('a')).toBe('****');
      expect(maskKey('')).toBe('****');
    });

    it('should reveal at most the last two characters for 5-8 character keys', () => {
      expect(maskKey('abcde')).toBe('****de');
      expect(maskKey('abcdef')).toBe('****ef');
      expect(maskKey('abcdefgh')).toBe('****gh');
    });

    it('should keep the prefix+suffix form once a key is long enough', () => {
      expect(maskKey('abcdefghi')).toBe('abcd...fghi');
    });

    it('should never emit more than a third of a short key', () => {
      for (const key of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef', 'abcdefg', 'abcdefgh']) {
        const revealed = maskKey(key).replace(/[*.]/g, '');
        expect(revealed.length).toBeLessThanOrEqual(2);
        expect(maskKey(key)).not.toBe(key);
      }
    });
  });
});
