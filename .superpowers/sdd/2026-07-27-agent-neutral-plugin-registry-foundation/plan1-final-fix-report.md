# Plan 1 final fix report — round 1

Basis: `7c98ac66c8dacedf3940ddc010a5ee3e8c74764f`

Scope: the seven Important findings from the Plan 1 final review, plus the
minor `RegistryResult` contract when it can be satisfied without Plan 2 work.
`progress.md` is intentionally unchanged.

## Baseline

- `npm test` — GREEN: 45 tests passed, 0 failed before changes.
- Public test seams: `discoverSkills`/`renderSkills`, `loadCatalog`,
  `withAtomicOutput`, and `buildRegistry`/the foundation CLI.

## Finding 2 — declared roots must be recursively inventoried

Root cause: `discoverSkills` stopped at a declared directory as soon as that
directory itself contained a standalone `SKILL.md`. Descendants were only
walked when the declared root was not itself a skill.

- RED: `node --test test/unit/skills-discovery.test.mjs` — 4 passed, 1 failed.
  `recursively inventories declared roots and deduplicates overlapping
  declarations` returned only `parent`, omitting the expected `child`.
- GREEN: `node --test test/unit/skills-discovery.test.mjs` — 5 passed, 0 failed.
  Every declared root now uses the same recursive inventory; the existing
  canonical-directory deduplication collapses overlapping declarations.
- RED (post-projection guard): the named recursive-duplicate test failed with
  `Missing expected exception` (0 passed, 1 failed).
- GREEN: the combined discovery/render/foundation focus passed 17/17. Every
  projection is now recursively scanned after rendering and rejects duplicate
  frontmatter names while continuing to allow internal `SKILL.md` resources
  without frontmatter.

## Finding 1 — disjoint neutral skill components

Root cause: `buildPluginBundle` used `cpSync` independently for every selected
skill root. A parent therefore retained the complete selected child subtree,
and the separately copied child appeared a second time and contributed to the
parent digest.

- RED: `node --test test/integration/foundation-build.test.mjs` — 2 passed,
  1 failed. Recursive neutral names were `child`, `child`, `parent` instead of
  `child`, `parent`.
- GREEN: the integration suite passed 3/3 after neutral components were routed
  through the same descendant-aware projection as targets. The parent no
  longer contains `parent/child/SKILL.md`, its cross-component link targets
  `../child/SKILL.md`, and its digest covers only the disjoint parent tree.

## Finding 4 — locale-independent deterministic ordering

Root cause: discovery and neutral component ordering called `localeCompare`,
so the generated order depended on the host collation rules.

- RED: `node --test test/unit/skills-discovery.test.mjs` — 5 passed, 1 failed.
  For real directories named `B` and `a`, discovery returned the locale order
  (`a`, `B`) instead of the required codepoint order (`B`, `a`). No global
  locale or built-in method was replaced by the test.
- GREEN: the focused discovery suite passed 6/6. The artifact and foundation
  integration suites also passed 14/14. A shared `compareCodePoints` now drives
  discovery, neutral component, recursive file, tree-record, and JSON-key
  ordering; `rg -n 'localeCompare' scripts` returned no matches.

## Finding 3 — parser-backed links for every copied Markdown resource

Root cause: link rewriting used a bespoke inline-link/code scanner and only
opened each selected root's top-level `SKILL.md`. Other copied Markdown files,
reference definitions, images, and four-space-indented CommonMark code were
outside the transformation/validation boundary.

- RED (complete projection): the named resource test failed 0/1. Inline,
  image, and reference-definition destinations in `guide.md` all remained at
  `./child/...` instead of pointing to the projected sibling component.
- GREEN: the complete render suite passed 9/9 after every copied `.md` and
  `.markdown` file was transformed from parser token offsets. The four-space
  indented code sample remained byte-identical. A pre-existing symlink test
  initially observed an earlier fail-closed symlink error; projected file
  enumeration was adjusted so the more specific mapping error remains stable,
  then the suite passed.
- RED (post-projection validation): the unresolved-resource test failed 0/1
  with `Missing expected exception` for `guide.md -> ./missing.md`.
- GREEN: the render suite passed 10/10 after the complete rendered Markdown
  tree was parsed again and every relative local destination was required to
  exist canonically inside the projection root.

Dependency decision: `micromark@4.0.2` is an exact direct devDependency. Its
CommonMark tokenizer exposes source offsets for inline/image resource
destinations and reference-definition destinations while never emitting those
tokens for inline, fenced, or indented code. Replacing only those ranges keeps
all other upstream Markdown bytes and formatting intact. `npm install` added
28 locked transitive packages; none of the new parser packages ran install
scripts. The install reported one moderate audit item in the aggregate project
dependency tree; no audit remediation was attempted because it is outside this
fix scope.

