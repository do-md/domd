#!/bin/sh
# Empty-block (empty to-do item, empty blockquote) round-trip verification.
# Run from the core package root: sh scripts/verify-empty-blocks/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-empty-blocks/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --outfile=scripts/verify-empty-blocks/out.mjs || exit 1
node scripts/verify-empty-blocks/out.mjs
