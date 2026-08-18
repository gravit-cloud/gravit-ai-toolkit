# Remove OpenClaw Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the plugin registry to Claude Code and Codex while retaining its agent-neutral inventory, immutable provenance, and extensible target-renderer boundary.

**Architecture:** The neutral inventory remains unchanged and feeds exactly two target adapters: Claude and Codex. Every public target allowlist, schema, policy, manifest, lock entry, materializer, receipt, generated bundle, client smoke test, and maintained document enforces that two-target contract; `openclaw` is accepted only as a negative test input that must fail before output creation.

**Tech Stack:** Node.js 24 ESM, Node test runner, AJV JSON Schema 2020-12, npm lockfiles, deterministic registry generation, Git-based immutable provenance.

## Global Constraints

- Supported runtime targets are exactly `claude` and `codex`.
- The neutral component inventory remains authoritative and target-independent.
- Do not preserve OpenClaw as a hidden, experimental, or Codex-format alias.
- Existing historical archives and materialized outputs are never deleted or mutated.
- All generated paths under `plugins/`, `.claude-plugin/`, `.agents/`, and `registry/lock.json` must be produced by `npm run plugins:sync`, never edited by hand.
- Unknown targets, including `openclaw`, must fail before output creation.
- Every changed bundle receives a strictly newer SemVer distribution version.
- Azure must use source `microsoft/azure-skills`, ref `v1.2.8`, SHA `1d88f75412afd408bc1d063a3acbe214d0d9fa0c`, and distribution version `1.2.9-gravit.2`.
- Preserve the nested-skill invariant: generated targets contain only canonical top-level `SKILL.md` entrypoints; internal phase documents remain `SKILL.resource.md`.
- Run commands with Node 24 and install dependencies with lifecycle scripts disabled.
- Do not push automatically.

## File Structure

### Delete

- `scripts/lib/targets/openclaw.mjs` — obsolete target adapter.
- `test/integration/openclaw-target.test.mjs` — positive support contract for the removed adapter.

### Modify: target contract

- `scripts/lib/policy.mjs` — Claude/Codex capability matrix only.
- `scripts/lib/provenance.mjs` — accepted target names in accounting and locks.
- `scripts/lib/materialize.mjs` — accepted materialization targets and receipt validation.
- `scripts/lib/registry-reader.mjs` — materialization-source target boundary.
- `scripts/registry.mjs` — CLI target parser.
- `scripts/lib/validator.mjs` — two-target repository validation.
- `registry/schemas/catalog.schema.json` — target and policy allowlists; remove `adapterOptions`.
- `registry/schemas/agent-plugin.schema.json` — two target manifests and component dispositions.
- `registry/schemas/lock.schema.json` — two target digests and dispositions.
- `registry/schemas/receipt.schema.json` — `claude`, `codex`, and release-only `universal` receipts.

### Modify: rendering and clients

- `scripts/lib/bundle-builder.mjs` — two renderers with no special relocation exception.
- `scripts/lib/targets/codex.mjs` — Codex-only rendering; remove OpenClaw relocation and target parameter.
- `scripts/smoke-clients.mjs` — Claude and Codex client smoke checks only.
- `package.json`, `package-lock.json` — remove the OpenClaw client dependency.
- `.github/workflows/validate.yml` — verify retained client smoke coverage for the two supported clients.

### Modify: tests

- `test/unit/policy.test.mjs`
- `test/unit/catalog.test.mjs`
- `test/unit/provenance.test.mjs`
- `test/unit/materialize.test.mjs`
- `test/unit/registry-reader.test.mjs`
- `test/unit/registry-schemas.test.mjs`
- `test/unit/validator.test.mjs`
- `test/unit/smoke-clients.test.mjs`
- `test/integration/resource-targets.test.mjs`
- `test/integration/azure-regression.test.mjs`
- `test/integration/production-catalog.test.mjs`
- `test/integration/release-archives.test.mjs`

