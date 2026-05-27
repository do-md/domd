#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Target triple — first arg, defaults to Apple Silicon.
# Supported: aarch64-apple-darwin (Apple Silicon) | x86_64-apple-darwin (Intel)
TARGET="${1:-aarch64-apple-darwin}"
case "$TARGET" in
  aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *) echo "Error: unsupported target '$TARGET'" >&2; exit 1 ;;
esac
ARCH="${TARGET%-apple-darwin}"

# Ensure cross-compile stdlib is available (idempotent).
rustup target add "$TARGET" >/dev/null

# ── Load .env.local if running locally ────────────────────────────────────────
if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a
  source "$PROJECT_DIR/.env.local"
  set +a
fi

# ── Validate required env vars ────────────────────────────────────────────────
for var in APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD \
           APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_BASE64; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set" >&2
    exit 1
  fi
done

# ── Decode secrets to temp files ──────────────────────────────────────────────
TMPDIR_BUILD=$(mktemp -d)
trap "rm -rf $TMPDIR_BUILD" EXIT

P12_PATH="$TMPDIR_BUILD/cert.p12"
P8_PATH="$TMPDIR_BUILD/AuthKey.p8"

echo "$APPLE_CERTIFICATE_BASE64" | base64 -d > "$P12_PATH"
echo "$APPLE_API_KEY_BASE64" | base64 -d > "$P8_PATH"

# ── Setup temp keychain ───────────────────────────────────────────────────────
KEYCHAIN_NAME="domd-build.keychain-db"
KEYCHAIN_PASSWORD="domd-build"

security delete-keychain "$KEYCHAIN_NAME" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security set-keychain-settings -t 3600 "$KEYCHAIN_NAME"
security list-keychains -d user -s "$KEYCHAIN_NAME" login.keychain-db

security import "$P12_PATH" -k "$KEYCHAIN_NAME" -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# ── Build main app (Tauri signs but skip notarization; we notarize once at end) ──
echo "Building DOMD for $TARGET..."
cd "$PROJECT_DIR"
# Omit APPLE_API_KEY_PATH so Tauri only signs and does not notarize the half-
# baked bundle; we add the QL extension below, then sign + notarize the whole.
npx tauri build --target "$TARGET" --bundles app

APP_BUNDLE="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/macos/DOMD.app"
if [ ! -d "$APP_BUNDLE" ]; then
  echo "Error: expected .app at $APP_BUNDLE" >&2
  exit 1
fi

# ── Build QL preview extension ────────────────────────────────────────────────
echo "Building QuickLook preview extension..."
"$PROJECT_DIR/src-tauri/preview-extension/build.sh"
APPEX_PATH="$PROJECT_DIR/src-tauri/preview-extension/build/Release/DOMDPreview.appex"
if [ ! -d "$APPEX_PATH" ]; then
  echo "Error: expected .appex at $APPEX_PATH" >&2
  exit 1
fi

# ── Embed extension into app bundle ──────────────────────────────────────────
PLUGINS_DIR="$APP_BUNDLE/Contents/PlugIns"
mkdir -p "$PLUGINS_DIR"
rm -rf "$PLUGINS_DIR/DOMDPreview.appex"
cp -R "$APPEX_PATH" "$PLUGINS_DIR/DOMDPreview.appex"

# ── Inject UTImportedTypeDeclarations into main app Info.plist ───────────────
"$SCRIPT_DIR/inject-uti.sh" "$APP_BUNDLE/Contents/Info.plist"

# ── Bundle the domd-cli binary into the .app ─────────────────────────────────
# Lives at Contents/MacOS/domd-cli alongside the main DOMD binary. MCP / AI
# agents reference it by absolute path (/Applications/DOMD.app/Contents/MacOS/
# domd-cli). The in-app "Install Shell Command" menu symlinks it into
# /usr/local/bin so users can also type `domd-cli` in any shell.
echo "Building domd-cli..."
cd "$PROJECT_DIR/src-tauri"
cargo build --release --target "$TARGET" --bin domd-cli
CLI_SRC="$PROJECT_DIR/src-tauri/target/$TARGET/release/domd-cli"
if [ ! -f "$CLI_SRC" ]; then
  echo "Error: expected domd-cli at $CLI_SRC" >&2
  exit 1
fi
cp "$CLI_SRC" "$APP_BUNDLE/Contents/MacOS/domd-cli"
cd "$PROJECT_DIR"

# ── Re-sign bottom-up ────────────────────────────────────────────────────────
echo "Signing extension + cli + app..."
codesign --force --sign "$APPLE_SIGNING_IDENTITY" \
  --options runtime --timestamp \
  --entitlements "$PROJECT_DIR/src-tauri/preview-extension/DOMDPreview/DOMDPreview.entitlements" \
  "$PLUGINS_DIR/DOMDPreview.appex"

codesign --force --sign "$APPLE_SIGNING_IDENTITY" \
  --options runtime --timestamp \
  "$APP_BUNDLE/Contents/MacOS/domd-cli"

codesign --force --sign "$APPLE_SIGNING_IDENTITY" \
  --options runtime --timestamp \
  --preserve-metadata=entitlements \
  "$APP_BUNDLE"

codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

# ── Notarize + staple the .app ───────────────────────────────────────────────
echo "Notarizing app..."
ZIP_PATH="$TMPDIR_BUILD/DOMD.zip"
/usr/bin/ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP_PATH"

xcrun notarytool submit "$ZIP_PATH" \
  --key "$P8_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

xcrun stapler staple "$APP_BUNDLE"

# ── Build DMG (with stapled .app + /Applications symlink) ────────────────────
echo "Building DMG..."
DMG_DIR="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/dmg"
DMG_PATH="$DMG_DIR/DOMD_${ARCH}.dmg"
mkdir -p "$DMG_DIR"
rm -f "$DMG_PATH"

DMG_STAGING="$TMPDIR_BUILD/dmg-staging"
mkdir -p "$DMG_STAGING"
cp -R "$APP_BUNDLE" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"

hdiutil create \
  -volname "DOMD" \
  -srcfolder "$DMG_STAGING" \
  -ov -format UDZO \
  "$DMG_PATH"

# ── Sign + notarize + staple the DMG ─────────────────────────────────────────
echo "Signing DMG..."
codesign --force --sign "$APPLE_SIGNING_IDENTITY" \
  --options runtime --timestamp \
  "$DMG_PATH"

echo "Notarizing DMG..."
xcrun notarytool submit "$DMG_PATH" \
  --key "$P8_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

xcrun stapler staple "$DMG_PATH"

# ── Cleanup keychain ─────────────────────────────────────────────────────────
security default-keychain -s login.keychain-db
security delete-keychain "$KEYCHAIN_NAME"

echo "Done:"
echo "  App: $APP_BUNDLE"
echo "  DMG: $DMG_PATH"
