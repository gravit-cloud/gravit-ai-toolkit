#!/usr/bin/env bash
set -euo pipefail

# Renovate runs this after marketplace pin updates so the generated Codex
# bundle is part of the same Renovate branch and passes the repository gate.
npm ci --ignore-scripts
npm run codex:sync
