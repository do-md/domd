#!/bin/sh
# Local-file candidate parser, streaming and renderer contract verification.
set -eu
cd "$(dirname "$0")/../.."
npx esbuild scripts/verify-file-paths/entry.tsx \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile=scripts/verify-file-paths/out.mjs
node scripts/verify-file-paths/out.mjs
