#!/bin/sh
# setSelection API + selection-aware insertText headless verification.
# Run from the core package root: sh scripts/verify-selection/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-selection/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --outfile=scripts/verify-selection/out.mjs || exit 1
node scripts/verify-selection/out.mjs
