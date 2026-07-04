#!/usr/bin/env bash
# Codex/cross-tool bundle builder.
#
# Claude Code consumes .claude-plugin/marketplace.json and pulls the four linked
# plugins itself. Codex (and other AGENTS.md-based tools) can't do that — they have
# no marketplace/plugin mechanism. This script materialises every referenced skill
# as plain files under codex/skills/ so the whole set can be shipped from THIS repo
# with a single `npx giget` command (see codex/README.md).
#
# What it does:
#   1. Reads the pinned refs/SHAs straight from .claude-plugin/marketplace.json
#      (single source of truth — no second list to keep in sync).
#   2. Fetches each linked repo's skills/ tree via `npx giget` at that exact pin.
#   3. Flattens every <dir>/SKILL.md into codex/skills/<skill-name>/.
#   4. Adds any gravit-custom-authored skills from custom/skills/ that aren't
#      already provided by a linked repo.
#   5. Regenerates codex/AGENTS.md (the index Codex loads) + codex/skills-manifest.json.
#
# Run:  bash codex/sync.sh   (or: npm run codex:sync)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CODEX_DIR="$REPO_ROOT/codex"
SKILLS_OUT="$CODEX_DIR/skills"
MARKETPLACE="$REPO_ROOT/.claude-plugin/marketplace.json"

command -v node >/dev/null || { echo "node is required (for npx giget + JSON parsing)"; exit 1; }

_CLEANUP_DIRS=()
cleanup() { for d in "${_CLEANUP_DIRS[@]:-}"; do rm -rf "$d" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "Building Codex bundle from marketplace pins..."
echo ""

rm -rf "$SKILLS_OUT"
mkdir -p "$SKILLS_OUT"

# --- 1. Emit "name<TAB>repo<TAB>ref" for every linked (github) plugin ----------
LINKED=$(node -e '
  const m = require(process.argv[1]);
  for (const p of m.plugins) {
    const s = p.source;
    if (!s || typeof s === "string") continue;          // skip local "./custom"
    if (s.source !== "github") continue;                // only plain github repos
    const ref = s.ref || s.sha;                         // tag/branch or commit
    if (!ref) continue;
    process.stdout.write(`${p.name}\t${s.repo}\t${ref}\n`);
  }
' "$MARKETPLACE")

# --- 2 + 3. Fetch each repo's skills/ and flatten SKILL.md dirs ----------------
copy_skill_dirs() {  # $1 = search root, $2 = provenance label
  local root="$1" origin="$2" found=0
  while IFS= read -r skillmd; do
    local dir name
    dir="$(dirname "$skillmd")"
    name="$(basename "$dir")"
    if [ -e "$SKILLS_OUT/$name" ]; then
      echo "    · skip $name (already provided)"
      continue
    fi
    cp -r "$dir" "$SKILLS_OUT/$name"
    printf '%s\t%s\n' "$name" "$origin" >> "$CODEX_DIR/.provenance.tsv"
    found=$((found + 1))
  done < <(find "$root" -type f -name SKILL.md | sort)
  echo "    → $found skill(s) from $origin"
}

: > "$CODEX_DIR/.provenance.tsv"
_CLEANUP_DIRS+=("$CODEX_DIR/.provenance.tsv")

while IFS=$'\t' read -r name repo ref; do
  [ -z "$name" ] && continue
  echo "  ↓ $name  ($repo @ $ref)"
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/codex-sync.XXXXXX")
  _CLEANUP_DIRS+=("$TMP")
  # giget: gh:<owner/repo>/<subdir>#<ref> — pull only the skills/ tree
  if ! npx --yes giget@latest "gh:${repo}/skills#${ref}" "$TMP" --force >/dev/null 2>&1; then
    echo "    ! could not fetch ${repo}/skills#${ref} — trying repo root"
    npx --yes giget@latest "gh:${repo}#${ref}" "$TMP" --force >/dev/null 2>&1 || {
      echo "    ! FAILED to fetch $repo — skipping"; continue; }
  fi
  copy_skill_dirs "$TMP" "$repo@$ref"
done <<< "$LINKED"

# --- 4. Add gravit-custom-authored skills not already covered ------------------
echo "  ↓ gravit-custom (./custom/skills)"
copy_skill_dirs "$REPO_ROOT/custom/skills" "gravit-custom (local)"

# --- 5. Regenerate index + manifest -------------------------------------------
echo ""
echo "Generating codex/AGENTS.md + codex/skills-manifest.json..."
node "$CODEX_DIR/gen-index.mjs" "$SKILLS_OUT" "$CODEX_DIR" "$CODEX_DIR/.provenance.tsv"

COUNT=$(find "$SKILLS_OUT" -type f -name SKILL.md | wc -l | tr -d ' ')
echo ""
echo "Done. $COUNT skill(s) collected in codex/skills/."
echo "Commit codex/ so end users can pull it with a single npx command (see codex/README.md)."
