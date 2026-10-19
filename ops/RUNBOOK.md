# FreeLLMAPI + Durin Agent - Operations Runbook

Local install: Windows 11, source checkout at upstream tag `v0.16.3`.
Remote target: Render Free, running the upstream prebuilt GHCR image.

Everything in this runbook was verified on the local install unless it is
explicitly marked **[PENDING]** or **[UNVERIFIED]**.

---

## 0. Status at a glance

### Verified working

| Item | Evidence |
| --- | --- |
| Local install (source, `npm`) | tag `v0.16.3`, detached HEAD, 835 packages installed, server + CLI + dashboard built |
| Dashboard + health endpoint | `GET /` -> 200 HTML; `GET /api/ping` -> `200 {"status":"ok"}` |
| Declarative config applied at boot | `[config] applied ...: 4 keys, 0 custom models, 0 model edits, 0 fallback rows, routing, admin account created` |
| Admin account from config | dashboard account created while the users table was empty |
| Dashboard login + unified key retrieval | `POST /api/auth/login` as the config-created account -> `GET /api/auth/me` -> `leon@durin.local`; `GET /api/settings/api-key` returned the 59-char key whose SHA-256 prefix matched the database exactly |
| OpenRouter (keyed) | key health `healthy`; `200` with `x-routed-via: openrouter/nvidia/nemotron-3-super-120b-a12b:free` |
| OpenRouter tool calling | `finish_reason: tool_calls`, `get_weather({"city":"Dhaka"})`, `cost: 0` |
| OVH (keyless) | `200` via `ovh/gpt-oss-120b`; tool calling works |
| Kilo (keyless) | `200` via `kilo/poolside/laguna-s-2.1:free` |
| AI Horde (keyless) | registered; **no tool calling** by design (queue-based, text only) |
| Multi-provider routing | `model: auto` routed to `ovh/Qwen3.8-27B` |
| In-platform failover | `google/gemma-4-26b-a4b-it:free` -> 429 -> next -> `dots-studio/dots-3-note-preview:free` -> ok |
| Config preflight validator | passes on the real config; rejects unknown top-level keys, unknown platforms, bad enums |
| Encrypted backup + restore | full wipe -> restore -> unified API key fingerprint **identical** |
| GHCR image pin | `ghcr.io/tashfeenahmed/freellmapi:sha-f76b552` = `v0.16.3` commit `f76b5528d40352ad16c1ceff4d91d8f7717e6785`, public, linux/amd64 + linux/arm64 |

### Pending user-supplied secrets

| Item | What is needed |
| --- | --- |
| Hugging Face backup target | a **private dataset** repo + a write token |
| Groq API key | free, no card; largest practical gain (+1000 req/day) |
| Google AI Studio key | free tier, works in Bangladesh |
| Render account | to apply `render.yaml` (repository root) |

---

## 1. Architecture - three separate data stores

These are three different things and must not be conflated:

| Store | Owned by | Holds | Why |
| --- | --- | --- | --- |
| **`ops/freellmapi.config.json`** | this repo (tracked - see section 9) | admin account, provider keys, routing policy | Declarative, strict schema, re-applied on every boot. It is what reconstructs a fresh container. |
| **Process env vars** | Render / `.env` | `ENCRYPTION_KEY`, backup target, timeouts, caps, proxy trust | The strict config schema has **no** field for these. Anything not in section 4.1 must be an env var. |
| **SQLite (`freeapi.db`)** | FreeLLMAPI itself | live state: the **unified API key**, dashboard profiles, usage counters, cooldowns | FreeLLMAPI is SQLite-only. Upstream has no MongoDB support anywhere in the codebase. |
| **MongoDB Atlas** | the Durin Agent | the agent's own records (tasks, task-accounts, results) | Separate system, reached directly by the agent. Not a FreeLLMAPI dependency. |

### Why FreeLLMAPI gets a Hugging Face backup

On Render Free the filesystem is ephemeral: every spin-down deletes
`freeapi.db`. The unified API key lives in that database
(`settings.unified_api_key`) and has **no environment-variable override**, so a
wiped database produces a **new** key and every client holding the old one
breaks. The encrypted backup pump is what makes the key durable.

MongoDB Atlas cannot solve this: FreeLLMAPI never speaks to MongoDB. Using
Atlas as the gateway's database would require forking it.

