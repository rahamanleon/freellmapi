# ops/ - FreeLLMAPI gateway operations

Everything needed to run the gateway that powers the Durin Agent, plus the
scripts used to verify it.

**Start here: [`RUNBOOK.md`](./RUNBOOK.md).**

## Contents

| File | Purpose |
| --- | --- |
| `RUNBOOK.md` | Full operations manual: architecture, config schema, providers, Render deploy, backup/restore, troubleshooting |
| `../render.yaml` | Render Blueprint, at the **repository root** (Render requires it there). Deploys the pinned upstream image `ghcr.io/tashfeenahmed/freellmapi:sha-f76b552` (= `v0.16.3`) |
| `freellmapi.config.json` | **Real config** (admin account + provider keys). Git-ignored, ACL-restricted |
| `freellmapi.config.example.json` | Sanitized template of the above |
| `.gitignore` | Keeps the config and secrets out of version control |
| `secrets/` | Backups of `ENCRYPTION_KEY` and the dashboard password. Git-ignored, ACL-restricted |

## Scripts

| Script | What it does |
| --- | --- |
| `scripts/validate-config.mjs` | Validates the config against the **real** upstream loader using a throwaway database. Run this before every deploy |
| `scripts/db-inspect.mjs` | Read-only report: provider keys, model counts, fallback chain, routing. Secrets are redacted to a SHA-256 prefix |
| `scripts/list-models.mjs` | Lists what the gateway exposes on `GET /v1/models` |
| `scripts/verify-router.mjs` | End-to-end chat completion probe. Add `tools` as the 4th argument to test tool calling |
| `scripts/test-backup-restore.ps1` | Proves the unified API key survives a full filesystem wipe. Uses a scratch database |
| `scripts/copy-for-render.ps1` | Puts a Render secret (`config`, `encryption-key`, `password`) on the clipboard without printing it. Validates the config JSON first |

## Quick commands

```powershell
cd "C:\Users\Leon\Desktop\Durin Agent"

# preflight the config
node ops\scripts\validate-config.mjs

# what state is the gateway in?
node ops\scripts\db-inspect.mjs

# does it actually answer?
node ops\scripts\verify-router.mjs http://127.0.0.1:3001 auto
node ops\scripts\verify-router.mjs http://127.0.0.1:3001 gpt-oss-120b tools

# prove durability
powershell -NoProfile -ExecutionPolicy Bypass -File "ops\scripts\test-backup-restore.ps1"

# fill Render's secret prompts without hand-copying a 492-char JSON blob
powershell -NoProfile -ExecutionPolicy Bypass -File "ops\scripts\copy-for-render.ps1" -Which config
```

## Provider status

| Platform | Credential | Tool calling |
| --- | --- | --- |
| `openrouter` | API key | yes |
| `ovh` | none (keyless) | yes |
| `kilo` | none (keyless) | untested |
| `aihorde` | none (keyless) | no (by design) |

Recommended next: **Groq** (free, no card, ~1000 req/day, tool calling), then
**Google AI Studio** (free tier is available in Bangladesh).