## Finding 5 — concurrent output reappearance during promotion

Root cause: when promotion failed after the old tree had moved to backup and a
new `outputRoot` concurrently appeared, atomic output retained the backup but
re-threw only the original promotion error. The caller had no recovery path.

- RED: the named artifact regression failed 0/1 because the caught error was
  the plain synthetic promotion `Error`, not an `AggregateError`.
- GREEN: `node --test test/unit/artifacts.test.mjs` passed 12/12. The collision
  branch now leaves the concurrent output untouched, retains the previous tree,
  and reports the promotion/collision errors plus `recoveryPath`.

## Finding 6 — canonical catalog and fixture-source containment

Root cause: `loadCatalog` directly read `resolve(repositoryRoot, catalogPath)`;
local source eligibility was only the schema's `^test/fixtures/` string pattern.

- RED (catalog): the lexical/canonical catalog-boundary regression failed 0/1
  because `../outside-catalog.json` was accepted.
- GREEN: the catalog suite passed 3/3 after catalog paths were checked both
  lexically and through `realpath` inside the repository.
- RED (local sources): the fixture-root regression failed 0/1 because
  `test/fixtures/../outside-source` was accepted (and the symlink case would
  likewise have escaped the real fixture root).
- GREEN: the catalog suite passed 4/4. Local source directories and configured
  roots must now be real directories beneath the real `test/fixtures` root;
  lexical traversal and canonical symlink escape both fail closed.

## Finding 7 — destructive output preflight

Root cause: `buildRegistry` passed the requested output directly to
`withAtomicOutput`, so a successful build could rename and replace an input or
production tree.

- RED (repository/source overlap): the sandboxed build test failed 0/1 on the
  repository-root case because no preflight error was returned. No real
  production tree was used by any test.
- GREEN: the same test passed with all sentinels intact for repository root,
  `plugins`, `.agents`, `.claude-plugin`, `.tmp` itself, local source root and
  its relevant ancestors/descendants, and a repository ancestor.
- RED (catalog overlap): the isolated `.tmp/catalog-output` case failed 0/1;
  it replaced the directory containing its own catalog instead of rejecting it.
- GREEN: the integration suite passed 5/5 after lexical and canonical catalog
  overlap joined the preflight input set.
- Additional canonical regression: a nested `.tmp` symlink into `plugins` was
  rejected. Self-review then exposed `.tmp` itself symlinked to `plugins`; its
  focused test failed 0/1 before the canonical Foundation-root identity check
  and the integration suite passed 8/8 afterward.
- Allow cases: a real strict descendant `.tmp/foundation-output` builds, and
  the existing deterministic integration test continues to build into two
  disjoint external temporary roots.

All preflight checks run after read-only catalog validation and before
`withAtomicOutput`; the CLI calls this exact `buildRegistry` path.

## Minor API contract — RegistryResult

- RED: the deterministic integration test threw `TypeError` while reading
  `catalogName` from the previous `undefined` return value.
- GREEN: after successful promotion, `buildRegistry` returns `catalogName`, the
  final `outputRoot`, and for each plugin its name, final `bundleRoot`, and
  neutral manifest. The integration suite passed with that result matched to
  the promoted on-disk manifest. No Plan 2 metadata or cutover behavior was
  introduced.

## Verification

- `npm ci` — GREEN: 36 packages installed from the lockfile. npm repeated the
  existing `@anthropic-ai/claude-code` build-script approval warning.
- `node --test test/unit/skills-discovery.test.mjs test/unit/skills-render.test.mjs test/unit/artifacts.test.mjs test/unit/catalog.test.mjs test/integration/foundation-build.test.mjs`
  — GREEN: 40 passed, 0 failed.
- `npm test` — GREEN: 58 passed, 0 failed.
- `npm run validate` — GREEN: validation passed for all 6 Codex plugins.
- `npm run registry:build:foundation` — GREEN.
- `node scripts/build-registry.mjs --catalog test/fixtures/skill-only-catalog.json --output .tmp/registry-foundation-second`
  — GREEN.
- `diff -ru .tmp/registry-foundation .tmp/registry-foundation-second` — GREEN:
  no differences, proving repeatable foundation output from two independent
  destinations.
- `git diff --exit-code 7c98ac66c8dacedf3940ddc010a5ee3e8c74764f -- .claude-plugin .agents plugins`
  — GREEN: no production-tree changes.
- `git diff --exit-code -- .superpowers/sdd/2026-07-27-agent-neutral-plugin-registry-foundation/progress.md`
  — GREEN: the progress ledger is unchanged.
- `git diff --check` — GREEN.
