#!/bin/bash
# Desktop release pipeline — the same posture as the kernel's release.mjs:
# the script picks the version, checks everything, and only then bumps it.
#
# Usage:
#   npm run release                      # asks: Enter = patch, or major/minor/patch, or x.y.z
#   npm run release -- minor             # no prompt
#   npm run release -- 0.11.0
#
# It will:
#   - Check before changing anything: on main, clean working tree, gh signed
#     in, package.json and tauri.conf.json agree on the current version, the
#     tag is free, the CHANGELOG is ready
#   - Write the new version into package.json, Cargo.toml, tauri.conf.json
#     and project.yml
#   - Run scripts/build.sh once per target (signed + notarized DMG; needs .env.local)
#   - Move the CHANGELOG's Unreleased entries into the vX.Y.Z section
#     (scripts/changelog.mjs app — validated before the build, applied before
#     the commit, so the release commit carries it)
#   - Commit + tag + push to origin
#   - Create a GitHub release with both DMGs attached
#
# Output DMGs: DOMD_aarch64.dmg (Apple Silicon) + DOMD_x86_64.dmg (Intel).
# No version in the names — matches README's releases/latest/download/...
# permalink so the link stays valid across releases.
#
# Recovery: if build fails after the version sync, reset with
#   git checkout -- package.json src-tauri/Cargo.toml \
#       src-tauri/tauri.conf.json src-tauri/preview-extension/project.yml \
#       CHANGELOG.md CHANGELOG.zh-CN.md CHANGELOG.ja.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── Sanity (nothing is changed until every check passes) ─────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
    echo "Error: releases are cut from main; current branch is \"$BRANCH\"." >&2
    exit 1
fi

# The DMGs are built from the working tree, so it must equal the commit.
DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
    echo "Error: the working tree has uncommitted changes — commit or stash them first:" >&2
    echo "$DIRTY" >&2
    exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
    echo "Error: gh CLI not found. Install with: brew install gh" >&2
    exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
    echo "Error: gh not authenticated. Run: gh auth login" >&2
    exit 1
fi

OLD_VERSION=$(node -p "require('./package.json').version")
TAURI_VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
if [ "$OLD_VERSION" != "$TAURI_VERSION" ]; then
    echo "Error: package.json ($OLD_VERSION) and tauri.conf.json ($TAURI_VERSION) disagree" >&2
    echo "       on the current version — finish or undo the previous release first." >&2
    exit 1
fi

# ── Choose the version ────────────────────────────────────────────────────────
bump() {
    local major minor patch
    IFS=. read -r major minor patch <<< "$1"
    case "$2" in
        major) echo "$((major + 1)).0.0" ;;
        minor) echo "$major.$((minor + 1)).0" ;;
        *)     echo "$major.$minor.$((patch + 1))" ;;
    esac
}

SUGGESTED=$(bump "$OLD_VERSION" patch)
echo ""
echo "  Package  domd (desktop + web)"
echo "  Current  $OLD_VERSION"
echo ""
ANSWER="${1:-}"
if [ $# -eq 0 ]; then
    read -r -p "New version (Enter=patch→$SUGGESTED, or major/minor/patch, or explicit x.y.z): " ANSWER
fi
case "$ANSWER" in
    "" | patch)   NEW_VERSION="$SUGGESTED" ;;
    major | minor) NEW_VERSION=$(bump "$OLD_VERSION" "$ANSWER") ;;
    *)            NEW_VERSION="$ANSWER" ;;
esac

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: invalid version \"$ANSWER\" (expected x.y.z, major, minor or patch)" >&2
    exit 1
fi
if [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
    echo "Error: $NEW_VERSION is already the current version" >&2
    exit 1
fi

TAG="v$NEW_VERSION"
echo ""
echo "Releasing $TAG (previous: $OLD_VERSION)"

if git rev-parse --verify "$TAG" >/dev/null 2>&1; then
    echo "Error: tag $TAG already exists locally" >&2
    exit 1
fi
if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "refs/tags/$TAG"; then
    echo "Error: tag $TAG already exists on origin" >&2
    exit 1
fi

# The CHANGELOG must be ready for this release (aligned, Unreleased has
# entries) — checked now, before the long build, applied before the commit.
if ! node scripts/changelog.mjs app "$NEW_VERSION" --dry-run; then
    echo "Error: the CHANGELOG is not ready for $TAG (see above)" >&2
    exit 1
fi

# ── [1/4] Write the version into the four files ───────────────────────────────
echo "[1/4] Writing $NEW_VERSION into package.json, Cargo.toml, tauri.conf.json, project.yml..."
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = process.argv[1];
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 4) + "\n");
' "$NEW_VERSION"
sed -i '' -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml
sed -i '' -E "s/^  \"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/  \"version\": \"$NEW_VERSION\"/" src-tauri/tauri.conf.json
sed -i '' -E "s/(MARKETING_VERSION: \")[0-9]+\.[0-9]+\.[0-9]+(\")/\1$NEW_VERSION\2/" src-tauri/preview-extension/project.yml

