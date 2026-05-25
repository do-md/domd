#!/bin/bash
# Build the DOMDPreview Quick Look extension.
# Produces: build/Release/DOMDPreview.appex (unsigned)
#
# Prerequisites:
#   - Xcode 14+ (for xcodebuild)
#   - xcodegen (brew install xcodegen)
#   - Next.js static export at ../../out/preview/ (i.e. frontend already built)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Validate prerequisites ────────────────────────────────────────────────────
if ! command -v xcodegen >/dev/null 2>&1; then
    echo "Error: xcodegen not found. Install with: brew install xcodegen" >&2
    exit 1
fi

WEB_SRC="$SCRIPT_DIR/../../out"
if [ ! -f "$WEB_SRC/preview.html" ]; then
    echo "Error: $WEB_SRC/preview.html not found." >&2
    echo "Run 'npm run build' in apps/domd first." >&2
    exit 1
fi

# ── Stage web resources into extension bundle source tree ─────────────────────
WEB_DST="$SCRIPT_DIR/DOMDPreview/Resources/web"
rm -rf "$WEB_DST"
mkdir -p "$(dirname "$WEB_DST")"
cp -R "$WEB_SRC" "$WEB_DST"

# ── Generate Xcode project ────────────────────────────────────────────────────
xcodegen generate --spec project.yml --quiet

# ── Build the extension (unsigned — outer script signs) ──────────────────────
DERIVED_DATA="$SCRIPT_DIR/build/DerivedData"
BUILD_PRODUCTS="$SCRIPT_DIR/build/Release"

rm -rf "$DERIVED_DATA" "$BUILD_PRODUCTS"
mkdir -p "$BUILD_PRODUCTS"

xcodebuild \
    -project DOMDPreview.xcodeproj \
    -scheme DOMDPreview \
    -configuration Release \
    -derivedDataPath "$DERIVED_DATA" \
    CODE_SIGN_IDENTITY="" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    ONLY_ACTIVE_ARCH=NO \
    ARCHS="arm64 x86_64" \
    build | xcpretty 2>/dev/null || \
xcodebuild \
    -project DOMDPreview.xcodeproj \
    -scheme DOMDPreview \
    -configuration Release \
    -derivedDataPath "$DERIVED_DATA" \
    CODE_SIGN_IDENTITY="" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    ONLY_ACTIVE_ARCH=NO \
    ARCHS="arm64 x86_64" \
    build

# Locate the built .appex and copy to a predictable path
BUILT_APPEX=$(find "$DERIVED_DATA/Build/Products/Release" -maxdepth 2 -name "DOMDPreview.appex" -type d | head -1)
if [ -z "$BUILT_APPEX" ]; then
    echo "Error: DOMDPreview.appex not produced by xcodebuild" >&2
    exit 1
fi

rm -rf "$BUILD_PRODUCTS/DOMDPreview.appex"
cp -R "$BUILT_APPEX" "$BUILD_PRODUCTS/DOMDPreview.appex"

echo "Built: $BUILD_PRODUCTS/DOMDPreview.appex (unsigned)"
