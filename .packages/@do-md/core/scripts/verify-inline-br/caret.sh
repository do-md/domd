#!/bin/sh
# Caret placement around line breaks, in headless Chrome (see caret.tsx).
# Run from the core package root: sh scripts/verify-inline-br/caret.sh
# CHROME overrides the browser binary (default: macOS Google Chrome).
set -eu
cd "$(dirname "$0")/../.."
DIR=scripts/verify-inline-br
npx esbuild "$DIR/caret.tsx" \
  --bundle \
  --format=iife \
  --platform=browser \
  --jsx=automatic \
  --alias:@do-md/utils=../utils \
  --alias:@do-md/zenith=../zenith \
  --define:process.env.NODE_ENV='"development"' \
  --outdir="$DIR/caret-out" \
  --entry-names=caret \
  --log-level=warning
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
"$CHROME" --headless=new --disable-gpu --no-first-run \
  --user-data-dir="$PROFILE" --virtual-time-budget=30000 \
  --dump-dom "file://$PWD/$DIR/caret.html" > "$DIR/caret-out/dom.html" 2>/dev/null
rm -rf "$PROFILE"
node -e '
const html = require("fs").readFileSync(process.argv[1], "utf8");
const match = html.match(/<pre id="out">([\s\S]*?)<\/pre>/);
const text = (match ? match[1] : "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
console.log(text || "no result: the page did not finish");
if (!/ passed, 0 failed$/.test(text)) process.exitCode = 1;
' "$DIR/caret-out/dom.html"
