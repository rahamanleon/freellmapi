#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--project-root" ]]; then
  project_root="${2:?--project-root requires a path}"
  shift 2
fi

if [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--project-root PATH]" >&2
  exit 1
fi

if [[ ! -f "$project_root/package.json" || ! -f "$project_root/package-lock.json" ]]; then
  echo "Project root must contain package.json and package-lock.json: $project_root" >&2
  exit 1
fi

node_version="$(node --version | sed 's/^v//')"
npm_version="$(npm --version)"

version_is_supported="$(node - "$node_version" "$npm_version" <<'NODE'
const [nodeVersion, npmVersion] = process.argv.slice(2).map((value) => value.split('.').map(Number));
const compare = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};
const nodeOk = compare(nodeVersion, [20, 18, 0]) >= 0 && nodeVersion[0] < 25;
const npmOk = compare(npmVersion, [10, 0, 0]) >= 0;
process.stdout.write(nodeOk && npmOk ? 'yes' : 'no');
NODE
)"

if [[ "$version_is_supported" != "yes" ]]; then
  echo "Node.js >=20.18.0 and <25.0.0 plus npm >=10.0.0 are required; found Node.js $node_version and npm $npm_version." >&2
  exit 1
fi

lock_hash_for() {
  node -e "const fs = require('node:fs'); const crypto = require('node:crypto'); process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$1"
}

lockfile="$project_root/package-lock.json"
node_modules="$project_root/node_modules"
lock_stamp="$node_modules/.freellmapi-bootstrap-lock"
lock_hash="$(lock_hash_for "$lockfile")"
installed_lock_hash=""

if [[ -f "$lock_stamp" ]]; then
  installed_lock_hash="$(tr -d '[:space:]' < "$lock_stamp")"
fi

cd "$project_root"

if [[ ! -d "$node_modules" || "$installed_lock_hash" != "$lock_hash" ]]; then
  echo 'Installing dependencies...'
  npm install
  lock_hash="$(lock_hash_for "$lockfile")"
  printf '%s' "$lock_hash" > "$lock_stamp"
else
  echo 'Dependencies already match package-lock.json.'
fi

if [[ ! -e .env ]]; then
  encryption_key="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  umask 077
  printf 'ENCRYPTION_KEY=%s\nPORT=3001\n' "$encryption_key" > .env
  echo 'Created .env with a new ENCRYPTION_KEY.'
else
  echo '.env already exists; leaving it unchanged.'
fi

echo 'Bootstrap complete. Start development with: npm run dev'
