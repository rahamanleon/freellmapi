import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Which RELEASE this install is, for the dashboard to display (#703).
//
// Deliberately not `server/package.json`: that version tracks the server
// workspace and has sat at 0.2.1 across many releases, as has the OpenAPI
// spec's 0.4.1. The number users know the app by lives in desktop/package.json
// — it is what the release recipe bumps and what the installers are named for.
//
// Order:
//   1. FREEAPI_VERSION — the desktop shell sets it from app.getVersion(); a
//      packaged/self-hosted deployment can set it too.
//   2. desktop/package.json, found by walking up from this module. Present in a
//      source checkout, and the Docker runtime image copies it in for this.
//   3. null — say nothing rather than state a version that isn't the release.
//      The dashboard omits the row entirely when this is null.

const MAX_WALK_UP = 6;

function readVersion(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function findDesktopVersion(): string | null {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const found = readVersion(path.join(dir, 'desktop', 'package.json'));
    if (found) return found;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cached: string | null | undefined;

/** The released app version, or null when it cannot be established honestly. */
export function getAppVersion(): string | null {
  if (cached !== undefined) return cached;
  const fromEnv = process.env.FREEAPI_VERSION?.trim();
  cached = fromEnv ? fromEnv : findDesktopVersion();
  return cached;
}

/** Test seam — the resolver caches, and env changes must be able to take effect. */
export function resetAppVersionCache(): void {
  cached = undefined;
}
