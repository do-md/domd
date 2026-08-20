#!/bin/sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/bench-merge/entry.ts --bundle --format=esm --platform=node --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --outfile=scripts/bench-merge/out.mjs || exit 1
node scripts/bench-merge/out.mjs
