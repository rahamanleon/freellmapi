# Root Dockerfile - so this repo can deploy on ANY Docker-runtime host.
#
# WHY THIS EXISTS
# --------------
# Render's Docker runtime requires a Dockerfile at the repository root. Without
# one, the build fails immediately with:
#
#   failed to read dockerfile: open Dockerfile: no such file or directory
#
# The upstream Dockerfile lives at freellmapi/Dockerfile and BUILDS the app from
# source (npm ci, native better-sqlite3 compile, server + client bundles).
#
# This file deliberately does NOT do that. It deploys the UPSTREAM PREBUILT
# IMAGE, pinned to an immutable commit tag:
#
#   sha-f76b552 == upstream tag v0.16.3
#                 commit f76b5528d40352ad16c1ceff4d91d8f7717e6785
#
# Consequences, all intended:
#   * no compile step  -> the build pulls one image and finishes in seconds
#   * no drift         -> the running code is exactly upstream v0.16.3
#   * no build failures from native modules, memory limits, or npm resolution
#
# render.yaml specifies the same image via `runtime: image`, which is the
# Blueprint path and never builds anything. This file exists so the repository
# ALSO works when a service is configured as a Docker source build.
#
# If you ever want to build from the source in freellmapi/ instead, feel free to
# replace this file - but expect a multi-minute build and a much larger surface
# for things to go wrong.
FROM ghcr.io/tashfeenahmed/freellmapi:sha-f76b552

# Non-secret runtime defaults, mirroring render.yaml. Environment variables set
# on the service (Render -> Environment) override every one of these.
#
# HOST/TRUST_PROXY/FREEAPI_DB_DIR_HARDENING are the three that matter:
#   HOST=0.0.0.0                  the image binds dual-stack '::' by default;
#                                 pin it so the platform proxy always connects
#   TRUST_PROXY=1                 read X-Forwarded-For, else every request looks
#                                 like the same client to the rate limiter
#   FREEAPI_DB_DIR_HARDENING=1    single-tenant container: allow the data dir to
#                                 be chmod 0700 without warning
#
# ENCRYPTION_KEY and the provider config are deliberately NOT set here as plain
# ENV values - see the self-contained section below, which delivers them as
# files instead.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    TRUST_PROXY=1 \
    FREEAPI_DB_DIR_HARDENING=1 \
    FREEAPI_DB_BACKUP_INTERVAL_MS=300000

# ---------------------------------------------------------------------------
# Self-contained secrets: nothing to type into the host
# ---------------------------------------------------------------------------
# This service needs NO environment variables entered in the Render UI. Both
# secrets are carried inside the image:
#
#   /app/.env                    ENCRYPTION_KEY
#   /app/freellmapi.config.json  admin account + provider API keys + routing
#
# Why these two locations:
#
#   * The server calls dotenv on /app/.env at boot - server/src/env.ts runs
#     `dotenv.config({ path: ... '../../.env' })` and server/src/index.ts imports
#     it on its first line. From /app/server/dist the resolved path is exactly
#     /app/.env. dotenv does NOT overwrite variables that already exist, so
#     setting ENCRYPTION_KEY on the host still wins if you ever want to override.
#
#   * With no FREEAPI_CONFIG_JSON present, the server reads the declarative
#     config from FREEAPI_CONFIG_PATH. (FREEAPI_CONFIG_JSON takes precedence when
#     both are set.)
#
# Why ENCRYPTION_KEY is not simply a field in config.json - it cannot be:
#   * server/src/services/declarative-config.ts validates with a `.strict()` zod
#     object, so ANY unknown top-level key is rejected outright. Adding
#     "ENCRYPTION_KEY": "..." fails with
#       invalid declarative config: Unrecognized key(s) in object: 'ENCRYPTION_KEY'
#   * server/src/lib/crypto.ts reads process.env.ENCRYPTION_KEY and nothing else
#     (initEncryptionKey, line 96). Outside NODE_ENV=production it would
#     auto-generate a key file, but in production it throws at boot instead.
#   * The .env file is therefore the only file-based source it accepts.
#
# Both files are already tracked in this private repository, so nothing is
# exposed here that was not already committed - the image is simply a different
# delivery mechanism for the same secrets. To rotate the key, edit
# freellmapi/.env and redeploy.
COPY freellmapi/.env /app/.env
COPY ops/freellmapi.config.json /app/freellmapi.config.json
ENV FREEAPI_CONFIG_PATH=/app/freellmapi.config.json
