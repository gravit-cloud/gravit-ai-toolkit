#!/usr/bin/env bash
set -euo pipefail

# Install repository tooling without lifecycle scripts, bump only catalog
# distribution revisions whose immutable source changed, then regenerate and
# statically validate every target. None of these steps invokes bundled code.
npm ci --ignore-scripts
node scripts/bump-plugin-revisions.mjs
npm run plugins:sync
npm run validate
