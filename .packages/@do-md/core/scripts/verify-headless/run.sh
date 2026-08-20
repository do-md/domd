#!/bin/sh
# Bare-Node headless smoke for the public EditorStore surface.
# Runs against the BUILT dist bundle (the exact artifact npm consumers get),
# so it doubles as a dist smoke: it fails when the handwritten public d.ts
# and the mangled runtime drift apart. Part of the release checklist —
# run AFTER `npm run build`.
# Run from the package root: sh scripts/verify-headless/run.sh
cd "$(dirname "$0")/../.." || exit 1
if [ ! -f dist/index.cjs ]; then
  echo "dist/index.cjs not found - run \`npm run build\` first" >&2
  exit 1
fi
node scripts/verify-headless/index.mjs