---

## 2. File map

```
Durin Agent\                        <- this directory is the Git repository
  README.md                         project + deploy overview
  .gitignore                        keeps credentials and the upstream clone out of Git
  render.yaml                       Render Blueprint (must be at the repo root)
  freellmapi\                       upstream checkout, tag v0.16.3 (detached HEAD) - GIT-IGNORED
    .env                            ENCRYPTION_KEY + PORT + analytics vars (ACL-restricted)
    server\data\freeapi.db          live SQLite database (created on first boot)
  ops\
    freellmapi.config.json         REAL config: admin + provider keys (GIT-IGNORED, ACL-restricted)
    freellmapi.config.example.json sanitized template
    RUNBOOK.md                     this file
    README.md                      short index
    .gitignore                     keeps secrets out of Git
    secrets\                       GIT-IGNORED, ACL-restricted
      encryption-key.txt           backup copy of ENCRYPTION_KEY
      dashboard-password.txt       backup copy of the dashboard password
    scripts\
      db-inspect.mjs               read-only DB report; redacts + fingerprints secrets
      list-models.mjs              what the gateway exposes on GET /v1/models
      verify-router.mjs            end-to-end chat completion probe (+ tool-calling mode)
      validate-config.mjs          preflight the config against the real upstream loader
      test-backup-restore.ps1      wipe-and-restore durability proof
```

---

## 3. Local operation

### Start

```powershell
cd "C:\Users\Leon\Desktop\Durin Agent\freellmapi"
$env:NODE_ENV = "production"
$env:FREEAPI_CONFIG_PATH = "C:\Users\Leon\Desktop\Durin Agent\ops\freellmapi.config.json"
node server/dist/index.js
```

The dashboard is then at <http://localhost:3001>.

### Verify it is alive

```powershell
Invoke-WebRequest http://127.0.0.1:3001/api/ping -UseBasicParsing | Select-Object -Expand Content
```

### Inspect state (never prints secrets)

```powershell
cd "C:\Users\Leon\Desktop\Durin Agent"
node ops\scripts\db-inspect.mjs
```

### Probe the router end to end

```powershell
node ops\scripts\verify-router.mjs http://127.0.0.1:3001 auto
node ops\scripts\verify-router.mjs http://127.0.0.1:3001 gpt-oss-120b tools
```

`verify-router.mjs` reads the unified key straight out of SQLite and never
prints it. `x-routed-via` tells you which upstream actually served the request.

### Retrieving the unified API key (what the agent authenticates with)

The unified key has **no** environment-variable override - it lives only in the
database (`settings.unified_api_key`) and is readable from the dashboard. This
is the same value in both places (verified):

1. Open <http://localhost:3001> and sign in with the account from
   `ops\freellmapi.config.json` (`admin.email` / `admin.password`).
2. Go to the **Keys** page and copy the unified key.

By API, as a dashboard session:

```
POST /api/auth/login      { "email": ..., "password": ... }   -> { token }
GET  /api/settings/api-key                 (Bearer token)     -> { apiKey }
POST /api/settings/api-key/regenerate      (Bearer token)     -> { apiKey }
```

The credential the agent uses is that unified key, sent as
`Authorization: Bearer freellmapi-...` against `<base-url>/v1/chat/completions`
(or `<base-url>/v1/messages` for the Anthropic shape, or `/v1/embeddings`).

**This is exactly why the backup matters.** If the database is ever wiped
without a restore, `regenerateUnifiedKey()` state is lost and a *new* key is
minted on boot - every client silently starts getting 401s until it is updated.

### Stop

```powershell
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server/dist/index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

## 4. Configuration model

### 4.1 The authoritative schema

The upstream schema is **strict** - an unknown key is a fatal boot error, not a
warning. Exactly seven top-level keys exist:

```
admin           { email, password }              first-run dashboard account
license         string                           premium key (freellmapi.co)
keys            [ { platform, key?, label?, baseUrl?, enabled? } ]
customProviders [ { baseUrl, apiKey?, label?, models[] } ]
models          [ { platform, modelId, endpoint?, displayName?,
                    intelligenceRank?, speedRank?, sizeLabel?,
                    rpmLimit?, rpdLimit?, tpmLimit?, tpdLimit?,
                    monthlyTokenBudget?, contextWindow?, enabled?,
                    supportsVision?, supportsTools?, fallbackEnabled? } ]
