#!/usr/bin/env bash
# Build distribution packages for the LOCAL "gravit-custom" plugin (custom/).
# The four linked plugins (claude-seo, obsidian, mattpocock-skills, azure) are NOT
# built here — they are fetched from their own repos via .claude-plugin/marketplace.json.
#
# Creates zip files for Claude Desktop/Claude.ai (individual skills) and a plugin bundle.
#
# Artifact strategy:
#   dist/<name>.zip          — stable aliases, committed to main for raw downloads
#   dist/<name>-v<ver>.zip   — versioned, gitignored, attached to GitHub Releases
#
# After building, publish versioned artifacts to a release:
#   gh release create v${VERSION} dist/*-v${VERSION}.zip

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
CUSTOM_DIR="$REPO_ROOT/custom"
DIST_DIR="$REPO_ROOT/dist"
VERSION=$(grep '"version"' "$CUSTOM_DIR/.claude-plugin/plugin.json" | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')

_CLEANUP_DIRS=()
cleanup() {
  for d in "${_CLEANUP_DIRS[@]}"; do rm -rf "$d" 2>/dev/null; done
}
trap cleanup EXIT

# Discover every skill (any custom/skills/<name>/ containing a SKILL.md) — no manual list to keep in sync.
SKILLS=()
for dir in "$CUSTOM_DIR"/skills/*/; do
  [ -f "${dir}SKILL.md" ] || continue
  SKILLS+=("$(basename "$dir")")
done

echo "Building gravit-custom distribution packages v${VERSION}..."
echo ""

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Individual skill zips (Claude Desktop / Claude.ai)
echo "Building individual skill zips..."
for skill in "${SKILLS[@]}"; do
    echo "  - $skill"
    TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/gravit-custom.XXXXXX")
    _CLEANUP_DIRS+=("$TMPDIR")
    cp -r "$CUSTOM_DIR/skills/$skill" "$TMPDIR/$skill"
    (cd "$TMPDIR" && zip -rq "$DIST_DIR/${skill}-v${VERSION}.zip" "$skill/" -x "*.DS_Store")
    cp "$DIST_DIR/${skill}-v${VERSION}.zip" "$DIST_DIR/${skill}.zip"
done

# Complete plugin bundle (Claude Code plugin install)
echo "Building gravit-custom bundle..."
TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/gravit-custom.XXXXXX")
_CLEANUP_DIRS+=("$TMPDIR")
BUNDLE="$TMPDIR/gravit-custom"
mkdir -p "$BUNDLE"
cp -r "$CUSTOM_DIR/.claude-plugin" "$BUNDLE/.claude-plugin"
cp -r "$CUSTOM_DIR/skills"         "$BUNDLE/skills"
cp    "$REPO_ROOT/LICENSE"         "$BUNDLE/LICENSE"
(cd "$TMPDIR" && zip -rq "$DIST_DIR/gravit-custom-v${VERSION}.zip" "gravit-custom/" -x "*.DS_Store")
cp "$DIST_DIR/gravit-custom-v${VERSION}.zip" "$DIST_DIR/gravit-custom.zip"

echo ""
echo "Build complete! Files in dist/:"
echo ""
echo "Individual skills (Claude Desktop / Claude.ai):"
for skill in "${SKILLS[@]}"; do
    SIZE=$(du -h "$DIST_DIR/${skill}-v${VERSION}.zip" | cut -f1)
    echo "  ${skill}-v${VERSION}.zip  (${SIZE})"
    echo "  ${skill}.zip  (stable alias)"
done
echo ""
echo "Plugin bundle (Claude Code):"
SIZE=$(du -h "$DIST_DIR/gravit-custom-v${VERSION}.zip" | cut -f1)
echo "  gravit-custom-v${VERSION}.zip  (${SIZE})"
echo "  gravit-custom.zip  (stable alias)"
