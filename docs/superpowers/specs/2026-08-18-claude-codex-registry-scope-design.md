# Claude and Codex Registry Scope

**Date:** 2026-08-18
**Status:** Ready for review

## Decision

The plugin registry supports Claude Code and Codex as its only runtime targets. It retains an agent-neutral component inventory, but it no longer generates, validates, packages, materializes, documents, or smoke-tests an OpenClaw projection.

This is a scope reduction, not a redesign of the registry foundation. A future agent can be added through the existing target-renderer boundary only when its file format, capability policy, validation rules, installation flow, and smoke tests are implemented as one complete adapter.

## Context

The registry's purpose is to provide one versioned, auditable store for dynamically loadable agent components used in local development, shared storage, pipelines, and cloud agents. Claude Code and Codex are the maintained consumers.

OpenClaw currently reuses the Codex-format renderer but adds target-specific policy, resource relocation, validation, materialization, release, dependency, documentation, and smoke-test branches. This expands the maintenance and compatibility surface without providing a fully supported OpenClaw runtime contract.

## Goals

- Keep one neutral inventory for skills, MCP servers, hooks, apps, commands, agents, executables, settings, and assets.
- Produce deterministic `targets/claude` and `targets/codex` projections only.
- Preserve explicit target capability accounting and fail closed when a required component cannot be represented.
- Keep distribution provenance, immutable source pins, bundle hashes, receipts, and write-once materialization unchanged in principle.
- Make a future target an explicit adapter addition rather than a dormant conditional spread through the codebase.

## Non-goals

- Supporting OpenClaw installation, discovery, activation, or compatibility.
- Preserving OpenClaw as a hidden or experimental target.
- Building a generic lowest-common-denominator plugin format for arbitrary coding agents.
- Deleting previously materialized OpenClaw directories or rewriting immutable historical release archives.

## Architecture

The build pipeline is:

```text
pinned source + catalog
          |
          v
 neutral component inventory
       /             \
      v               v
Claude projection   Codex projection
```

The neutral inventory remains the authoritative description of what a plugin contains. Target adapters decide how each component is preserved, transformed, or rejected for one host. The supported target set is exactly `claude` and `codex` in schemas, catalog validation, policy evaluation, target rendering, registry inspection, materialization, receipts, and release validation.

There is no placeholder OpenClaw adapter or generic `codex-format` alias exposed as another target. The renderer dispatch remains modular so a future target can be introduced without changing the neutral inventory model.

## Repository Changes

### Catalog and generated bundles

- Remove `openclaw` from every plugin's `targets`, `targetPolicies`, and `adapterOptions`.
- Regenerate every plugin without `targets/openclaw`.
- Regenerate neutral manifests, marketplaces, and `registry/lock.json` with only Claude and Codex dispositions.
- Increment every affected plugin `distributionVersion`, because removing a committed projection changes the immutable bundle identity.

### Runtime and validation code

- Delete the OpenClaw target renderer.
- Reduce all target allowlists and schemas to `claude` and `codex`.
- Remove OpenClaw-specific resource relocation, host-manifest rules, policy defaults, runtime checks, receipt handling, and materialization branches.
- Keep shared Claude/Codex rendering logic factored behind target-specific adapters; do not replace it with host-name conditionals in the neutral inventory layer.
- Reject `openclaw` as an unsupported target at every public CLI and library boundary.

### Dependencies, CI, and documentation

- Remove the OpenClaw npm dependency and client smoke harness.
- Remove OpenClaw installation examples and compatibility claims from maintained documentation.
- Remove active OpenClaw tests. Historical plans may continue to describe prior work, but authoritative specifications and current usage documentation must identify Claude and Codex only.

## Data and Compatibility

Existing OpenClaw materializations and historical archives are not deleted or mutated. New registry code does not inspect, activate, replace, or promise compatibility with them. Consumers that still depend on such an artifact must remain pinned to the historical registry revision that produced it.

The first Claude/Codex-only release is a new immutable registry revision. A consumer upgrades by selecting that revision and materializing either the Claude or Codex target into a new write-once destination.

## Error Handling

- Catalogs, commands, receipts, or API calls that request `openclaw` fail with a stable unsupported-target error before creating output.
- A component supported by neither Claude nor Codex fails catalog validation unless its disposition is explicitly represented by the existing target policy model.
- Generation remains atomic: a failure cannot publish a partially reduced registry.
- Version-history validation rejects changed bundles without a strictly newer distribution version.

## Testing and Acceptance Criteria

The change is complete when:

1. The production catalog contains only `claude` and `codex` targets.
2. No generated plugin contains `targets/openclaw` or an OpenClaw disposition.
3. Runtime code, package dependencies, CI, smoke tests, and current documentation contain no active OpenClaw integration.
4. Public target parsers reject `openclaw` without creating files.
5. Claude and Codex component accounting remains complete for every plugin.
6. `npm run plugins:sync` is deterministic across two fresh runs.
7. `npm test`, `npm run validate`, and a release build into a fresh write-once `DIST_DIR` pass.
8. The Azure nested-skill regression remains green in both generated projections.

## Integration Order

1. Rebase the agent-neutral registry branch onto the current production hotfix so current Azure source pins and distribution versions win.
2. Add failing tests for the two-target contract and unsupported OpenClaw requests.
3. Remove runtime support and the dependency.
4. Update the catalog and regenerate all managed artifacts with required version bumps.
5. Update current documentation and run the complete verification suite.
