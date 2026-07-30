#!/usr/bin/env bash
# Render web-service build: deterministic, repository-owned dependency install.
#
# Avoids `npm install` entirely (npm crashed on Render with
# "Exit handler never called!"). Uses Corepack to activate the exact pnpm
# version pinned in package.json's "packageManager" field, then installs
# ONLY production dependencies from the committed pnpm-lock.yaml.
#
# Native Android/iOS projects are never built here — the Capacitor toolchain
# lives in devDependencies and is skipped by --prod.
#
# Render Build Command:  bash scripts/render-build.sh
# Render Start Command:  node server.js

set -euo pipefail

echo "==> render-build: node $(node --version)"

if [ ! -f pnpm-lock.yaml ]; then
  echo "ERROR: pnpm-lock.yaml missing — refusing non-deterministic install." >&2
  exit 1
fi

echo "==> Activating pinned pnpm via Corepack"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# `corepack enable` needs write access next to the node binary, which some
# hosts deny. Enable when possible, but always run pnpm through `corepack
# pnpm`, which honors package.json "packageManager" without any symlinks.
corepack enable 2>/dev/null || echo "    (corepack enable skipped — using 'corepack pnpm' directly)"
corepack prepare --activate

echo "==> pnpm $(corepack pnpm --version): installing production dependencies (frozen lockfile)"
corepack pnpm install --prod --frozen-lockfile

echo "==> Verifying server entrypoint resolves its dependencies"
node --input-type=module -e "
  const mods=['express','pg','jsonwebtoken','bcryptjs','multer','sharp','express-rate-limit','@aws-sdk/client-s3','@aws-sdk/s3-request-presigner'];
  const { createRequire } = await import('node:module');
  const req = createRequire(process.cwd() + '/package.json');
  for (const m of mods) req.resolve(m);
  console.log('All runtime dependencies resolve.');
"

echo "==> render-build: OK"
