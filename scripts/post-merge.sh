#!/bin/bash
set -e

# Install all workspace dependencies
pnpm install --frozen-lockfile

# Pre-build the portal + api-server so the first workflow start serves the
# portal immediately on remix (no cold-start build delay).
BASE_PATH=/ PORT=3000 pnpm --filter @workspace/api-portal run build
pnpm --filter @workspace/api-server run build