Tests in `test/unit/hooks.test.mjs` and `test/unit/mcp.test.mjs` may retain `openclaw` solely as an unsupported-target input.

### Modify: catalog and generated outputs

- `registry/catalog.json` — two targets, no OpenClaw policy/options, updated versions and Azure pin.
- `registry/lock.json` — generated two-target provenance.
- `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` — generated marketplace records.
- `plugins/*` — generated neutral bundles with `targets/claude` and `targets/codex` only.

### Modify: maintained documentation

- `AGENTS.md` — two-target materialization and release guidance.
- `README.md` — remove OpenClaw usage and compatibility claims.
- `docs/superpowers/specs/2026-07-27-agent-neutral-plugin-registry-design.md` — mark as superseded for target scope.
- `docs/superpowers/specs/2026-08-18-claude-codex-registry-scope-design.md` — authoritative scope decision; no behavioral rewrite required.

---

### Task 0: Rebase onto the Production Hotfix

**Files:**
- No intended content changes; this establishes the execution baseline.

**Interfaces:**
- Consumes: branch `fix/codex-internal-skill-resources` at commit `96503a8e597dce295ba7ef2d53f7949322e61088`.
- Produces: `feat/agent-neutral-plugin-registry` with the production hotfix as an ancestor and a clean working tree.

- [ ] **Step 1: Verify the worktree is clean and record the current head**

```bash
git status --short
git rev-parse HEAD
git rev-parse fix/codex-internal-skill-resources
```

Expected: empty status; feature head includes this plan; hotfix resolves to `96503a8e597dce295ba7ef2d53f7949322e61088`.

- [ ] **Step 2: Rebase the feature branch onto the hotfix**

```bash
git rebase fix/codex-internal-skill-resources
```

Expected: rebase completes. If Git reports a conflict, stop without choosing one side wholesale; preserve the neutral-registry implementation and the production hotfix's Azure v1.2.8 source identity plus nested-skill behavior.

- [ ] **Step 3: Verify ancestry and nested-skill behavior**

```bash
git merge-base --is-ancestor fix/codex-internal-skill-resources HEAD
node --test test/unit/skills-render.test.mjs test/integration/azure-regression.test.mjs
find plugins -path '*/skills/*/*/SKILL.md' -print
```

Expected: ancestry command exits 0; tests pass; `find` prints nothing.

---

### Task 1: Enforce the Two-Target Contract

**Files:**
- Modify: `test/unit/policy.test.mjs`
- Modify: `test/unit/catalog.test.mjs`
- Modify: `test/unit/provenance.test.mjs`
- Modify: `test/unit/materialize.test.mjs`
- Modify: `test/unit/registry-reader.test.mjs`
- Modify: `test/unit/registry-schemas.test.mjs`
- Modify: `scripts/lib/policy.mjs`
- Modify: `scripts/lib/provenance.mjs`
- Modify: `scripts/lib/materialize.mjs`
- Modify: `scripts/lib/registry-reader.mjs`
- Modify: `scripts/registry.mjs`
- Modify: `registry/schemas/catalog.schema.json`
- Modify: `registry/schemas/agent-plugin.schema.json`
- Modify: `registry/schemas/lock.schema.json`
- Modify: `registry/schemas/receipt.schema.json`

**Interfaces:**
- Consumes: existing `targetDisposition(input)`, `materialize(request)`, `openRegistry(root)`, `runRegistryCommand(input)`, and AJV schemas.
- Produces: one target set `{ "claude", "codex" }` at every runtime boundary; receipt target set `{ "claude", "codex", "universal" }`.

- [ ] **Step 1: Write failing policy and provenance tests for OpenClaw rejection**

Remove `openclaw` from `EXPECTED_SUPPORT` in `test/unit/policy.test.mjs` and add this assertion to the unknown-target test:

```js
assert.throws(
  () => targetDisposition({
    component: component("skill"),
    target: "openclaw",
    targetPolicies: {},
  }),
  /unknown target: openclaw/,
);
```

