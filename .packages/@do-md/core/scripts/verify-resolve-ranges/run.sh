#!/bin/sh
# resolveRanges headless verification (batch, side-effect-free range resolution).
# Run from the core package root: sh scripts/verify-resolve-ranges/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-resolve-ranges/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --outfile=scripts/verify-resolve-ranges/out.mjs || exit 1
node scripts/verify-resolve-ranges/out.mjs
