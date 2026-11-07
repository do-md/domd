#!/bin/sh
# Inline `<br>` is a hard line break, not literal text (AI/table-cell case).
# Run from the core package root: sh scripts/verify-inline-br/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-inline-br/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --packages=external \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --outfile=scripts/verify-inline-br/out.mjs || exit 1
node scripts/verify-inline-br/out.mjs
