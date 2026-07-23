#!/bin/sh
# Offline verification of the crdt-sync plugin.
# Run from this directory (plugins/collaboration/crdt-sync/verify) or anywhere:
#   sh plugins/collaboration/crdt-sync/verify/run.sh
cd "$(dirname "$0")" || exit 1
APP_ROOT="$(cd ../../../.. && pwd)"           # apps/domd
CORE_ROOT="$(cd ../../../../../../packages/domd-core && pwd)"

"$CORE_ROOT/node_modules/.bin/esbuild" entry.ts \
  --bundle \
  --format=esm \
  --platform=node \
  --alias:@do-md/utils="$CORE_ROOT/.packages/@do-md/utils" \
  --alias:yjs="$APP_ROOT/node_modules/yjs" \
  --alias:immer="$APP_ROOT/node_modules/immer" \
  --outfile=out.mjs || exit 1
node out.mjs 2>&1 | grep -v "^parseMarkdown:"
