#!/bin/sh
# Soft-break (Shift+Enter) headless assertion matrix.
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-softbreak/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --outfile=scripts/verify-softbreak/out.mjs || exit 1
node scripts/verify-softbreak/out.mjs
