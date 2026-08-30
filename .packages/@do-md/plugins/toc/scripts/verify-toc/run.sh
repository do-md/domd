#!/bin/sh
# @do-md/toc headless verification: outline extraction + TocStore driving
# the real kernel EditorStore. Run from the package root:
#   sh scripts/verify-toc/run.sh
cd "$(dirname "$0")/../.." || exit 1
npx esbuild scripts/verify-toc/entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --jsx=automatic \
  --alias:@do-md/utils=../../utils \
  --alias:@do-md/zenith=../../zenith \
  --outfile=scripts/verify-toc/out.mjs || exit 1
node scripts/verify-toc/out.mjs
