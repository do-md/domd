#!/bin/sh
# GFM table immediately after a paragraph line (issue #18).
# Run from the core package root: sh scripts/verify-table-after-paragraph/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-table-after-paragraph/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --packages=external \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --outfile=scripts/verify-table-after-paragraph/out.mjs || exit 1
node scripts/verify-table-after-paragraph/out.mjs