fallback        [ { platform, modelId, endpoint?, priority?, enabled? } ]
routing         { strategy, weights?, keySelectionStrategy? }
```

`routing.strategy` is one of:
`priority`, `balanced`, `smartest`, `fastest`, `reliable`, `custom`, `decision`.

`routing.keySelectionStrategy` is one of: `auto`, `least-remaining`.

Things that are **not** configurable here, despite being tempting:
timeouts (`PROVIDER_TIMEOUT_<PLATFORM>`), the fallback time budget
(`FALLBACK_TIME_BUDGET_MS`), per-provider daily caps
(`PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>`, e.g. `..._OPENROUTER=50`), the
encryption key, and the unified API key. Those are env vars or database state.

### 4.2 Precedence

`FREEAPI_CONFIG_JSON` (inline JSON string) **wins over** `FREEAPI_CONFIG_PATH`
(a file path). Both are applied on every boot, idempotently.

- **Local install:** `FREEAPI_CONFIG_PATH` -> `ops\freellmapi.config.json`
- **Render:** `FREEAPI_CONFIG_JSON` -> the same JSON as a single-line string
  (a prebuilt image has no config file to mount)

### 4.3 Validate before you deploy

```powershell
cd "C:\Users\Leon\Desktop\Durin Agent"
node ops\scripts\validate-config.mjs
```

This loads the **real** upstream validator (not a copy of it) against a
throwaway database, so it can never drift from what the server will accept.
It catches bad JSON, unknown top-level keys, unknown platforms, out-of-range
values and bad enums. Your live database is never touched.

### 4.4 Gotchas worth remembering

- **A UTF-8 BOM breaks the config file.** Upstream does `JSON.parse` on the
  raw text, so a BOM yields
  `Unexpected token '', "{ \"keys\"..." is not valid JSON`.
  `Set-Content -Encoding utf8` in PowerShell 5.1 **adds** a BOM - use
  `[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))`
  or `Set-Content -Encoding ascii`.
- **A keyed platform with a missing key is not fatal.** Upstream degrades the
  entry to a warning (`groq requires an API key ... entry skipped`) and boots.
- **Unknown platforms are fatal:** `unknown provider platform: <name>`.
- **`admin` only applies while the users table is empty.** Once an account
  exists the entry degrades to a warning, so config can never hijack a live
  install.
- The `license` field must be at least 8 characters if present.

---

## 5. Providers

### 5.1 What is configured now

| Platform | Credential | Tool calling | Notes |
| --- | --- | --- | --- |
| `openrouter` | API key | yes (verified) | free tier is ~20 req/min and **~50 requests/day** without a one-time $10 top-up |
| `kilo` | **none (keyless)** | not yet exercised | 200 req/hr per IP; free prompts/outputs are logged for training |
| `ovh` | **none (keyless)** | yes (verified) | 2 req/min per model per IP |
| `aihorde` | **none (keyless)** | **no** | volunteer workers, queue-based, slow; text only |

`kilo`, `ovh` and `aihorde` are registered upstream as keyless: omit the `key`
field entirely and the server stores a sentinel row. This gives real
multi-provider redundancy with **zero** additional sign-ups.

### 5.2 Additional no-card providers (research result, 2026-10)

| Provider | Free tier | Card required | Reachable from Bangladesh | Verdict |
| --- | --- | --- | --- | --- |
| **Groq** | `gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b`; ~30 RPM / 1000 RPD each; tool calling | **no** | yes | **Add this first.** Largest practical gain. |
| **Google AI Studio** | Flash / Flash-Lite class, tool calling | **no** | yes - Bangladesh is in Google's officially supported region list | **Add second.** |
| **Cerebras** | free tier **ended 2026-07-21**; now a $5 trial credit | **yes** - payment method now required | n/a | **Not viable.** |
| Mistral La Plateforme | free tier exists | phone verification | yes | optional |
| Cloudflare Workers AI | ~10k neurons/day | no | yes | optional |
| Hugging Face Inference | ~1000 req/day | no | yes | optional |
| NVIDIA NIM | trial credits, ~40 RPM | phone verification | yes | optional |

Note the `x-routed-via` behaviour: the same alias is served by several
platforms and the router prefers ones you actually have keys for. `gemma-4-31b`
maps to `openrouter`, `electronhub`, `ollama` and `requesty`; with only
OpenRouter keyed, one upstream 429 exhausted the whole request
(`3 model(s) skipped: no enabled+healthy key for platform`). More keys is the
direct fix.

### 5.3 Adding a keyed provider

1. Add an entry to `ops/freellmapi.config.json`:
   ```json
   { "platform": "groq", "key": "gsk_...", "label": "main", "enabled": true }
   ```
2. Validate: `node ops\scripts\validate-config.mjs`
3. Restart the server. The health checker validates the key within ~5 minutes,
   or immediately on the first routed request.

The platform name must match upstream's registry exactly (it is validated
against the real registry, so a typo fails the preflight rather than silently
disabling a provider).

---

## 6. Deploying to Render

`render.yaml`, at the repository root, is ready. It deploys the pinned upstream
image - no fork, no build.

> **Two deploy paths, and they differ in where secrets come from.**
>
> * **Docker service (root `Dockerfile`) - self-contained.** The Dockerfile copies
>   `freellmapi/.env` and `ops/freellmapi.config.json` into the image, so the
>   service needs **no environment variables at all**. This is the path in use.
> * **Blueprint (`render.yaml`, `runtime: image`) - prompts.** It pulls the
>   upstream image directly, so it carries no copy of those files and still asks
>   for the four `sync: false` secrets in step 3.
>
> `FREEAPI_CONFIG_JSON` takes precedence over `FREEAPI_CONFIG_PATH`, so setting it
> on a Docker-path service overrides the baked-in file. Harmless while the two
> hold identical content (they currently do).

### Steps

1. Push this repository to GitHub. It is **private**, and it deliberately carries
   the live credentials - `ops/freellmapi.config.json`, `ops/secrets/`, and
   `freellmapi/.env` - next to the upstream source checkout. Section 9 covers the
   trade-off. `freellmapi/node_modules/`, `freellmapi/.git/`, `**/dist/`, and the
   live database are excluded. `render.yaml` sits at the root, where Render looks
   for it.
2. In Render: **New -> Blueprint**, connect that repository.
3. Render creates one service, `freellmapi`, and prompts for the four
   `sync: false` secrets:
   - `ENCRYPTION_KEY` - the 64 hex characters currently in
     `freellmapi\.env` (or `ops\secrets\encryption-key.txt`).
     **This must not change later**, or existing backups become unreadable.
   - `FREEAPI_CONFIG_JSON` - see below.
   - `FREEAPI_DB_BACKUP_URL` - see section 7.
   - `FREEAPI_DB_BACKUP_TOKEN` - see section 7.
4. Apply. The first deploy boots with an empty database, restores nothing (no
   backup yet), applies the config, and writes its first backup.

### Building the `FREEAPI_CONFIG_JSON` value

It must be a **single line**. From PowerShell:

```powershell
cd "C:\Users\Leon\Desktop\Durin Agent"
(Get-Content ops\freellmapi.config.json -Raw) -replace "`r?`n", " " -replace "\s+", " "
```

Copy the printed single line into the Render field. Validate it first with
`validate-config.mjs` so you are not debugging JSON in a deploy log.

### Why the values in `render.yaml` are what they are

| Setting | Value | Reason |
| --- | --- | --- |
| `image.url` | `ghcr.io/tashfeenahmed/freellmapi:sha-f76b552` | Pinned by commit. GHCR publishes **no** `v0.16.3` tag (version tags stop at `v0.13.0`); `sha-f76b552` is the `v0.16.3` commit, verified present and public. |
| `plan` | `free` | 512 MB / 0.1 CPU, 750 instance-hours per workspace per month. |
| `region` | `singapore` | Closest Render region to Bangladesh. Free instances are not region-restricted. |
| `healthCheckPath` | `/api/ping` | Verified 200 on the local install. |
| `HOST` | `0.0.0.0` | The image defaults to `::`; pinning avoids any dual-stack ambiguity behind Render's proxy. `PORT` is injected by Render and overrides the image's `ENV PORT=3001`. |
| `TRUST_PROXY` | `1` | Without it, per-client rate limiting sees one client behind Render's proxy. |
| `FREEAPI_DB_DIR_HARDENING` | `1` | Single-tenant container; lets the server lock the data dir to 0700 instead of warning. |
| `autoDeployTrigger` | `off` | The image is pinned by SHA, so there is nothing to rebuild. |

### Free-tier consequences to plan around

- **No persistent disks.** Durability is entirely the backup pump (section 7).
- **Spin-down after ~15 min idle**, cold start ~30-60 s. The first request after
  idle is slow. Point uptime pings at `/api/ping` if you want it warm, but note
  that 750 instance-hours per month is the cap.
- **Render may restart a free service at any time.**
- **No SSH / shell access**, so there is no interactive recovery - everything
  must be recoverable from the config plus the backup.
- **The public URL is guarded only by the unified API key.** Upstream is
  designed local-first; `/v1` has no other gate. Treat the key as a
  password-strength secret and do not share the URL.

---

## 7. Durability - encrypted backup to Hugging Face

### How it works (verified in code and locally)

Boot order in `server/src/index.ts`:

1. `restoreDbBackupIfNeeded()` - if the database file is missing, download and
   decrypt the backup
2. `initDb()` - run migrations
3. `applyDeclarativeConfigFromEnv()` - re-apply `ops\freellmapi.config.json`
4. `startHealthChecker()`
5. `startDbBackupPump()` - **uploads immediately**, then every
   `FREEAPI_DB_BACKUP_INTERVAL_MS`
6. Start listening

Step 5 running immediately matters: the unified key is generated during step 2,
so it is uploaded to the backup target within seconds of the first boot.

The payload is `gzip(encrypt(sqlite))`. Verified locally: the file header is
`FAPIBK1` (`46 41 50 49 42 4b 31`), not `SQLite`.

### Environment variables

| Variable | Meaning |
| --- | --- |
| `FREEAPI_DB_BACKUP_TARGET` | Most general form; overrides the two below |
| `FREEAPI_DB_BACKUP_URL` | HTTP target (use this for Hugging Face) |
| `FREEAPI_DB_BACKUP_PATH` | Local file target (used by the local durability test) |
| `FREEAPI_DB_BACKUP_TOKEN` | Bearer token; **required** for Hugging Face uploads |
| `FREEAPI_DB_BACKUP_KEY` | Encryption key; defaults to `ENCRYPTION_KEY` |
| `FREEAPI_DB_BACKUP_INTERVAL_MS` | Upload interval, default `300000` (5 min) |

### Setting up the Hugging Face target

1. Create a **private dataset** repository, e.g. `leon/durin-freellmapi-backups`.
2. Create a **write** access token (Settings -> Access Tokens).
3. Set `FREEAPI_DB_BACKUP_URL` to the *resolve* URL of the file:
   ```
   https://huggingface.co/datasets/<user>/<repo>/resolve/main/freellmapi.db.backup
   ```
   The parser requires the host to be exactly `huggingface.co`, the path to
   contain `datasets/<ns>/<repo>/resolve/<rev>/<file>`, and it derives the commit
   API from it. Uploads are plain HTTP PUT-style commits, so no disk is
   involved - which is why this works on Render Free.
4. Set `FREEAPI_DB_BACKUP_TOKEN` to the token.

### Local durability test (already passing)

```powershell
cd "C:\Users\Leon\Desktop\Durin Agent"
powershell -NoProfile -ExecutionPolicy Bypass -File "ops\scripts\test-backup-restore.ps1"
```

It uses a scratch database and a scratch backup, so the real install is never
touched. Last run:

```
unified key fingerprint (before wipe): sha256:2966490203f3
backup written: 28672 bytes
backup header is not plaintext SQLite (first bytes: 46415049424b31...)
wiped: scratch.db, scratch.db-wal, scratch.db-shm
restore logged: 417792 bytes
unified key fingerprint (after wipe):  sha256:2966490203f3
IDENTICAL - the unified API key survived a full filesystem wipe
```

### Known limitation: no flush on shutdown

`installGracefulShutdown` closes the database on `SIGTERM` but does **not**
force a final backup upload. Spin-down can therefore lose up to
`FREEAPI_DB_BACKUP_INTERVAL_MS` of database writes.

In practice this is small: after the initial setup the database changes rarely
(provider keys and routing are re-applied from config on every boot), and the
pump uploads immediately at boot. If you want a tighter window, lower
`FREEAPI_DB_BACKUP_INTERVAL_MS` - remembering that each upload is one Hugging
Face commit. A true fix requires upstream changes to call `backupDbNow()` from
the graceful-shutdown hook, which is out of scope while deploying the stock
image.

### [UNVERIFIED] Hugging Face transport

The local test exercises the full encrypt -> write -> wipe -> restore path, but
using a **file** target. The Hugging Face branch of `writeTarget()` differs only
in transport (commit API over HTTPS). It cannot be exercised until a private
dataset repository and write token exist. **Test it immediately after the first
Render deploy**: confirm the file appears in the dataset repo, then trigger a
restart and confirm the boot log contains `[db-backup] restored ... bytes`.

---

## 8. The Durin Agent's own records (MongoDB Atlas)

FreeLLMAPI is not involved here. The agent talks to Atlas directly.

- Atlas M0 free tier: 512 MB, ~100 ops/s, 16 MB maximum BSON document.
- The Atlas Data API / HTTPS Endpoints are **retired** (EOL 2025-09-30) - use a
  driver connection string, not HTTP endpoints.
- Do not put live usage totals or counters into static JSON files; they change
  constantly and would fight the file. Usage and task records belong in Atlas.
- Keep the agent's Atlas connection string out of `ops/freellmapi.config.json`:
  it is not a gateway setting and the strict schema would reject it.

---

## 9. Security posture

- `ENCRYPTION_KEY` and the dashboard password live in `freellmapi\.env` and
  `ops\secrets\` (both ACL-restricted to the current user on this machine), and
  both are now **tracked in this private repository** - the trade-off accepted
  so that a clone can reproduce the install. Git history is permanent: making
  the repository public, or adding a collaborator, exposes them, and deleting
  the files afterwards does not undo it. Recovery means **rotating** the values
  - a new `ENCRYPTION_KEY` invalidates existing backups, and a new unified API
  key invalidates every client, including the Durin Agent.
- Provider API keys live in `ops\freellmapi.config.json` because that is the
  only declarative path the server supports. It is ACL-restricted here and
  tracked in the private repository.
- The unified API key is never printed by any script in `ops\scripts\`;
  `db-inspect.mjs` prints a SHA-256 prefix instead.
- On Render, `/v1` is protected **only** by the unified API key. Do not share
  the service URL.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Unexpected token '', "{..."` on boot | UTF-8 BOM in the config | Rewrite without a BOM (section 4.4) |