In `test/unit/provenance.test.mjs`, extend the invalid-target accounting test:

```js
assert.throws(
  () => accountComponents({ ...base, targets: ["openclaw"] }),
  /unknown target: openclaw/,
);
```

- [ ] **Step 2: Write failing schema tests**

In `test/unit/catalog.test.mjs`, add a strict legacy-target test:

```js
test("rejects removed OpenClaw target declarations", () => {
  for (const mutate of [
    (plugin) => { plugin.targets = ["openclaw"]; },
    (plugin) => {
      plugin.targetPolicies = { openclaw: { unsupported: {} } };
    },
    (plugin) => {
      plugin.adapterOptions = { openclaw: { bundleFormat: "codex" } };
    },
  ]) {
    const catalog = fixtureCatalog();
    mutate(catalog.plugins[0]);
    assert.throws(() => validateCatalog(catalog), /invalid registry catalog/);
  }
});
```

Compile the receipt schema in `validators()`:

```js
receipt: ajv.compile(schema("receipt.schema.json")),
```

Add cases that clone a valid two-target object and insert an OpenClaw field:

```js
const { agentPlugin, lock, receipt } = validators();

const manifest = agentManifest();
manifest.targets.openclaw = structuredClone(manifest.targets.codex);
manifest.components[0].targets.openclaw = disposition("transformed");
assert.equal(agentPlugin(manifest), false);

const locked = lockFile();
locked.plugins.fixture.targets.openclaw = DIGEST;
locked.plugins.fixture.components[0].targets.openclaw = disposition("transformed");
assert.equal(lock(locked), false);

assert.equal(receipt({
  schemaVersion: 1,
  registry: "gravit-cloud",
  registryRevision: "a".repeat(40),
  plugin: "fixture",
  target: "openclaw",
  distributionVersion: "1.0.0-gravit.1",
  sourceBundleDigest: DIGEST,
  sourceTargetDigest: DIGEST,
  materializedDigest: DIGEST,
}), false);
```

- [ ] **Step 3: Write failing materializer and CLI no-output tests**

Add `openclaw` to the invalid CLI cases in `test/unit/materialize.test.mjs`:

```js
["materialize", "--plugin", "azure", "--target", "openclaw", "--output", output],
```

Add a direct boundary assertion before a reader or output is required:

```js
assert.throws(
  () => materialize({ target: "openclaw", outputPath: output }),
  /unsupported materialization target: openclaw/,
);
assert.equal(existsSync(output), false);
```

Change registry-reader fixtures and list expectations to `targets: ["claude", "codex"]`, then add:

```js
assert.throws(
  () => registryReader.materializationSource(reader, "nested-skills", "openclaw"),
  /unsupported materialization target: openclaw/,
);
```

- [ ] **Step 4: Run the new tests and verify they fail for the intended reason**

```bash
node --test test/unit/policy.test.mjs test/unit/catalog.test.mjs test/unit/provenance.test.mjs test/unit/materialize.test.mjs test/unit/registry-reader.test.mjs test/unit/registry-schemas.test.mjs
```

Expected: failures show OpenClaw is still accepted by one or more runtime/schema boundaries; no test fails due to syntax or missing fixtures.

- [ ] **Step 5: Remove OpenClaw from runtime target sets and capability policy**

Use exactly this target set in `scripts/lib/materialize.mjs`, `scripts/lib/registry-reader.mjs`, `scripts/registry.mjs`, and `scripts/lib/provenance.mjs`:

```js
const TARGETS = new Set(["claude", "codex"]);
```

Retain the existing local constant names where public code already uses `MATERIALIZATION_TARGETS` or `TARGET_NAMES`; change only their values. Remove the `openclaw` member from `SUPPORT` in `scripts/lib/policy.mjs` so `TARGETS` continues to derive from `Object.keys(SUPPORT)`.

- [ ] **Step 6: Remove OpenClaw from the four JSON schemas**

