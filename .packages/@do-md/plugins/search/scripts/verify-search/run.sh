#!/bin/sh
# @do-md/search headless verification: matcher semantics + SearchStore driving
# the real kernel EditorStore. Run from the package root:
#   sh scripts/verify-search/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-search/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../../utils \
  --alias:@do-md/zenith=../../zenith \
  --outfile=scripts/verify-search/out.mjs || exit 1
node scripts/verify-search/out.mjs
