// Configuration for the backup receiver.
//
// Every value comes from the environment (process.env for the Node entry,
// the Worker `env` binding for the Cloudflare entry). Nothing is read from a
// file and nothing is committed to Git.
//
// The receiver FAILS FAST on a missing or weak BACKUP_TOKEN. Running without
// one would expose an unauthenticated endpoint that can both read and
// overwrite the gateway's only durable copy of its database - which includes
// the unified API key and every provider key.

export const DEFAULTS = {
  path: '/backup.bin',
  dbName: 'freellmapi_backup',
  collection: 'revisions',
  // 12 MB: comfortably above the current sub-1 MB blob and the ~1.6 MB raw
  // SQLite file, but below MongoDB's 16 MB single-document ceiling so an
  // oversized write is refused by us (413) rather than by a BSON error.
  maxBytes: 12 * 1024 * 1024,
  // Keep the newest N revisions. A bad overwrite must never be able to
  // destroy the only good copy.
  retention: 5,
  // Every blob written by FreeLLMAPI v0.16.x starts with "FAPIBK1\0". Refusing
  // to store anything else means we can never accept a payload that would
  // silently fail to restore later.
  requireMagic: true,
  connectTimeoutMs: 10_000,
};

export class ConfigError extends Error {
  constructor(problems) {
    super(`backup receiver configuration invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function normalizePath(value) {
  const trimmed = String(value).trim();
  if (!trimmed) return DEFAULTS.path;
  const withoutQuery = trimmed.split('?')[0];
  return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
}

/**
 * Build a validated config object from an environment-shaped source.
 * Throws ConfigError listing EVERY problem at once, so a mistyped secret is
 * one deploy failure rather than a guessing game.
 */
export function loadConfig(src = process.env) {
  const get = (name) => {
    const raw = src?.[name];
    return raw === undefined || raw === null ? '' : String(raw).trim();
  };

  const problems = [];

  const uri = get('MONGODB_URI');
  if (!uri) {
    problems.push('MONGODB_URI is required');
  } else if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    problems.push('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  }

  const token = get('BACKUP_TOKEN');
  if (!token) {
    problems.push('BACKUP_TOKEN is required - the receiver must never run unauthenticated');
  } else if (token.length < 16) {
    problems.push('BACKUP_TOKEN must be at least 16 characters');
  } else if (/\s/.test(token)) {
    problems.push('BACKUP_TOKEN must not contain whitespace');
  }

  const int = (name, def, min, max) => {
    const raw = get(name);
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return def;
    }
    return n;
  };

  const bool = (name, def) => {
    const raw = get(name).toLowerCase();
    if (!raw) return def;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    problems.push(`${name} must be a boolean (true/false)`);
    return def;
  };

  const config = {
    uri,
    token,
    path: normalizePath(get('BACKUP_PATH') || DEFAULTS.path),
    dbName: get('MONGODB_DB') || DEFAULTS.dbName,
    collection: get('MONGODB_COLLECTION') || DEFAULTS.collection,
    maxBytes: int('BACKUP_MAX_BYTES', DEFAULTS.maxBytes, 1024, 48 * 1024 * 1024),
    retention: int('BACKUP_RETENTION', DEFAULTS.retention, 1, 50),
    requireMagic: bool('BACKUP_REQUIRE_MAGIC', DEFAULTS.requireMagic),
    connectTimeoutMs: int('BACKUP_CONNECT_TIMEOUT_MS', DEFAULTS.connectTimeoutMs, 1000, 60_000),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
