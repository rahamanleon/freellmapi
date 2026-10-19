import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import {
  rotateSecrets,
  applyRotation,
  encryptWith,
  decryptWith,
} from '../../scripts/rotate-encryption-key.js';

const OLD_KEY = Buffer.from('a'.repeat(64), 'hex'); // 64 hex chars
const NEW_KEY = Buffer.from('b'.repeat(64), 'hex');

// Seed one row in every encryption group with the OLD key.
function seedRows() {
  const db = getDb();
  const keyEnc = encryptWith(OLD_KEY, 'sk-prod-secret-123');
  db.prepare('INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled) VALUES (?,?,?,?,?,?)')
    .run('openai', keyEnc.encrypted, keyEnc.iv, keyEnc.authTag, 'unknown', 1);
  const proxyEnc = encryptWith(OLD_KEY, 'http://user:pass@proxy.local:8080');
  db.prepare("UPDATE api_keys SET proxy_encrypted = ?, proxy_iv = ?, proxy_auth_tag = ? WHERE platform = 'openai'")
    .run(proxyEnc.encrypted, proxyEnc.iv, proxyEnc.authTag);
  const profileEnc = encryptWith(OLD_KEY, 'cp-secret');
  db.prepare('INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled) VALUES (?,?,?,?,?,?)')
    .run('claude', 'hash1', profileEnc.encrypted, profileEnc.iv, profileEnc.authTag, 1);
}

describe('rotate-encryption-key: key rotation round-trip', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedRows();
  });

  it('re-encrypts every stored secret so the new key can decrypt it', () => {
    const result = rotateSecrets(getDb(), OLD_KEY, NEW_KEY);
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(3);

    applyRotation(getDb(), result.rows);

    const rows = getDb().prepare('SELECT id, encrypted_key, iv, auth_tag FROM api_keys').all() as Array<{ id: number; encrypted_key: string; iv: string; auth_tag: string }>;
    expect(decryptWith(NEW_KEY, rows[0].encrypted_key, rows[0].iv, rows[0].auth_tag)).toBe('sk-prod-secret-123');

    const proxy = getDb().prepare('SELECT proxy_encrypted, proxy_iv, proxy_auth_tag FROM api_keys').get() as { proxy_encrypted: string; proxy_iv: string; proxy_auth_tag: string };
    expect(decryptWith(NEW_KEY, proxy.proxy_encrypted, proxy.proxy_iv, proxy.proxy_auth_tag)).toBe('http://user:pass@proxy.local:8080');

    const cp = getDb().prepare('SELECT encrypted_key, iv, auth_tag FROM client_profiles').get() as { encrypted_key: string; iv: string; auth_tag: string };
    expect(decryptWith(NEW_KEY, cp.encrypted_key, cp.iv, cp.auth_tag)).toBe('cp-secret');
  });
});

describe('rotate-encryption-key: wrong-key protection', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedRows();
  });

  it('reports an error (and no rows) when the old key cannot decrypt a value', () => {
    const wrong = Buffer.from('c'.repeat(64), 'hex');
    const result = rotateSecrets(getDb(), wrong, NEW_KEY);
    expect(result.rows).toHaveLength(0);
    expect(result.error).toMatch(/cannot decrypt/);
  });
});

describe('rotate-encryption-key: aes-256-gcm parity with crypto.ts', () => {
  it('produces ciphertext the server crypto module can open (same params)', () => {
    // The rotate script must be a drop-in re-encryptor for the running server:
    // a value encrypted with encryptWith() has to decrypt under the server's
    // crypto.decrypt() with the same key, and vice versa.
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);
    const key = Buffer.from('d'.repeat(64), 'hex');
    initDb(':memory:');

    const serverEnc = encrypt('roundtrip-parity');
    // The rotate script decrypts it with the same raw key bytes.
    expect(decryptWith(key, serverEnc.encrypted, serverEnc.iv, serverEnc.authTag)).toBe('roundtrip-parity');
    // And its own ciphertext decrypts under the server module with that key.
    const scriptEnc = encryptWith(key, 'script-parity');
    expect(decrypt(scriptEnc.encrypted, scriptEnc.iv, scriptEnc.authTag)).toBe('script-parity');
  });
});
