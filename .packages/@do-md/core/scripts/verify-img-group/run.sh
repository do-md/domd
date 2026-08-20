#!/bin/sh
# ImgGroup aggregation (imgGroupSeparators) headless verification.
# Run from the core package root: sh scripts/verify-img-group/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-img-group/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile=scripts/verify-img-group/out.mjs || exit 1
node scripts/verify-img-group/out.mjs
