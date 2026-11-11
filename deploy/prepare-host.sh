#!/usr/bin/env bash
# Build runtime prerequisites without Web or Desktop bundles.
set -euo pipefail
umask 022
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="/opt/dsh/node/bin:$PATH"

pnpm run build:native-system
node --import tsx/esm scripts/compile-referenced-projects.ts host-contracts
