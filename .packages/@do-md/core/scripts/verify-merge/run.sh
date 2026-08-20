#!/bin/sh
# Offline verification for mergeInlineBlock (span-preserving diff).
# Run from the core package root: sh scripts/verify-merge/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-merge/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --alias:@do-md/utils=../utils \
  --outfile=scripts/verify-merge/out.mjs || exit 1
node scripts/verify-merge/out.mjs 2>&1 | grep -v "^parseMarkdown:"
