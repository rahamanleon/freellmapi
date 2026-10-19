import { encrypt, decrypt } from './crypto.js';
import { PROXY_SCHEMES } from './proxy.js';

/**
 * Per-key proxy override (#590) — storage and presentation helpers.
 *
 * A proxy URL routinely carries `user:pass@` credentials, so it is stored the
 * same way the API key on that row is: AES-256-GCM ciphertext + iv + auth tag
 * (see the 20260810_000001_api_key_proxy migration). Everything outside the DB
 * layer speaks in plain strings, with '' meaning "no override".
 */

/** The three columns that hold a key's encrypted proxy URL. */
export interface EncryptedProxyColumns {
  proxy_encrypted: string | null;
  proxy_iv: string | null;
  proxy_auth_tag: string | null;
}

/** The accepted schemes, spelled for humans (error messages, docs). */
const SCHEME_LIST = 'http, https, socks4, socks4a, socks5 or socks5h';

export const KEY_PROXY_URL_ERROR =
  `proxyUrl must be a valid proxy URL using ${SCHEME_LIST} (e.g. socks5://user:pass@host:1080), or '' to clear it`;

/** Longest proxy URL accepted — generous for credentials, bounded for the DB. */
export const KEY_PROXY_URL_MAX = 2048;

/**
 * True when `url` is storable as a per-key override: either '' (no override)
 * or a parseable URL on one of the schemes the proxy layer can dispatch
 * through. Deliberately the SAME scheme list the global proxy validator uses
 * (routes/settings.ts), so a URL that works globally works per-key.
 */
export function isValidKeyProxyUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  if (trimmed.length > KEY_PROXY_URL_MAX) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (!PROXY_SCHEMES.includes(parsed.protocol)) return false;
  // `http://` parses fine but names no host to connect to.
  return parsed.hostname !== '';
}

/**
 * Encrypt a per-key proxy URL for storage. '' (or whitespace) clears the
 * override, which is all three columns NULL.
 */
export function encryptProxyUrl(url: string): { encrypted: string | null; iv: string | null; authTag: string | null } {
  const trimmed = url.trim();
  if (!trimmed) return { encrypted: null, iv: null, authTag: null };
  const { encrypted, iv, authTag } = encrypt(trimmed);
  return { encrypted, iv, authTag };
}

/**
 * Read a per-key proxy URL back off a row. Returns '' for "no override" and
 * also for a row that cannot be decrypted (a DB carried over to a different
 * ENCRYPTION_KEY): a failed decrypt must degrade to the global proxy, never
 * take the request down — the key itself fails loudly on the same row anyway.
 */
export function decryptProxyUrl(row: Partial<EncryptedProxyColumns> | undefined | null): string {
  if (!row?.proxy_encrypted || !row.proxy_iv || !row.proxy_auth_tag) return '';
  try {
    return decrypt(row.proxy_encrypted, row.proxy_iv, row.proxy_auth_tag).trim();
  } catch {
    console.warn('[proxy] A key\'s proxy override could not be decrypted — falling back to the global proxy.');
    return '';
  }
}

/**
 * Render a proxy URL for the dashboard with any embedded password removed —
 * the counterpart of maskKey() for this field. The username stays visible
 * (it identifies the account without being the secret):
 *   socks5://alice:hunter2@proxy.internal:1080 → socks5://alice:***@proxy.internal:1080
 * '' stays ''.
 */
export function maskProxyUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  // Split on the LAST '@' before the first '/' of the path so a password
  // containing '@' can't shorten the match.
  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd < 0) return trimmed.replace(/:[^:@]*@/, ':***@');
  const scheme = trimmed.slice(0, schemeEnd + 3);
  const rest = trimmed.slice(schemeEnd + 3);
  const pathStart = rest.search(/[/?#]/);
  const authority = pathStart < 0 ? rest : rest.slice(0, pathStart);
  const tail = pathStart < 0 ? '' : rest.slice(pathStart);
  const at = authority.lastIndexOf('@');
  if (at < 0) return trimmed;
  const userinfo = authority.slice(0, at);
  const host = authority.slice(at + 1);
  const colon = userinfo.indexOf(':');
  // Userinfo with no password has nothing to hide.
  if (colon < 0) return trimmed;
  return `${scheme}${userinfo.slice(0, colon)}:***@${host}${tail}`;
}
