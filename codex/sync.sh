#!/usr/bin/env bash
# Codex/cross-tool bundle builder.
#
# The marketplace installs linked plugins directly in Claude Code. Codex instead
# consumes this generated, source-preserving skill snapshot. Keeping each
# upstream skills/ hierarchy intact prevents relative Markdown links inside
# complex skills from breaking without vendoring whole repositories.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CODEX_DIR="$REPO_ROOT/codex"
SOURCES_OUT="$CODEX_DIR/sources"
LEGACY_SKILLS="$CODEX_DIR/skills"
MARKETPLACE="$REPO_ROOT/.claude-plugin/marketplace.json"
PROVENANCE="$CODEX_DIR/.provenance.tsv"

command -v node >/dev/null || { echo "node is required"; exit 1; }
command -v curl >/dev/null || { echo "curl is required"; exit 1; }

cleanup() { rm -f "$PROVENANCE"; }
trap cleanup EXIT

echo "Building source-preserving Codex bundle from marketplace pins..."
echo ""

rm -rf "$SOURCES_OUT"
rm -rf "$LEGACY_SKILLS"
mkdir -p "$SOURCES_OUT"
: > "$PROVENANCE"

# Emit plugin name, GitHub repo, immutable SHA, and readable ref. The SHA is
# deliberately preferred for downloads; the ref exists for human review/Renovate.
LINKED=$(node -e '
  const marketplace = require(process.argv[1]);
  for (const plugin of marketplace.plugins) {
    const source = plugin.source;
    if (!source || typeof source === "string" || source.source !== "github") continue;
    if (!source.repo || !source.sha) {
      throw new Error(`${plugin.name}: github sources must provide repo and immutable sha`);
    }
    process.stdout.write(`${plugin.name}\t${source.repo}\t${source.sha}\t${source.ref || source.sha}\n`);
  }
' "$MARKETPLACE")

record_skills() { # $1 = skills root, $2 = origin
  local source_root="$1" origin="$2" found=0 skillmd relative
  while IFS= read -r skillmd; do
    relative="${skillmd#$CODEX_DIR/}"
    printf '%s\t%s\n' "$relative" "$origin" >> "$PROVENANCE"
    found=$((found + 1))
  done < <(find "$source_root" -type f -name SKILL.md | sort)
  echo "    → $found indexed skill(s) from $origin"
}

while IFS=$'\t' read -r name repo sha ref; do
  [ -z "$name" ] && continue
  destination="$SOURCES_OUT/$name"
  echo "  ↓ $name  ($repo @ $sha; $ref)"
  mkdir -p "$destination"
  # Preserve only the upstream skills hierarchy. This keeps sibling workflow
  # references valid while avoiding unrelated source, CI and release files.
  npx --no-install giget "gh:${repo}/skills#${sha}" "$destination/skills" --force >/dev/null
  curl -fsSL "https://raw.githubusercontent.com/${repo}/${sha}/LICENSE" -o "$destination/LICENSE"
  # seo-flow references a framework image outside skills/.
  if [ "$name" = "claude-seo" ]; then
    npx --no-install giget "gh:${repo}/assets#${sha}" "$destination/assets" --force >/dev/null
  fi
  record_skills "$destination/skills" "$repo@$sha"
done <<< "$LINKED"

echo "  ↓ gravit-custom (./custom)"
cp -R "$REPO_ROOT/custom" "$SOURCES_OUT/gravit-custom"
record_skills "$SOURCES_OUT/gravit-custom/skills" "gravit-custom (local)"

echo ""
echo "Generating codex/AGENTS.md + codex/skills-manifest.json..."
node "$CODEX_DIR/gen-index.mjs" "$CODEX_DIR" "$PROVENANCE"

COUNT=$(wc -l < "$PROVENANCE" | tr -d ' ')
echo ""
echo "Done. $COUNT indexed skill(s) collected in codex/sources/."
echo "Commit codex/ so end users can pull the bundle with a single npx command."
