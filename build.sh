#!/usr/bin/env bash
# Build distribution packages for the LOCAL "gravit-custom" plugin.
# Linked marketplace plugins are NOT built here; the neutral registry sync
# materializes them from registry/catalog.json.
#
# Creates individual skill zips and a universal Claude/Codex registry bundle.
#
# Artifact strategy: only versioned archives are produced. They are gitignored and
# attached to GitHub Releases by .github/workflows/release.yml.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$REPO_ROOT/sources/gravit-custom"
GENERATED_DIR="$REPO_ROOT/plugins/gravit-custom"
DIST_DIR="$REPO_ROOT/dist"
VERSION=$(grep '"version"' "$SOURCE_DIR/.claude-plugin/plugin.json" | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')

if [ ! -f "$GENERATED_DIR/.agent-plugin/plugin.json" ] \
  || [ ! -f "$GENERATED_DIR/targets/claude/.claude-plugin/plugin.json" ] \
  || [ ! -f "$GENERATED_DIR/targets/codex/.codex-plugin/plugin.json" ]; then
  echo "Missing generated gravit-custom bundle. Run npm run plugins:sync first." >&2
  exit 1
fi

_CLEANUP_DIRS=()
cleanup() {
  for d in "${_CLEANUP_DIRS[@]}"; do rm -rf "$d" 2>/dev/null; done
}
trap cleanup EXIT

# Discover every maintained skill (any sources/gravit-custom/skills/<name>/ containing a
# SKILL.md) — no manual list to keep in sync.
SKILLS=()
for dir in "$SOURCE_DIR"/skills/*/; do
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
    cp -r "$SOURCE_DIR/skills/$skill" "$TMPDIR/$skill"
    cp "$REPO_ROOT/LICENSE" "$TMPDIR/LICENSE"
    (cd "$TMPDIR" && zip -rq "$DIST_DIR/${skill}-v${VERSION}.zip" "$skill/" LICENSE -x "*.DS_Store")
done

# Complete universal plugin bundle (including both target projections)
echo "Building gravit-custom bundle..."
TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/gravit-custom.XXXXXX")
_CLEANUP_DIRS+=("$TMPDIR")
BUNDLE="$TMPDIR/gravit-custom"
cp -r "$GENERATED_DIR" "$BUNDLE"
cp "$REPO_ROOT/LICENSE" "$BUNDLE/LICENSE"
(cd "$TMPDIR" && zip -rq "$DIST_DIR/gravit-custom-v${VERSION}.zip" "gravit-custom/" -x "*.DS_Store")

echo ""
echo "Build complete! Files in dist/:"
echo ""
echo "Individual skills (Claude Desktop / Claude.ai):"
for skill in "${SKILLS[@]}"; do
    SIZE=$(du -h "$DIST_DIR/${skill}-v${VERSION}.zip" | cut -f1)
    echo "  ${skill}-v${VERSION}.zip  (${SIZE})"
done
echo ""
echo "Universal plugin bundle (Claude Code + Codex targets):"
SIZE=$(du -h "$DIST_DIR/gravit-custom-v${VERSION}.zip" | cut -f1)
echo "  gravit-custom-v${VERSION}.zip  (${SIZE})"