Apply these exact schema rules:

```json
"items": { "enum": ["claude", "codex"] }
```

Remove every `openclaw` property from target-policy, target-manifest, disposition, and digest maps. Remove the entire optional `adapterOptions` property from `catalog.schema.json`; `additionalProperties: false` then rejects legacy adapter declarations. Change the receipt target enum to:

```json
"target": { "enum": ["claude", "codex", "universal"] }
```

- [ ] **Step 7: Run the focused target-boundary tests**

```bash
node --test test/unit/policy.test.mjs test/unit/catalog.test.mjs test/unit/provenance.test.mjs test/unit/materialize.test.mjs test/unit/registry-reader.test.mjs test/unit/registry-schemas.test.mjs
```

Expected: all focused tests pass. Repository-wide validation may still fail because the production catalog and generated bundles are migrated in Task 3.

- [ ] **Step 8: Commit the two-target contract**

```bash
git add scripts/lib/policy.mjs scripts/lib/provenance.mjs scripts/lib/materialize.mjs scripts/lib/registry-reader.mjs scripts/registry.mjs registry/schemas test/unit/policy.test.mjs test/unit/catalog.test.mjs test/unit/provenance.test.mjs test/unit/materialize.test.mjs test/unit/registry-reader.test.mjs test/unit/registry-schemas.test.mjs
git commit -m "refactor(registry): restrict supported targets"
```

---

### Task 2: Remove the OpenClaw Adapter and Client Integration

**Files:**
- Delete: `scripts/lib/targets/openclaw.mjs`
- Delete: `test/integration/openclaw-target.test.mjs`
- Modify: `scripts/lib/bundle-builder.mjs`
- Modify: `scripts/lib/targets/codex.mjs`
- Modify: `scripts/lib/validator.mjs`
- Modify: `scripts/smoke-clients.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/unit/validator.test.mjs`
- Modify: `test/unit/smoke-clients.test.mjs`
- Modify: `test/integration/resource-targets.test.mjs`
- Modify: `test/integration/azure-regression.test.mjs`
- Modify: `test/integration/release-archives.test.mjs`

**Interfaces:**
- Consumes: two-target policy and schemas from Task 1.
- Produces: `renderClaudeTarget(input)` and `renderCodexTarget(input)` as the complete renderer dispatch; supported-client smoke command list containing Claude and Codex commands only.

- [ ] **Step 1: Convert positive OpenClaw tests into two-target and rejection coverage**

Make these test changes before implementation:

- Delete the positive `openclaw-target.test.mjs` contract.
- Remove the Azure OpenClaw projection test and keep the existing Claude/Codex nested-skill checks.
- Change release-archive fixture targets and expected paths from three targets to `claude` and `codex` only.
- Change validator fixtures to two targets and delete assertions for OpenClaw host-manifest shape and relocated resources.
- Remove OpenClaw-only resource relocation tests. Keep generic reserved-namespace and collision tests, changing their fixture target to `codex` where the property is not OpenClaw-specific.
- Change smoke-client expected command names so no name begins with `openclaw-`.

Add this renderer-dispatch assertion to the existing foundation or component-target integration test:

```js
assert.deepEqual(
  readdirSync(resolve(bundleRoot, "targets"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(),
  ["claude", "codex"],
);
```

- [ ] **Step 2: Run focused rendering and smoke tests and confirm failure**

```bash
node --test test/unit/validator.test.mjs test/unit/smoke-clients.test.mjs test/integration/resource-targets.test.mjs test/integration/azure-regression.test.mjs test/integration/release-archives.test.mjs test/integration/foundation-build.test.mjs
```

Expected: failures show the renderer, validator, smoke harness, or fixtures still emit/reference OpenClaw; no syntax-only failure.

- [ ] **Step 3: Simplify the renderer dispatch**

In `scripts/lib/bundle-builder.mjs`, use:

