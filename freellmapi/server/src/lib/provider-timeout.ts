// Per-provider HTTP timeout overrides (issue #547, reworked from PR #509).
//
// PROVIDER_TIMEOUT_<PLATFORM>=<milliseconds> overrides the platform's built-in
// chat timeout (e.g. PROVIDER_TIMEOUT_NVIDIA=300000). 0 disables the timeout
// entirely. Values are read when the provider is constructed — for the built-in
// platforms that means process start, so a change requires a restart.
//
// PROVIDER_STREAM_STALL_TIMEOUT_MS is the streaming counterpart for the
// mid-stream inactivity watchdog (issue #553): how long an SSE stream may go
// without a single byte before the gateway gives up on it.
// PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM> (issue #584) overrides it for one
// platform; precedence is per-platform > global > built-in default (90s).
//
// The stall watchdog does NOT bound time-to-first-byte: the FIRST read of a
// stream gets a grace budget derived from the platform's chat timeout (the
// PROVIDER_TIMEOUT_<PLATFORM> knob above), floored at the stall budget — see
// BaseProvider.readSseStream. Before #584 the stall budget also bounded the
// first byte, which killed healthy long prefills (NVIDIA NIM sends SSE headers
// instantly, then prefills 100k-token prompts for minutes) at 90s.

const warned = new Set<string>();

function warnOnce(name: string, message: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(message);
}

function parseTimeoutEnv(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    warnOnce(name, `[config] Ignoring ${name}="${raw}": expected a non-negative integer of milliseconds (0 disables the timeout). Using the default ${defaultMs}ms.`);
    return defaultMs;
  }
  if (parsed > 0 && parsed < 1000) {
    warnOnce(name, `[config] ${name}=${parsed}ms is under a second; nearly every request to this provider will abort. Was this meant to be seconds?`);
  }
  return parsed;
}

export function providerTimeoutEnvName(platform: string): string {
  return `PROVIDER_TIMEOUT_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Effective chat timeout for a platform: the PROVIDER_TIMEOUT_<PLATFORM> env
 * override when set and valid, else the built-in default. Returns 0 to mean
 * "no timeout" — callers must skip their abort timer for 0, never schedule
 * setTimeout(0). */
export function providerTimeoutMs(platform: string, defaultMs: number): number {
  return parseTimeoutEnv(providerTimeoutEnvName(platform), defaultMs);
}

export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 90_000;

export function streamStallTimeoutEnvName(platform: string): string {
  return `PROVIDER_STREAM_STALL_TIMEOUT_${platform.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Effective mid-stream inactivity timeout, 0 disables. Resolved per call so
 * tests can vary the env. Precedence (#584): the per-platform
 * PROVIDER_STREAM_STALL_TIMEOUT_<PLATFORM> when a platform is given and the
 * var is set and valid, else the global PROVIDER_STREAM_STALL_TIMEOUT_MS,
 * else the built-in 90s default. */
export function streamStallTimeoutMs(platform?: string): number {
  const globalMs = parseTimeoutEnv('PROVIDER_STREAM_STALL_TIMEOUT_MS', DEFAULT_STREAM_STALL_TIMEOUT_MS);
  if (!platform) return globalMs;
  return parseTimeoutEnv(streamStallTimeoutEnvName(platform), globalMs);
}

/** Test hook: forget which malformed values have already been warned about. */
export function resetTimeoutWarnings(): void {
  warned.clear();
}
