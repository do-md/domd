#!/bin/bash
# Manual release pipeline. Driven by the "version" field in package.json.
#
# Usage:
#   1. Bump "version" in package.json (e.g. 0.1.0 -> 0.2.0)
#   2. Run this script:  ./scripts/release.sh
#
# It will:
#   - Read the new version from package.json
#   - Verify it differs from src-tauri/tauri.conf.json (terminates if same)
#   - Sync the new version into Cargo.toml, tauri.conf.json, and project.yml
#   - Run scripts/build.sh (signed + notarized DMG; needs .env.local)
#   - Commit + tag + push to origin
#   - Create a GitHub release with the DMG attached
#
# Output DMG: DOMD_aarch64.dmg (no version in name — matches README's
# releases/latest/download/... permalink so the link stays valid across releases).
#
# Recovery: if build fails after the version sync, reset with
#   git checkout -- package.json src-tauri/Cargo.toml \
#       src-tauri/tauri.conf.json src-tauri/preview-extension/project.yml

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── Read versions ─────────────────────────────────────────────────────────────
NEW_VERSION=$(node -e "console.log(require('./package.json').version)")
OLD_VERSION=$(node -e "console.log(require('./src-tauri/tauri.conf.json').version)")

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: package.json version '$NEW_VERSION' is not semver X.Y.Z" >&2
    exit 1
fi

if [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
    echo "Error: package.json version ($NEW_VERSION) is unchanged." >&2
    echo "       Bump 'version' in package.json before running release." >&2
    exit 1
fi

TAG="v$NEW_VERSION"
echo "Releasing $TAG (previous: $OLD_VERSION)"

# ── Sanity ────────────────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
    echo "Error: gh CLI not found. Install with: brew install gh" >&2
    exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
    echo "Error: gh not authenticated. Run: gh auth login" >&2
    exit 1
fi

# Allow package.json to be dirty (the user just bumped it). Reject anything else.
UNEXPECTED_DIRTY=$(git status --porcelain | awk '{print $NF}' | grep -v '^package\.json$' || true)
if [ -n "$UNEXPECTED_DIRTY" ]; then
    echo "Error: only package.json may have uncommitted changes. Also dirty:" >&2
    echo "$UNEXPECTED_DIRTY" >&2
    exit 1
fi

if git rev-parse --verify "$TAG" >/dev/null 2>&1; then
    echo "Error: tag $TAG already exists locally" >&2
    exit 1
fi
if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "refs/tags/$TAG"; then
    echo "Error: tag $TAG already exists on origin" >&2
    exit 1
fi

# ── [1/4] Sync version into the other three files ─────────────────────────────
echo "[1/4] Syncing $NEW_VERSION into Cargo.toml, tauri.conf.json, project.yml..."
sed -i '' -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml
sed -i '' -E "s/^  \"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/  \"version\": \"$NEW_VERSION\"/" src-tauri/tauri.conf.json
sed -i '' -E "s/(MARKETING_VERSION: \")[0-9]+\.[0-9]+\.[0-9]+(\")/\1$NEW_VERSION\2/" src-tauri/preview-extension/project.yml

for f in src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/preview-extension/project.yml; do
    if ! grep -q "$NEW_VERSION" "$f"; then
        echo "Error: version sync did not apply to $f" >&2
        exit 1
    fi
done

# ── [2/4] Build signed + notarized DMG ────────────────────────────────────────
echo "[2/4] Building signed + notarized DMG (a few minutes)..."
"$SCRIPT_DIR/build.sh"

DMG_PATH="$PROJECT_DIR/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/DOMD_aarch64.dmg"
if [ ! -f "$DMG_PATH" ]; then
    echo "Error: expected DMG at $DMG_PATH" >&2
    exit 1
fi

# ── [3/4] Commit + tag + push ─────────────────────────────────────────────────
echo "[3/4] Committing + tagging + pushing..."
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/preview-extension/project.yml
if git ls-files --error-unmatch src-tauri/Cargo.lock >/dev/null 2>&1; then
    git add src-tauri/Cargo.lock
fi
git commit -m "Release $TAG"
git tag -a "$TAG" -m "DOMD $TAG"
git push
git push origin "$TAG"

# ── [4/4] Create GitHub release ───────────────────────────────────────────────
echo "[4/4] Creating GitHub release $TAG..."
gh release create "$TAG" \
    --title "DOMD $TAG" \
    --generate-notes \
    "$DMG_PATH"

echo ""
echo "Done."
echo "  Tag:     $TAG"
echo "  DMG:     $DMG_PATH"
echo "  Release: $(gh release view "$TAG" --json url -q .url 2>/dev/null || echo "see GitHub")"