| `invalid declarative config: : Unrecognized key(s) in object: 'X'` | Not a supported top-level key | Use an env var for anything outside section 4.1 |
| `unknown provider platform: X` | Typo in `keys[].platform` | Check the platform against the upstream registry |
| `All models exhausted: ... rate-limited or on cooldown` | The alias's only keyed platform returned 429 | Wait for cooldown, add another provider key, or request a different alias |
| `429` from `openrouter` on a *specific* model | Upstream saturation of that free model (cooldown extends ~60 s per retry) | Route to a different model, or add a second platform for that alias |
| Client suddenly gets 401 after a Render restart | The database was wiped and a new unified key was generated | Check the backup config; the key only survives if the backup restored |
| `npm` exits 1 in PowerShell | npm writes warnings to stderr and PS 5.1 treats that as a native command error | Read the summary text, not the exit code |
| `ERROR: The system was unable to find the specified registry key or value.` at boot (Windows) | Benign. `lib/proxy.ts` reads the Internet Options registry (`ProxyEnable` / `ProxyServer`) to detect a system proxy; on a machine with none configured the key is absent | Ignore. It is followed by `[proxy] Not configured - outbound requests go direct.` and does not appear on Linux/Render |

---

## 11. Next actions

1. **Hugging Face** - create the private dataset repo + write token, then set
   `FREEAPI_DB_BACKUP_URL` / `FREEAPI_DB_BACKUP_TOKEN`.
2. **Groq** - free, no card, +1000 req/day, tool calling. Best single addition.
3. **Google AI Studio** - free tier confirmed available in Bangladesh.
4. **Render** - push this repository and apply `render.yaml`, supplying the four secrets.
5. **First-deploy check** - confirm the backup file appears in the dataset repo,
   then restart the service and confirm `[db-backup] restored ... bytes`.
