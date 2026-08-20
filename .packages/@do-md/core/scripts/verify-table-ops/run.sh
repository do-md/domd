#!/bin/sh
# Structural table ops (addTableRow/addTableColumn) headless verification.
# Run from the core package root: sh scripts/verify-table-ops/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-table-ops/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --outfile=scripts/verify-table-ops/out.mjs || exit 1
node scripts/verify-table-ops/out.mjs