for f in package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/preview-extension/project.yml; do
    if ! grep -q "$NEW_VERSION" "$f"; then
        echo "Error: version sync did not apply to $f" >&2
        exit 1
    fi
done

# ── [2/4] Build signed + notarized DMGs (Apple Silicon + Intel) ──────────────
echo "[2/4] Building signed + notarized DMGs for both arches (this takes a while)..."
TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)
DMG_PATHS=()
TAR_PATHS=()
SIG_AARCH64=""
SIG_X86_64=""
for TARGET in "${TARGETS[@]}"; do
    ARCH="${TARGET%-apple-darwin}"
    echo ">> Building $TARGET..."
    "$SCRIPT_DIR/build.sh" "$TARGET"
    DMG="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/dmg/DOMD_${ARCH}.dmg"
    TAR="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/macos/DOMD_${ARCH}.app.tar.gz"
    if [ ! -f "$DMG" ]; then
        echo "Error: expected DMG at $DMG" >&2
        exit 1
    fi
    if [ ! -f "$TAR" ] || [ ! -f "$TAR.sig" ]; then
        echo "Error: expected updater bundle at $TAR(.sig)" >&2
        exit 1
    fi
    DMG_PATHS+=("$DMG")
    TAR_PATHS+=("$TAR" "$TAR.sig")
    case "$ARCH" in
        aarch64) SIG_AARCH64=$(cat "$TAR.sig") ;;
        x86_64)  SIG_X86_64=$(cat "$TAR.sig") ;;
    esac
done

# ── Generate latest.json (Tauri updater manifest) ────────────────────────────
LATEST_JSON="$PROJECT_DIR/src-tauri/target/latest.json"
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$LATEST_JSON" <<EOF
{
  "version": "$NEW_VERSION",
  "notes": "See https://github.com/do-md/domd/releases/tag/$TAG",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIG_AARCH64",
      "url": "https://github.com/do-md/domd/releases/download/$TAG/DOMD_aarch64.app.tar.gz"
    },
    "darwin-x86_64": {
      "signature": "$SIG_X86_64",
      "url": "https://github.com/do-md/domd/releases/download/$TAG/DOMD_x86_64.app.tar.gz"
    }
  }
}
EOF

# ── [3/4] Commit + tag + push ─────────────────────────────────────────────────
echo "[3/4] Committing + tagging + pushing..."
node scripts/changelog.mjs app "$NEW_VERSION"
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/preview-extension/project.yml \
    CHANGELOG.md CHANGELOG.zh-CN.md CHANGELOG.ja.md
if git ls-files --error-unmatch src-tauri/Cargo.lock >/dev/null 2>&1; then
    git add src-tauri/Cargo.lock
fi
git commit -m "Release $TAG"
git tag -a "$TAG" -m "DOMD $TAG"
git push
git push origin "$TAG"

# ── [4/4] Create GitHub release ───────────────────────────────────────────────
# --notes content is prepended to the auto-generated changelog by gh.
echo "[4/4] Creating GitHub release $TAG..."
RELEASE_NOTES=$(cat <<'EOF'
> **Note:** The Intel (x86_64) build is tested via Rosetta 2 on Apple Silicon, not on native Intel hardware — please report any issues.
EOF
)
gh release create "$TAG" \
    --title "DOMD $TAG" \
    --notes "$RELEASE_NOTES" \
    --generate-notes \
    "${DMG_PATHS[@]}" \
    "${TAR_PATHS[@]}" \
    "$LATEST_JSON"

echo ""
echo "Done."
echo "  Tag:     $TAG"
for d in "${DMG_PATHS[@]}"; do echo "  DMG:     $d"; done
for t in "${TAR_PATHS[@]}"; do echo "  Updater: $t"; done
echo "  Manifest: $LATEST_JSON"
echo "  Release: $(gh release view "$TAG" --json url -q .url 2>/dev/null || echo "see GitHub")"
