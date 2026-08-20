#!/bin/sh
# Batch replace API (replaceRanges/replaceText) headless verification.
# Run from the core package root: sh scripts/verify-replace/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-replace/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --outfile=scripts/verify-replace/out.mjs || exit 1
node scripts/verify-replace/out.mjs
