#!/usr/bin/env bash
set -euo pipefail

# Renovate runs this after Claude marketplace pin updates so the generated
# native Codex plugins stay on the same immutable revisions.
npm ci --ignore-scripts
npm run plugins:sync
