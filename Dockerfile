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
# ENCRYPTION_KEY is deliberately NOT set here. Two reasons: in production the
# server refuses to boot without it (server/src/lib/crypto.ts), and baking a key
# into an image layer would ship the secret inside the image. Set it as an
# environment variable on the service instead.
#
# FREEAPI_CONFIG_JSON is likewise not set here: it contains the live provider
# API keys and must be supplied as a service environment variable.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    TRUST_PROXY=1 \
    FREEAPI_DB_DIR_HARDENING=1 \
    FREEAPI_DB_BACKUP_INTERVAL_MS=300000
