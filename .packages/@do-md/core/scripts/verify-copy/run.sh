#!/bin/sh
# Clipboard serializers behind copyAs ("markdown" / "text").
set -eu
cd "$(dirname "$0")/../.."
npx esbuild scripts/verify-copy/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile=scripts/verify-copy/out.mjs
node scripts/verify-copy/out.mjs