```js
import { renderClaudeTarget } from "./targets/claude.mjs";
import { renderCodexTarget } from "./targets/codex.mjs";

const TARGET_RENDERERS = {
  claude: renderClaudeTarget,
  codex: renderCodexTarget,
};
```

Remove the `openClawRelocation` exception from `assertAdapterResult`; actual dispositions must match neutral accounting for both supported targets.

- [ ] **Step 4: Make the Codex renderer Codex-only**

Delete `preserveOpenClawSharedLayout`. Remove the `target` parameter from `nativeDestination`; path resources keep their safe declared relative path for Codex. Replace the current generic entrypoint signature and target-root setup:

```js
export function renderCodexFormatTarget({
  plugin,
  inventory,
  neutralComponents,
  bundleRoot,
  target = "codex",
}) {
  const targetRoot = resolve(bundleRoot, "targets", target);
```

with:

```js
export function renderCodexTarget({
  plugin,
  inventory,
  neutralComponents,
  bundleRoot,
}) {
  const target = "codex";
  const targetRoot = resolve(bundleRoot, "targets/codex");
```

Preserve the existing rendering statements after `targetRoot` without changing their order. Remove the old bottom-level wrapper `renderCodexTarget(input)` and all `target === "openclaw"` branches and relocation-status overrides. Keep target-specific hooks, MCP, apps, skills, commands, executables, and assets unchanged for Codex.

- [ ] **Step 5: Remove OpenClaw validator branches**

Set the validator target allowlist to:

```js
const TARGETS = new Set(["claude", "codex"]);
```

Remove the `openclaw` entry from target-manifest rules, the OpenClaw forbidden-path checks, and the OpenClaw-specific branch in target validation. Preserve Claude and Codex validation exactly.

- [ ] **Step 6: Remove OpenClaw from the client smoke harness**

Delete OpenClaw JSON validators, expected state, environment variables, executable resolution, and command records from `scripts/smoke-clients.mjs`. The command sequence must still run the existing Claude marketplace/plugin checks and Codex marketplace/plugin checks with isolated retained homes.

Update `test/unit/smoke-clients.test.mjs` so its fixture creates only Claude and Codex client entrypoints and its expected command list has no `openclaw-*` records.

- [ ] **Step 7: Remove the npm dependency deterministically**

Edit `package.json` to remove only:

```json
"openclaw": "2026.7.1-2"
```

Then regenerate the lockfile without lifecycle scripts:

```bash
npm install --package-lock-only --ignore-scripts
```

Verify the dependency is gone:

```bash
npm ls openclaw --depth=0
```

Expected: npm reports no top-level OpenClaw dependency.

- [ ] **Step 8: Delete the obsolete adapter and rerun focused tests**

Delete `scripts/lib/targets/openclaw.mjs` and `test/integration/openclaw-target.test.mjs`, then run:

