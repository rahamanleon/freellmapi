# freellm-render-deploy

Deployment and operations workspace for **[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)** —
the unified LLM gateway behind the Durin Agent.

Render deploys **upstream's prebuilt image, pinned by commit**. There is no fork and no
build step.

```yaml
# render.yaml
image:
  url: ghcr.io/tashfeenahmed/freellmapi:sha-f76b552   # == upstream tag v0.16.3
```

Upstream does not publish a `v0.16.3` tag to GHCR (its version tags stop at `v0.13.0`), so
the commit-SHA tag is the only reproducible pin. `latest` would silently upgrade on every
deploy.

## Deploy

1. In Render: **New -> Blueprint**, and connect this repository.
   `render.yaml` is at the repository root, so Render detects it automatically.
2. Render creates one service, `freellmapi`, and prompts for four secret environment
   variables (listed below). Supply them.
3. Apply. The first boot creates an empty database, applies the config, and uploads its
   first encrypted backup.

The API is then live at `https://<your-service>.onrender.com`:

```bash
curl https://<your-service>.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer $FREELMAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Reply PONG"}]}'
```

## Secrets you must supply

Declared `sync: false` in `render.yaml`, so Render prompts for them and never stores them
in this repository.

| Secret | Value |
| --- | --- |
| `ENCRYPTION_KEY` | 64 hex characters. Encrypts provider keys at rest and is the default backup key. **Never change it once set**, or existing backups become unreadable. |
| `FREEAPI_CONFIG_JSON` | Your config as a **single-line** JSON string. Start from `ops/freellmapi.config.example.json`. |
| `FREEAPI_DB_BACKUP_URL` | A Hugging Face *dataset* resolve URL, e.g. `https://huggingface.co/datasets/<user>/<repo>/resolve/main/freellmapi.db.backup`. |
| `FREEAPI_DB_BACKUP_TOKEN` | A Hugging Face **write** token for that private dataset repo. |

## Layout

```
render.yaml                     Render Blueprint (must be at the repo root)
freellmapi/                     upstream FreeLLMAPI checkout, tag v0.16.3 (source only)
ops/                            operations toolkit and documentation
  README.md                     index of the toolkit
  RUNBOOK.md                    full operations manual - read this
  freellmapi.config.json        REAL config: dashboard password + provider API keys
  freellmapi.config.example.json  sanitized config template
  secrets/                      ENCRYPTION_KEY + dashboard password backup
  scripts/                      verification and diagnostics
    validate-config.mjs         preflight config against the REAL upstream loader
    verify-router.mjs           end-to-end chat probe (+ tool-calling mode)
    db-inspect.mjs              state report; secrets redacted to a SHA-256 prefix
    list-models.mjs             what the gateway exposes on GET /v1/models
    test-backup-restore.ps1     proves the unified key survives a filesystem wipe
```

## This repository contains live credentials

**It is private, and it is private on purpose.** It holds:

| Path | Credential |
| --- | --- |
| `ops/freellmapi.config.json` | dashboard admin password + provider API keys |
| `ops/secrets/encryption-key.txt` | `ENCRYPTION_KEY` (also the database backup key) |
| `ops/secrets/dashboard-password.txt` | dashboard password |
| `freellmapi/.env` | `ENCRYPTION_KEY` as the gateway reads it at runtime |

The trade-off, stated once so it is not a surprise later: this makes the install fully
reproducible from a clone, at the cost of the credentials living in Git. **Git history is
permanent** — if this repository is ever made public or a collaborator is added, deleting
the files afterwards does not undo it, and the values must be **rotated**:

- a new `ENCRYPTION_KEY` invalidates every existing database backup
- a new unified API key invalidates every client, including the Durin Agent

**Deliberately excluded** (binary, huge, or rebuildable — `git add -f` if you ever want
them): `freellmapi/node_modules/` (361 MB), `freellmapi/.git/` (26 MB, the clone's own
history), `**/dist/` (build output), and `freellmapi/server/data/*.db` (the live database,
which contains the unified API key and is rewritten constantly).

## Read this before you rely on it

Render's Free plan has consequences the gateway was not designed around:

- **No persistent disks, and the filesystem is wiped on every spin-down.** The SQLite
  database lives on ephemeral storage, so durability comes *entirely* from the backup pump.
- **A wiped database regenerates the unified API key.** It lives in the database with no
  environment-variable override, so every client holding the old key starts getting 401s.
  Do not skip the backup configuration — the whole agent breaks silently otherwise.
- **Free services spin down after ~15 minutes idle**; the next request pays a ~30-60 s cold
  start.
- **512 MB / 0.1 CPU, 750 instance-hours per workspace per month**, shared across all free
  services. When the hours run out, everything is suspended until the next month.
- **The public URL is protected only by the unified API key.** Upstream is designed
  local-first. Treat the key as password-strength and do not share the service URL.

Full caveats, the configuration schema, which providers work with **no API key at all**, and
recovery procedures are in [`ops/RUNBOOK.md`](ops/RUNBOOK.md).