```bash
node --test test/unit/validator.test.mjs test/unit/smoke-clients.test.mjs test/integration/resource-targets.test.mjs test/integration/azure-regression.test.mjs test/integration/release-archives.test.mjs test/integration/foundation-build.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 9: Commit adapter and client removal**

```bash
git add -A scripts/lib/targets scripts/lib/bundle-builder.mjs scripts/lib/validator.mjs scripts/smoke-clients.mjs package.json package-lock.json test
git commit -m "refactor(registry): remove OpenClaw adapter"
```

---

### Task 3: Migrate the Production Catalog and Generated Registry

**Files:**
- Modify: `test/integration/production-catalog.test.mjs`
- Modify: `registry/catalog.json`
- Generate: `registry/lock.json`
- Generate: `.claude-plugin/marketplace.json`
- Generate: `.agents/plugins/marketplace.json`
- Generate: `plugins/*`

**Interfaces:**
- Consumes: two target adapters and schemas from Tasks 1–2; immutable upstream pins.
- Produces: six deterministic universal bundles containing neutral components plus only `targets/claude` and `targets/codex`.

- [ ] **Step 1: Write the failing production catalog contract**

Change `test/integration/production-catalog.test.mjs` to assert these exact versions in catalog order:

```js
[
  "2.2.4-gravit.5",
  "1.0.1-gravit.3",
  "1.1.0-gravit.3",
  "1.2.9-gravit.2",
  "6.2.0-gravit.3",
  "1.0.0-gravit.4",
]
```

For every plugin assert:

```js
assert.deepEqual(plugin.targets, ["claude", "codex"], plugin.name);
assert.equal(Object.hasOwn(plugin, "adapterOptions"), false, plugin.name);
assert.equal(Object.hasOwn(plugin.targetPolicies || {}, "openclaw"), false, plugin.name);
```

Assert Azure's source record is:

```js
{
  type: "github",
  repo: "microsoft/azure-skills",
  ref: "v1.2.8",
  sha: "1d88f75412afd408bc1d063a3acbe214d0d9fa0c",
  root: ".",
}
```

Replace the positive OpenClaw resource-layout test with a generated-target contract:

```js
for (const name of expectedPluginNames) {
  const targets = readdirSync(resolve(repositoryRoot, "plugins", name, "targets"), {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(targets, ["claude", "codex"], name);
}
```

- [ ] **Step 2: Run the production test and verify it fails**

```bash
node --test test/integration/production-catalog.test.mjs
```

Expected: failures show old versions, the old Azure source, OpenClaw catalog records, or generated OpenClaw targets.

- [ ] **Step 3: Update the maintained catalog only**

In `registry/catalog.json`:

- Set every `targets` array to `["claude", "codex"]`.
- Remove every `targetPolicies.openclaw` record.
- Remove every `adapterOptions` record.
- Apply the six exact distribution versions from Step 1.
- Set Azure to the exact v1.2.8 source identity from Step 1.
- Preserve all Claude and Codex policies, resource declarations, source-context records, and runtime dependency pins.

- [ ] **Step 4: Regenerate all managed outputs**

```bash
npm run plugins:sync
```

Expected: all six bundles regenerate; `targets/openclaw` directories disappear; marketplaces and `registry/lock.json` update atomically.

- [ ] **Step 5: Verify generated target and version identities**

```bash
find plugins -type d -path '*/targets/openclaw' -print
jq -r '.plugins[] | [.name, .distributionVersion, (.targets | join(","))] | @tsv' registry/catalog.json
jq -r '.plugins | to_entries[] | [.key, .value.distributionVersion, (.value.targets | keys | join(","))] | @tsv' registry/lock.json
find plugins -path '*/skills/*/*/SKILL.md' -print
```

Expected: both `find` commands print nothing; every catalog and lock target list is `claude,codex`; versions match Step 1.

- [ ] **Step 6: Prove sync determinism**

Record a diff hash, synchronize again, and compare:

```bash
git diff --binary | shasum -a 256
npm run plugins:sync
git diff --binary | shasum -a 256
```

Expected: the two SHA-256 values are identical.

- [ ] **Step 7: Run production and repository validation**

```bash
node --test test/integration/production-catalog.test.mjs test/integration/azure-regression.test.mjs
npm run validate
npm run registry:verify
```

Expected: all commands pass; Azure has 34 canonical skills in Claude and Codex and no nested `SKILL.md`.

- [ ] **Step 8: Commit catalog and generated outputs together**

```bash
git add registry .claude-plugin .agents plugins test/integration/production-catalog.test.mjs
git commit -m "feat(registry): publish Claude and Codex bundles"
```

---

### Task 4: Update Maintained Documentation and Release Gates

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-27-agent-neutral-plugin-registry-design.md`
- Verify: `.github/workflows/validate.yml`

**Interfaces:**
- Consumes: committed two-target registry from Task 3.
- Produces: current maintainer and consumer documentation that promises only Claude and Codex; verified release archives for all six plugins.

- [ ] **Step 1: Update current documentation**

In `README.md` and `AGENTS.md`:

- Describe universal bundles as neutral components plus `targets/claude` and `targets/codex`.
- Delete OpenClaw installation, disabling, listing, inspection, compatibility, and materialization examples.
- State that materialization supports exactly `claude` and `codex`; `universal` remains release-receipt-only.
- Preserve the write-once, no-delete, exact-revision, shared-volume, and security guidance.

At the top of `docs/superpowers/specs/2026-07-27-agent-neutral-plugin-registry-design.md`, add:

```markdown
> [!note] Target scope superseded
> The neutral registry foundation remains valid, but its OpenClaw target scope is superseded by [Claude and Codex Registry Scope](./2026-08-18-claude-codex-registry-scope-design.md).
```

- [ ] **Step 2: Audit remaining OpenClaw references**

```bash
rg -n -i 'openclaw' AGENTS.md README.md package.json registry scripts .github plugins test \
  --glob '!test/integration/production-catalog.test.mjs' \
  --glob '!test/unit/hooks.test.mjs' \
  --glob '!test/unit/mcp.test.mjs' \
  --glob '!test/unit/policy.test.mjs' \
  --glob '!test/unit/catalog.test.mjs' \
  --glob '!test/unit/provenance.test.mjs' \
  --glob '!test/unit/materialize.test.mjs' \
  --glob '!test/unit/registry-reader.test.mjs' \
  --glob '!test/unit/registry-schemas.test.mjs'
```

Expected: no output. The excluded files may mention `openclaw` only in assertions that it is rejected as unsupported or absent.

- [ ] **Step 3: Run the complete test and validation suite**

```bash
npm test
npm run validate
npm run registry:verify
```

Expected: all tests and validation commands pass.

- [ ] **Step 4: Build releases into a fresh canonical write-once directory**

```bash
registry_release_dir=$(mktemp -d /private/tmp/gravit-claude-codex-release.XXXXXX)
DIST_DIR="$registry_release_dir" npm run build
test "$(find "$registry_release_dir" -maxdepth 1 -name '*.zip' | wc -l | tr -d ' ')" = 6
for archive in "$registry_release_dir"/*.zip; do
  /usr/bin/unzip -Z1 "$archive" | rg '/targets/claude/' >/dev/null
  /usr/bin/unzip -Z1 "$archive" | rg '/targets/codex/' >/dev/null
  if /usr/bin/unzip -Z1 "$archive" | rg -q '/targets/openclaw/'; then
    printf 'unexpected OpenClaw target: %s\n' "$archive" >&2
    exit 1
  fi
done
```

Expected: exactly six versioned ZIP paths are printed, using the distribution versions from Task 3; every archive contains Claude and Codex targets and no OpenClaw target.

- [ ] **Step 5: Verify the final committed-state prerequisites**

```bash
git diff --check
git status --short
find plugins -type d -path '*/targets/openclaw' -print
find plugins -path '*/skills/*/*/SKILL.md' -print
```

Expected: no whitespace errors; only intended documentation changes remain before the final commit; both `find` commands print nothing.

- [ ] **Step 6: Commit documentation**

```bash
git add AGENTS.md README.md docs/superpowers/specs/2026-07-27-agent-neutral-plugin-registry-design.md
git commit -m "docs(registry): document supported clients"
```

- [ ] **Step 7: Re-run post-commit release verification**

Because release claims require committed registry inputs, create another fresh canonical `DIST_DIR` and rerun:

```bash
npm test
npm run validate
npm run registry:verify
registry_postcommit_release_dir=$(mktemp -d /private/tmp/gravit-claude-codex-postcommit.XXXXXX)
DIST_DIR="$registry_postcommit_release_dir" npm run build
test "$(find "$registry_postcommit_release_dir" -maxdepth 1 -name '*.zip' | wc -l | tr -d ' ')" = 6
git status --short
```

Expected: all commands pass, six archives are created in the second fresh directory, and `git status --short` is empty.
