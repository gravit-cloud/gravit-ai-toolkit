# Plugin Distribution, OpenClaw, and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make committed registry bundles safely consumable by local development, OpenClaw, CI pipelines, and cloud images through verified materialization, receipts, compatibility projections, release archives, and client smoke tests.

**Architecture:** Add a registry-reading CLI that verifies lock hashes before inspection or materialization and owns only directories carrying a matching receipt. Generate one slim Codex-format OpenClaw compatibility bundle per plugin, then test Claude, Codex, and OpenClaw in isolated state directories while keeping network-dependent smoke checks separate from offline validation.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, Claude Code 2.1.220, `@openai/codex` 0.145.0, OpenClaw 2026.7.1-2, GitHub Actions, Renovate.

## Global Constraints

- Plans 1 and 2 completion gates must pass before starting this plan.
- The consumer CLI reads committed registry state and never downloads upstream plugin sources.
- `list`, `inspect`, and `verify` do not mutate registry or consumer files.
- `materialize` writes only to an explicit path and refuses unowned existing content.
- Every materialized directory contains `.gravit-plugin-receipt.json` with plugin, target, distribution version, registry revision, and bundle digest.
- A receipt permits replacement only when its plugin, target, and registry name match the requested operation.
- Materialization verifies source bundle and copied output hashes before promotion.
- OpenClaw output uses one Codex-compatible bundle marker and never emits `openclaw.plugin.json`.
- OpenClaw hook JSON, agents, app bindings, styles, and other detect-only components are marked unsupported unless a tested mapping exists.
- OpenClaw-compatible MCP commands retain exact runtime pins; no smoke test prints or requires cloud credentials.
- Offline tests and `npm run validate` never invoke Claude, Codex, OpenClaw, npm registry, GitHub, or Azure.
- Client smoke tests use isolated task-specific state directories and exact tool versions.
- Release archives contain committed bundle files plus receipt metadata, never source staging directories or secrets.
- Renovate edits `registry/catalog.json`, bumps the Gravit distribution revision, syncs, and includes catalog, lock, marketplaces, and bundles in one PR.
- Pull-request validation never pushes, publishes, enables hooks, or starts MCP servers.

---

## File Structure

- Create `scripts/lib/targets/openclaw.mjs`: Codex-format compatibility projection and support accounting.
- Modify `scripts/lib/policy.mjs` and `scripts/lib/bundle-builder.mjs`: OpenClaw target support.
- Modify `registry/schemas/catalog.schema.json` and `registry/catalog.json`: OpenClaw target and bundle-format options.
- Create `scripts/lib/registry-reader.mjs`: load and verify committed catalog, lock, and bundles.
- Create `scripts/lib/materialize.mjs`: safe copy, receipt validation, and atomic consumer replacement.
- Create `scripts/registry.mjs`: list, inspect, verify, and materialize CLI.
- Create `registry/schemas/receipt.schema.json`: receipt contract.
- Create `scripts/smoke-clients.mjs`: isolated host CLI smoke orchestration.
- Create `scripts/bump-plugin-revisions.mjs`: deterministic `-gravit.N` bump after source changes.
- Modify `scripts/renovate-plugin-sync.sh` and `renovate.json`: neutral-catalog update workflow.
- Modify `.github/workflows/validate.yml`: offline checks, base-lock collision check, and separate client smoke job.
- Modify `.github/workflows/release.yml` and `build.sh`: universal bundle archives.
- Modify `README.md` and `AGENTS.md`: consumer and maintainer runbooks.

### Task 1: Generate truthful OpenClaw compatibility projections

**Files:**

- Create: `scripts/lib/targets/openclaw.mjs`
- Modify: `scripts/lib/policy.mjs`
- Modify: `scripts/lib/bundle-builder.mjs`
- Modify: `registry/schemas/catalog.schema.json`
- Modify: `registry/schemas/agent-plugin.schema.json`
- Modify: `registry/catalog.json`
- Create: `test/integration/openclaw-target.test.mjs`

**Interfaces:**

- Produces: `renderOpenClawTarget({ plugin, inventory, bundleRoot }): TargetResult`
- Output root: `targets/openclaw/`
- Marker: `targets/openclaw/.codex-plugin/plugin.json`
- Supported: skills, command-to-skill, stdio/HTTP MCP, executables, and inert assets.
- Unsupported in the first adapter: agents, Claude hook JSON, LSP, app bindings beyond diagnostics, output styles, monitors, themes, channels, and settings.

- [ ] **Step 1: Extend catalog target and adapter options**

Allow `openclaw` in `targets` and add:

~~~json
{
  "adapterOptions": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "openclaw": {
        "type": "object",
        "additionalProperties": false,
        "required": ["bundleFormat"],
        "properties": {
          "bundleFormat": { "const": "codex" }
        }
      }
    }
  }
}
~~~

Add `openclaw` and `adapterOptions.openclaw.bundleFormat: "codex"` to all six production entries. Add these reason codes only for types present in that plugin:

~~~json
{
  "openclaw": {
    "unsupported": {
      "agent": "openclaw-detects-agents-only",
      "hook": "openclaw-does-not-run-claude-hook-json",
      "lsp": "codex-bundle-format-does-not-load-lsp",
      "app": "openclaw-reports-app-bindings-only",
      "output-style": "openclaw-reports-output-styles-only",
      "monitor": "openclaw-does-not-run-monitors",
      "theme": "openclaw-does-not-load-themes",
      "channel": "openclaw-does-not-load-channels",
      "settings": "codex-bundle-format-does-not-load-settings"
    }
  }
}
~~~

- [ ] **Step 2: Write the failing OpenClaw target test**

Move the complete fixture constants from Plan 2 into `test/helpers/complete-fixture.mjs`, then write:

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPluginBundle } from "../../scripts/lib/bundle-builder.mjs";
import {
  completeFixturePlugin,
  completeFixtureRoot,
} from "../helpers/complete-fixture.mjs";

test("renders one Codex-format OpenClaw bundle with honest statuses", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-openclaw-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = completeFixturePlugin({
    targets: ["openclaw"],
    adapterOptions: { openclaw: { bundleFormat: "codex" } },
    targetPolicies: {
      openclaw: {
        unsupported: {
          agent: "openclaw-detects-agents-only",
          hook: "openclaw-does-not-run-claude-hook-json",
          lsp: "codex-bundle-format-does-not-load-lsp",
          app: "openclaw-reports-app-bindings-only",
          "output-style": "openclaw-reports-output-styles-only",
          monitor: "openclaw-does-not-run-monitors",
          theme: "openclaw-does-not-load-themes",
          channel: "openclaw-does-not-load-channels",
          settings: "codex-bundle-format-does-not-load-settings"
        }
      }
    }
  });
  const manifest = buildPluginBundle({
    plugin,
    sourceRoot: completeFixtureRoot,
    bundleRoot: resolve(root, "complete"),
  });
  const target = resolve(root, "complete/targets/openclaw");
  assert.equal(existsSync(resolve(target, ".codex-plugin/plugin.json")), true);
  assert.equal(existsSync(resolve(target, "openclaw.plugin.json")), false);
  assert.equal(existsSync(resolve(target, ".mcp.json")), true);
  assert.equal(existsSync(resolve(target, "assets/icon.svg")), true);
  assert.equal(existsSync(resolve(target, "skills/release/SKILL.md")), true);
  assert.equal(
    manifest.components.find(({ type }) => type === "agent")
      .targets.openclaw.status,
    "unsupported",
  );
});
~~~

- [ ] **Step 3: Run and verify the missing adapter**

Run: `node --test test/integration/openclaw-target.test.mjs`

Expected: FAIL because `renderOpenClawTarget` is missing.

- [ ] **Step 4: Extend the support matrix**

~~~js
openclaw: {
  skill: ["transformed", "skill"],
  command: ["transformed", "skill"],
  mcp: ["transformed", "mcp"],
  executable: ["preserved", "executable"],
  asset: ["preserved", "asset"],
  agent: undefined,
  hook: undefined,
  lsp: undefined,
  app: undefined,
  "output-style": undefined,
  monitor: undefined,
  theme: undefined,
  channel: undefined,
  settings: undefined,
},
~~~

Reuse `targetDisposition` so every unsupported record requires its catalog reason.

- [ ] **Step 5: Implement the OpenClaw adapter**

~~~js
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { treeHash } from "../hash.mjs";
import { removeUndefined, writeJson } from "../json.mjs";
import { normalizeMcp, writeMcpConfig } from "../mcp.mjs";
import { targetDisposition } from "../policy.mjs";
import { commandToSkill } from "../component-files.mjs";
import { renderSkills } from "../skills.mjs";

export function renderOpenClawTarget({ plugin, inventory, bundleRoot }) {
  if (plugin.adapterOptions?.openclaw?.bundleFormat !== "codex") {
    throw new Error(plugin.name + ": OpenClaw bundleFormat must be codex");
  }
  const targetRoot = resolve(bundleRoot, "targets/openclaw");
  mkdirSync(targetRoot, { recursive: true });
  renderSkills({
    skills: inventory.skills,
    destinationRoot: resolve(targetRoot, "skills"),
    target: "codex",
  });

  const components = Object.fromEntries(inventory.skills.map((skill) => [
    skill.name,
    { status: "transformed", reasonCode: "target-translation", renderAs: "skill" },
  ]));
  const mcpServers = [];
  for (const component of inventory.components) {
    const disposition = targetDisposition({
      component,
      target: "openclaw",
      targetPolicies: plugin.targetPolicies || {},
    });
    components[component.id] = disposition;
    if (component.type === "mcp" && disposition.status !== "unsupported") {
      mcpServers.push(...normalizeMcp({
        record: component,
        runtimePins: plugin.runtimeDependencies || {},
      }));
    }
    if (component.type === "command" && disposition.status !== "unsupported") {
      commandToSkill({
        component,
        destinationRoot: resolve(targetRoot, "skills"),
      });
    }
    if (component.type === "executable" && disposition.status !== "unsupported") {
      cpSync(component.sourcePath, resolve(targetRoot, "bin"), {
        recursive: true,
        preserveTimestamps: false,
      });
    }
    if (component.type === "asset" && disposition.status !== "unsupported") {
      cpSync(component.sourcePath, resolve(targetRoot, "assets"), {
        recursive: true,
        preserveTimestamps: false,
      });
    }
  }
  if (mcpServers.length) {
    writeMcpConfig({
      servers: mcpServers,
      target: "codex",
      filePath: resolve(targetRoot, ".mcp.json"),
    });
  }
  writeJson(resolve(targetRoot, ".codex-plugin/plugin.json"), removeUndefined({
    name: plugin.name,
    version: plugin.distributionVersion,
    description: plugin.description,
    author: { name: plugin.author || "Gravit Cloud" },
    skills: "./skills/",
    mcpServers: mcpServers.length ? "./.mcp.json" : undefined,
    interface: {
      displayName: plugin.displayName || plugin.name,
      shortDescription: plugin.description.slice(0, 110),
      longDescription: plugin.description,
      developerName: plugin.author || "Gravit Cloud",
      category: "Productivity",
      capabilities: [],
      defaultPrompt: [
        "Use " + (plugin.displayName || plugin.name) + " to help with this task.",
      ],
    },
  }));
  return { digest: treeHash(targetRoot), components };
}
~~~

Move the recursive `removeUndefined` helper from the target adapter into `scripts/lib/json.mjs` and reuse it for all target manifests.

- [ ] **Step 6: Wire, test, sync, and commit**

Call `renderOpenClawTarget` when configured and include its digest and dispositions in neutral manifest and lock.

Run:

~~~bash
npm test
npm run plugins:sync
npm run validate
~~~

Expected: all production bundles contain `targets/openclaw/.codex-plugin/plugin.json`; none contains `openclaw.plugin.json`.

~~~bash
git add registry scripts/lib test/helpers test/integration plugins .claude-plugin .agents
git commit -m "feat(openclaw): generate compatibility bundles"
~~~

### Task 2: Read and verify committed registry bundles

**Files:**

- Create: `scripts/lib/registry-reader.mjs`
- Create: `scripts/registry.mjs`
- Create: `test/unit/registry-reader.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces: `openRegistry(repositoryRoot): RegistryReader`
- `RegistryReader.list(): PluginSummary[]`
- `RegistryReader.inspect(name): PluginDetails`
- `RegistryReader.verify(name?): VerificationResult`

- [ ] **Step 1: Write failing reader tests**

~~~js
test("list returns locked versions and configured targets", () => {
  const reader = openRegistry(fixtureRegistryRoot);
  assert.deepEqual(reader.list(), [{
    name: "nested-skills",
    distributionVersion: "1.0.0-gravit.1",
    targets: ["claude", "codex", "openclaw"],
    bundleDigest: fixtureBundleDigest,
  }]);
});

test("verify reports a mutated bundle file", () => {
  const root = copyFixtureRegistry();
  appendFileSync(
    resolve(root, "plugins/nested-skills/targets/codex/skills/parent/SKILL.md"),
    "\nmutation\n",
  );
  assert.deepEqual(openRegistry(root).verify("nested-skills").errors, [
    "nested-skills: bundle digest mismatch",
  ]);
});
~~~

- [ ] **Step 2: Run and verify the missing module**

Run: `node --test test/unit/registry-reader.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement registry reading**

~~~js
import { resolve } from "node:path";
import { readJson } from "./json.mjs";
import { treeHash } from "./hash.mjs";
import { assertInside } from "./path-safety.mjs";

export function openRegistry(repositoryRoot) {
  const catalog = readJson(resolve(repositoryRoot, "registry/catalog.json"));
  const lock = readJson(resolve(repositoryRoot, "registry/lock.json"));

  function entry(name) {
    const plugin = catalog.plugins.find((candidate) => candidate.name === name);
    const locked = lock.plugins[name];
    if (!plugin || !locked) throw new Error("unknown registry plugin: " + name);
    const bundleRoot = assertInside(
      repositoryRoot,
      resolve(repositoryRoot, "plugins", name),
      "bundle",
    );
    return { plugin, locked, bundleRoot };
  }

  return {
    list() {
      return catalog.plugins.map((plugin) => ({
        name: plugin.name,
        distributionVersion: plugin.distributionVersion,
        targets: [...plugin.targets].sort(),
        bundleDigest: lock.plugins[plugin.name].bundleDigest,
      }));
    },
    inspect(name) {
      const selected = entry(name);
      return {
        ...this.list().find((plugin) => plugin.name === name),
        components: selected.locked.components,
        source: selected.locked.source,
      };
    },
    verify(name) {
      const names = name ? [name] : catalog.plugins.map((plugin) => plugin.name);
      const errors = [];
      for (const pluginName of names) {
        const selected = entry(pluginName);
        if (treeHash(selected.bundleRoot) !== selected.locked.bundleDigest) {
          errors.push(pluginName + ": bundle digest mismatch");
        }
      }
      return { ok: errors.length === 0, errors };
    },
    entry,
  };
}
~~~

- [ ] **Step 4: Implement read-only CLI commands**

~~~js
#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openRegistry } from "./lib/registry-reader.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = openRegistry(repositoryRoot);
const command = process.argv[2];

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (required && !value) throw new Error("missing option " + name);
  return value;
}

if (command === "list") {
  process.stdout.write(JSON.stringify(registry.list(), null, 2) + "\n");
} else if (command === "inspect") {
  process.stdout.write(
    JSON.stringify(registry.inspect(option("--plugin")), null, 2) + "\n",
  );
} else if (command === "verify") {
  const result = registry.verify(option("--plugin", false));
  if (!result.ok) {
    console.error(result.errors.join("\n"));
    process.exit(1);
  }
  process.stdout.write("Registry bundles verified.\n");
} else {
  throw new Error("usage: registry.mjs list|inspect|verify|materialize");
}
~~~

- [ ] **Step 5: Add scripts, run, and commit**

Add:

~~~json
{
  "scripts": {
    "registry": "node scripts/registry.mjs",
    "registry:verify": "node scripts/registry.mjs verify"
  }
}
~~~

Run:

~~~bash
npm test
npm run registry -- list
npm run registry:verify
~~~

Expected: six plugins list and every bundle verifies.

~~~bash
git add scripts/lib/registry-reader.mjs scripts/registry.mjs test/unit/registry-reader.test.mjs package.json
git commit -m "feat(registry): inspect and verify bundles"
~~~

### Task 3: Materialize target bundles with ownership receipts

**Files:**

- Create: `registry/schemas/receipt.schema.json`
- Modify: `scripts/lib/hash.mjs`
- Create: `scripts/lib/materialize.mjs`
- Create: `test/unit/materialize.test.mjs`
- Modify: `scripts/registry.mjs`
- Modify: `scripts/lib/registry-reader.mjs`

**Interfaces:**

- Produces: `materialize({ reader, pluginName, target, outputPath, registryRevision }): Receipt`
- Receipt file: `.gravit-plugin-receipt.json`
- CLI: `node scripts/registry.mjs materialize --plugin azure --target codex --output /tmp/gravit-azure-codex`

- [ ] **Step 1: Define the receipt schema**

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://gravit.cloud/schemas/plugin-receipt-v1.json",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schemaVersion",
    "registry",
    "registryRevision",
    "plugin",
    "target",
    "distributionVersion",
    "sourceBundleDigest",
    "sourceTargetDigest",
    "materializedDigest"
  ],
  "properties": {
    "schemaVersion": { "const": 1 },
    "registry": { "const": "gravit-cloud" },
    "registryRevision": { "type": "string", "pattern": "^[a-f0-9]{40}$" },
    "plugin": { "type": "string" },
    "target": { "enum": ["claude", "codex", "openclaw"] },
    "distributionVersion": { "type": "string" },
    "sourceBundleDigest": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "sourceTargetDigest": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "materializedDigest": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
  }
}
~~~

- [ ] **Step 2: Write failing safety tests**

~~~js
test("refuses an existing directory without a matching receipt", () => {
  const outputPath = resolve(temporaryRoot, "consumer");
  mkdirSync(outputPath);
  writeFileSync(resolve(outputPath, "owned-by-user.txt"), "keep\n");
  assert.throws(() => materialize(request(outputPath)), /refusing to replace unowned output/);
  assert.equal(readFileSync(resolve(outputPath, "owned-by-user.txt"), "utf8"), "keep\n");
});

test("replaces only a matching previously materialized target", () => {
  const outputPath = resolve(temporaryRoot, "consumer");
  const first = materialize(request(outputPath));
  const second = materialize(request(outputPath));
  assert.equal(first.plugin, "nested-skills");
  assert.equal(second.target, "codex");
  assert.equal(existsSync(resolve(outputPath, ".gravit-plugin-receipt.json")), true);
});

test("a failed copy keeps the previous target", () => {
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  assert.throws(() => materialize({
    ...request(outputPath),
    copyDirectory() {
      throw new Error("synthetic copy failure");
    },
  }), /synthetic copy failure/);
  assert.equal(existsSync(resolve(outputPath, ".codex-plugin/plugin.json")), true);
});

test("refuses a target whose committed digest no longer matches the lock", () => {
  const outputPath = resolve(temporaryRoot, "consumer");
  const corruptReader = {
    ...reader,
    entry(name) {
      const selected = reader.entry(name);
      return {
        ...selected,
        locked: {
          ...selected.locked,
          targets: { ...selected.locked.targets, codex: "0".repeat(64) },
        },
      };
    },
  };
  assert.throws(
    () => materialize({ ...request(outputPath), reader: corruptReader }),
    /target digest mismatch/,
  );
  assert.equal(existsSync(outputPath), false);
});

test("refuses to replace a receipt-owned directory after payload tampering", () => {
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  writeFileSync(resolve(outputPath, "tampered.txt"), "changed\n");
  assert.throws(() => materialize(request(outputPath)), /receipt payload digest mismatch/);
  assert.equal(readFileSync(resolve(outputPath, "tampered.txt"), "utf8"), "changed\n");
});
~~~

- [ ] **Step 3: Run and verify the missing materializer**

Run: `node --test test/unit/materialize.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement receipt ownership and atomic copy**

~~~js
import Ajv from "ajv/dist/2020.js";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { treeHash } from "./hash.mjs";
import { readJson, writeJson } from "./json.mjs";

const RECEIPT = ".gravit-plugin-receipt.json";
const receiptSchema = JSON.parse(readFileSync(
  new URL("../../registry/schemas/receipt.schema.json", import.meta.url),
  "utf8",
));
const validateReceiptSchema = new Ajv({ allErrors: true, strict: true })
  .compile(receiptSchema);

export function validateReceipt(receipt) {
  if (!validateReceiptSchema(receipt)) {
    throw new Error("invalid materialization receipt: " +
      validateReceiptSchema.errors.map((error) => error.message).join(", "));
  }
}

function assertOwnedOutput(outputPath, expected) {
  const receiptPath = resolve(outputPath, RECEIPT);
  if (!existsSync(receiptPath)) return false;
  const receipt = readJson(receiptPath);
  validateReceipt(receipt);
  if (
    receipt.registry !== "gravit-cloud" ||
    receipt.plugin !== expected.plugin ||
    receipt.target !== expected.target
  ) return false;
  const actual = treeHash(outputPath, { exclude: [RECEIPT] });
  if (actual !== receipt.materializedDigest) {
    throw new Error("receipt payload digest mismatch: " + outputPath);
  }
  return true;
}

export function materialize({
  reader,
  pluginName,
  target,
  outputPath,
  registryRevision,
  copyDirectory = cpSync,
}) {
  const verification = reader.verify(pluginName);
  if (!verification.ok) throw new Error(verification.errors.join("\n"));
  const selected = reader.entry(pluginName);
  if (!selected.plugin.targets.includes(target)) {
    throw new Error(pluginName + ": target is not configured: " + target);
  }
  const targetRoot = resolve(selected.bundleRoot, "targets", target);
  const sourceTargetDigest = treeHash(targetRoot);
  if (sourceTargetDigest !== selected.locked.targets[target]) {
    throw new Error(pluginName + ": target digest mismatch: " + target);
  }
  if (existsSync(outputPath) && !assertOwnedOutput(outputPath, {
    plugin: pluginName,
    target,
  })) {
    throw new Error("refusing to replace unowned output: " + outputPath);
  }

  const parent = dirname(resolve(outputPath));
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(resolve(parent, "." + basename(outputPath) + ".stage-"));
  const backupRoot = mkdtempSync(resolve(parent, "." + basename(outputPath) + ".backup-"));
  const backup = resolve(backupRoot, "previous");
  try {
    copyDirectory(targetRoot, stage, { recursive: true, preserveTimestamps: false });
    const materializedDigest = treeHash(stage);
    if (materializedDigest !== sourceTargetDigest) {
      throw new Error(pluginName + ": copied target digest mismatch: " + target);
    }
    const receipt = {
      schemaVersion: 1,
      registry: "gravit-cloud",
      registryRevision,
      plugin: pluginName,
      target,
      distributionVersion: selected.plugin.distributionVersion,
      sourceBundleDigest: selected.locked.bundleDigest,
      sourceTargetDigest,
      materializedDigest,
    };
    validateReceipt(receipt);
    writeJson(resolve(stage, RECEIPT), receipt);
    if (existsSync(outputPath)) renameSync(outputPath, backup);
    try {
      renameSync(stage, outputPath);
      rmSync(backupRoot, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(backup) && !existsSync(outputPath)) renameSync(backup, outputPath);
      throw error;
    }
    return receipt;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
}
~~~

Extend `treeHash(root, { exclude = [] } = {})` so excluded bundle-relative POSIX paths are removed before sorting and hashing. The default call remains byte-compatible with Plans 1 and 2. Receipts are deliberately excluded only when verifying an already materialized payload; they are not part of the target projection digest.

- [ ] **Step 5: Resolve the exact registry revision**

Add:

~~~js
import { spawnSync } from "node:child_process";

export function registryRevision(repositoryRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0 || !/^[a-f0-9]{40}\n?$/.test(result.stdout)) {
    throw new Error("registry checkout must have a resolvable Git HEAD");
  }
  return result.stdout.trim();
}
~~~

- [ ] **Step 6: Add the materialize CLI branch**

~~~js
} else if (command === "materialize") {
  const receipt = materialize({
    reader: registry,
    pluginName: option("--plugin"),
    target: option("--target"),
    outputPath: resolve(option("--output")),
    registryRevision: registryRevision(repositoryRoot),
  });
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
~~~

Import `materialize` and `registryRevision`; reject a `--target` outside `claude`, `codex`, and `openclaw` before resolving a target path. `materialize` validates both existing and newly generated receipts against the receipt schema.

- [ ] **Step 7: Run tests and commit**

Run:

~~~bash
npm test
npm run registry:verify
~~~

Expected: all tests and bundle verification pass.

~~~bash
git add registry/schemas/receipt.schema.json scripts/lib/hash.mjs scripts/lib/materialize.mjs scripts/lib/registry-reader.mjs scripts/registry.mjs test/unit/materialize.test.mjs
git commit -m "feat(registry): materialize owned target bundles"
~~~

### Task 4: Automate distribution-revision bumps for source updates

**Files:**

- Create: `scripts/bump-plugin-revisions.mjs`
- Create: `test/unit/revisions.test.mjs`
- Modify: `scripts/renovate-plugin-sync.sh`
- Modify: `renovate.json`

**Interfaces:**

- Produces: `bumpChangedRevisions({ catalog, lock }): { catalog, changedNames }`
- Bump rule: `X.Y.Z-gravit.N` becomes `X.Y.Z-gravit.(N+1)` only when configured source identity differs from the lock.

- [ ] **Step 1: Write the failing revision test**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { bumpChangedRevisions } from "../../scripts/bump-plugin-revisions.mjs";

test("bumps only the plugin whose immutable source changed", () => {
  const catalog = {
    plugins: [
      {
        name: "changed",
        distributionVersion: "1.2.5-gravit.3",
        source: {
          type: "github",
          repo: "a/b",
          ref: "v1.2.5",
          sha: "b".repeat(40),
        },
      },
      {
        name: "same",
        distributionVersion: "1.0.0-gravit.1",
        source: {
          type: "github",
          repo: "c/d",
          ref: "main",
          sha: "c".repeat(40),
        },
      },
    ],
  };
  const lock = {
    plugins: {
      changed: {
        source: {
          type: "github",
          repo: "a/b",
          ref: "v1.2.4",
          sha: "a".repeat(40),
        },
      },
      same: { source: structuredClone(catalog.plugins[1].source) },
    },
  };
  const result = bumpChangedRevisions({ catalog, lock });
  assert.deepEqual(result.changedNames, ["changed"]);
  assert.equal(result.catalog.plugins[0].distributionVersion, "1.2.5-gravit.4");
  assert.equal(result.catalog.plugins[1].distributionVersion, "1.0.0-gravit.1");
});
~~~

- [ ] **Step 2: Run and verify the missing script**

Run: `node --test test/unit/revisions.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the pure bump and CLI**

~~~js
#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "./lib/json.mjs";

function nextRevision(version) {
  const match = version.match(/^(\d+\.\d+\.\d+)-gravit\.(\d+)$/);
  if (!match) {
    throw new Error("distributionVersion must end in -gravit.N: " + version);
  }
  return match[1] + "-gravit." + (Number(match[2]) + 1);
}

export function bumpChangedRevisions({ catalog, lock }) {
  const next = structuredClone(catalog);
  const changedNames = [];
  for (const plugin of next.plugins) {
    const previous = lock.plugins[plugin.name];
    if (!previous) continue;
    if (JSON.stringify(plugin.source) !== JSON.stringify(previous.source)) {
      plugin.distributionVersion = nextRevision(plugin.distributionVersion);
      changedNames.push(plugin.name);
    }
  }
  return { catalog: next, changedNames: changedNames.sort() };
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const catalogPath = resolve("registry/catalog.json");
  const result = bumpChangedRevisions({
    catalog: readJson(catalogPath),
    lock: readJson(resolve("registry/lock.json")),
  });
  writeJson(catalogPath, result.catalog);
  process.stdout.write(
    result.changedNames.join("\n") + (result.changedNames.length ? "\n" : ""),
  );
}
~~~

- [ ] **Step 4: Point Renovate at the neutral catalog**

Change both custom manager patterns to:

~~~json
["/^registry\\/catalog\\.json$/"]
~~~

Change match strings to the ordered source object beginning with `"type": "github"`. Match package rules against `registry/catalog.json`. Set post-upgrade file filters to:

~~~json
[
  "registry/catalog.json",
  "registry/lock.json",
  ".claude-plugin/marketplace.json",
  ".agents/**",
  "plugins/**"
]
~~~

- [ ] **Step 5: Update the post-upgrade script**

~~~bash
#!/usr/bin/env bash
set -euo pipefail

npm ci --ignore-scripts
node scripts/bump-plugin-revisions.mjs
npm run plugins:sync
npm run validate
~~~

- [ ] **Step 6: Run tests and commit**

Run:

~~~bash
node --test test/unit/revisions.test.mjs
npm test
npm run validate
bash -n scripts/renovate-plugin-sync.sh
~~~

Expected: every command exits 0.

~~~bash
git add scripts/bump-plugin-revisions.mjs scripts/renovate-plugin-sync.sh renovate.json test/unit/revisions.test.mjs
git commit -m "chore(renovate): sync neutral plugin catalog"
~~~

### Task 5: Add isolated Claude, Codex, and OpenClaw smoke tests

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/smoke-clients.mjs`
- Create: `test/unit/smoke-clients.test.mjs`
- Modify: `.github/workflows/validate.yml`

**Interfaces:**

- Produces: `smokeCommands({ repositoryRoot, temporaryRoot }): CommandSpec[]`
- `CommandSpec`: `{ name, command, args, env, expectedPattern? }`
- CLI: `npm run smoke:clients`

- [ ] **Step 1: Pin the exact client CLIs**

Run:

~~~bash
npm install --save-dev --save-exact @openai/codex@0.145.0 openclaw@2026.7.1-2
~~~

Keep `@anthropic-ai/claude-code` at `2.1.220`.

- [ ] **Step 2: Write the command-construction test**

~~~js
test("all clients use isolated state and local bundles", () => {
  const commands = smokeCommands({
    repositoryRoot: "/workspace/gravit-ai-toolkit",
    temporaryRoot: "/tmp/gravit-client-smoke",
  });
  assert.deepEqual(commands.map(({ name }) => name), [
    "claude-validate",
    "codex-marketplace-add",
    "codex-plugin-add",
    "codex-plugin-list",
    "openclaw-setup",
    "openclaw-install",
    "openclaw-inspect",
  ]);
  for (const command of commands.filter(({ name }) => name.startsWith("codex-"))) {
    assert.equal(command.env.CODEX_HOME, "/tmp/gravit-client-smoke/codex");
  }
  for (const command of commands.filter(({ name }) => name.startsWith("openclaw-"))) {
    assert.equal(command.env.OPENCLAW_STATE_DIR, "/tmp/gravit-client-smoke/openclaw");
  }
});
~~~

- [ ] **Step 3: Implement exact commands**

~~~js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function smokeCommands({ repositoryRoot, temporaryRoot }) {
  const bin = (name) => resolve(repositoryRoot, "node_modules/.bin", name);
  const codexEnv = {
    ...process.env,
    CODEX_HOME: resolve(temporaryRoot, "codex"),
  };
  const openclawEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: resolve(temporaryRoot, "openclaw"),
  };
  const openclawBundle = resolve(repositoryRoot, "plugins/azure/targets/openclaw");
  return [
    {
      name: "claude-validate",
      command: bin("claude"),
      args: ["plugin", "validate", "--strict", repositoryRoot],
      env: process.env,
      expectedPattern: /valid/i,
    },
    {
      name: "codex-marketplace-add",
      command: bin("codex"),
      args: ["plugin", "marketplace", "add", repositoryRoot, "--json"],
      env: codexEnv,
      expectedPattern: /"marketplaceName"\s*:\s*"gravit-cloud"/,
    },
    {
      name: "codex-plugin-add",
      command: bin("codex"),
      args: ["plugin", "add", "azure@gravit-cloud", "--json"],
      env: codexEnv,
      expectedPattern: /"pluginId"\s*:\s*"azure@gravit-cloud"/,
    },
    {
      name: "codex-plugin-list",
      command: bin("codex"),
      args: ["plugin", "list", "--json"],
      env: codexEnv,
      expectedPattern: /"pluginId"\s*:\s*"azure@gravit-cloud"/,
    },
    {
      name: "openclaw-setup",
      command: bin("openclaw"),
      args: ["setup", "--baseline"],
      env: openclawEnv,
    },
    {
      name: "openclaw-install",
      command: bin("openclaw"),
      args: ["plugins", "install", openclawBundle, "--force"],
      env: openclawEnv,
    },
    {
      name: "openclaw-inspect",
      command: bin("openclaw"),
      args: ["plugins", "inspect", "azure", "--json"],
      env: openclawEnv,
      expectedPattern: /azure/,
    },
  ];
}

export function runClientSmoke(repositoryRoot) {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "gravit-client-smoke-"));
  try {
    for (const spec of smokeCommands({ repositoryRoot, temporaryRoot })) {
      const result = spawnSync(spec.command, spec.args, {
        cwd: repositoryRoot,
        env: spec.env,
        encoding: "utf8",
      });
      const output = (result.stdout || "") + (result.stderr || "");
      if (
        result.status !== 0 ||
        (spec.expectedPattern && !spec.expectedPattern.test(output))
      ) {
        throw new Error(spec.name + " failed\n" + output);
      }
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
~~~

The CLI resolves repository root from `import.meta.url`, calls `runClientSmoke`, and prints `Client smoke tests passed.`.

- [ ] **Step 4: Add the script and CI jobs**

Add `"smoke:clients": "node scripts/smoke-clients.mjs"`.

The offline job runs:

~~~yaml
- name: Run offline tests and registry validation
  run: |
    npm test
    npm run validate
    npm run registry:verify
- name: Verify deterministic generation
  run: |
    npm run plugins:sync
    git diff --exit-code -- registry .claude-plugin .agents plugins
~~~

Add:

~~~yaml
client-smoke:
  needs: validate
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
      with:
        node-version: 24
    - run: npm ci
    - run: npm run smoke:clients
~~~

- [ ] **Step 5: Run offline and client checks**

Run:

~~~bash
npm test
npm run validate
npm run registry:verify
npm run smoke:clients
~~~

Expected: offline checks pass first; Claude validates; Codex installs Azure in isolated `CODEX_HOME`; OpenClaw installs and inspects the local compatibility bundle in isolated `OPENCLAW_STATE_DIR`.

- [ ] **Step 6: Commit**

~~~bash
git add package.json package-lock.json scripts/smoke-clients.mjs test/unit/smoke-clients.test.mjs .github/workflows/validate.yml
git commit -m "test(registry): smoke test supported clients"
~~~

### Task 6: Enforce version identity against the merge-base lock

**Files:**

- Modify: `scripts/validate.mjs`
- Modify: `scripts/lib/validator.mjs`
- Modify: `.github/workflows/validate.yml`
- Create: `test/unit/base-lock.test.mjs`

**Interfaces:**

- CLI option: `node scripts/validate.mjs --compare-lock /tmp/gravit-base-lock.json`
- Produces: `validateVersionHistory({ currentLock, baseLock }): string[]`

- [ ] **Step 1: Write the failing history test**

~~~js
test("rejects reuse of one distribution version for another digest", () => {
  const baseLock = lockWith("1.2.5-gravit.4", "a".repeat(64));
  const currentLock = lockWith("1.2.5-gravit.4", "b".repeat(64));
  assert.deepEqual(validateVersionHistory({ currentLock, baseLock }), [
    "azure: distributionVersion 1.2.5-gravit.4 already identifies another bundle",
  ]);
});
~~~

- [ ] **Step 2: Implement history comparison**

~~~js
export function validateVersionHistory({ currentLock, baseLock }) {
  const errors = [];
  for (const [name, current] of Object.entries(currentLock.plugins)) {
    const previous = baseLock.plugins[name];
    if (
      previous &&
      previous.distributionVersion === current.distributionVersion &&
      previous.bundleDigest !== current.bundleDigest
    ) {
      errors.push(
        name + ": distributionVersion " + current.distributionVersion +
        " already identifies another bundle",
      );
    }
  }
  return errors.sort();
}
~~~

Parse `--compare-lock` in `validate.mjs` and append these errors after normal validation.

- [ ] **Step 3: Compare the PR base lock in CI**

Set checkout `fetch-depth: 0`. Add:

~~~yaml
- name: Extract merge-base registry lock
  if: github.event_name == 'pull_request'
  env:
    BASE_SHA: ${{ github.event.pull_request.base.sha }}
  run: |
    REGISTRY_BASE_COMMIT="$(git merge-base HEAD "$BASE_SHA")"
    if git cat-file -e "${REGISTRY_BASE_COMMIT}:registry/lock.json"; then
      git show "${REGISTRY_BASE_COMMIT}:registry/lock.json" > "$RUNNER_TEMP/gravit-base-lock.json"
    else
      printf '%s\n' '{"plugins":{}}' > "$RUNNER_TEMP/gravit-base-lock.json"
    fi
- name: Validate version identity
  if: github.event_name == 'pull_request'
  run: node scripts/validate.mjs --compare-lock "$RUNNER_TEMP/gravit-base-lock.json"
~~~

- [ ] **Step 4: Run tests and commit**

Run:

~~~bash
node --test test/unit/base-lock.test.mjs
npm test
npm run validate
~~~

Expected: all commands pass.

~~~bash
git add scripts/validate.mjs scripts/lib/validator.mjs test/unit/base-lock.test.mjs .github/workflows/validate.yml
git commit -m "ci(registry): prevent plugin version collisions"
~~~

### Task 7: Build universal release archives and update runbooks

**Files:**

- Replace: `build.sh`
- Create: `scripts/build-release.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create: `test/integration/release-archives.test.mjs`

**Interfaces:**

- `npm run build` creates one `dist/PLUGIN-vDISTRIBUTION_VERSION.zip` per catalog plugin.
- Each archive root is the plugin name and contains the universal bundle, target projections, LICENSE, and a release receipt.

- [ ] **Step 1: Write the failing archive test**

Build into a temporary `DIST_DIR`. Assert Azure contains:

~~~text
azure/.agent-plugin/plugin.json
azure/components/
azure/targets/claude/.claude-plugin/plugin.json
azure/targets/codex/.codex-plugin/plugin.json
azure/targets/openclaw/.codex-plugin/plugin.json
azure/LICENSE
azure/.gravit-plugin-receipt.json
~~~

Assert no archive entry begins with `../`, `/`, `.sources/`, or `node_modules/`.

- [ ] **Step 2: Run and verify the old build fails**

Run: `node --test test/integration/release-archives.test.mjs`

Expected: FAIL because the current build archives only `gravit-custom`.

- [ ] **Step 3: Replace the archive builder**

Keep `build.sh` as:

~~~bash
#!/usr/bin/env bash
set -euo pipefail
node scripts/build-release.mjs
~~~

The Node builder must:

1. call `openRegistry(repositoryRoot).verify()`;
2. resolve Git revision with `registryRevision`;
3. copy each `plugins/NAME` into an isolated stage;
4. write a release receipt whose target is `universal` after extending only the receipt target enum; for that receipt both `sourceTargetDigest` and `materializedDigest` equal the verified lock `bundleDigest`, calculated before adding the receipt;
5. pass the sorted relative paths from `walkFiles` to `zip -X -q` through `spawnSync`, not shell expansion;
6. write to `process.env.DIST_DIR` or the repository `dist/`.

Every nonzero zip exit throws with captured stderr.

Implement the loop with explicit arguments and a fixed archive timestamp:

~~~js
export function buildRelease({ repositoryRoot, distRoot }) {
  const reader = openRegistry(repositoryRoot);
  const verification = reader.verify();
  if (!verification.ok) throw new Error(verification.errors.join("\n"));
  const revision = registryRevision(repositoryRoot);
  mkdirSync(distRoot, { recursive: true });
  const stage = mkdtempSync(resolve(tmpdir(), "gravit-release-"));
  try {
    for (const summary of reader.list()) {
      const selected = reader.entry(summary.name);
      const bundleStage = resolve(stage, summary.name);
      cpSync(selected.bundleRoot, bundleStage, {
        recursive: true,
        preserveTimestamps: false,
      });
      const payloadDigest = treeHash(bundleStage);
      if (payloadDigest !== selected.locked.bundleDigest) {
        throw new Error(summary.name + ": staged release digest mismatch");
      }
      const receipt = {
        schemaVersion: 1,
        registry: "gravit-cloud",
        registryRevision: revision,
        plugin: summary.name,
        target: "universal",
        distributionVersion: summary.distributionVersion,
        sourceBundleDigest: selected.locked.bundleDigest,
        sourceTargetDigest: selected.locked.bundleDigest,
        materializedDigest: payloadDigest,
      };
      validateReceipt(receipt);
      writeJson(resolve(bundleStage, ".gravit-plugin-receipt.json"), receipt);
      const epoch = new Date("1980-01-01T00:00:00.000Z");
      const relativeFiles = walkFiles(bundleStage).map((filePath) => {
        utimesSync(filePath, epoch, epoch);
        return relative(stage, filePath).replaceAll("\\", "/");
      }).sort();
      const archive = resolve(
        distRoot,
        summary.name + "-v" + summary.distributionVersion + ".zip",
      );
      rmSync(archive, { force: true });
      const result = spawnSync("zip", ["-X", "-q", archive, ...relativeFiles], {
        cwd: stage,
        encoding: "utf8",
        env: { ...process.env, TZ: "UTC" },
      });
      if (result.status !== 0) {
        throw new Error("zip failed for " + summary.name + ": " + result.stderr.trim());
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
~~~

Import `validateReceipt` from `materialize.mjs`, reuse `treeHash`, `walkFiles`, and `writeJson`, and resolve `distRoot` from `DIST_DIR` only in the executable CLI branch. The test calls `buildRelease` with its own temporary directory.

- [ ] **Step 4: Update the release workflow**

Use:

~~~yaml
- name: Validate and build committed universal bundles
  run: |
    npm test
    npm run validate
    npm run registry:verify
    npm run build
- name: Publish GitHub release
  env:
    GH_TOKEN: ${{ github.token }}
  run: gh release create "$RELEASE_TAG" dist/*-v*.zip --generate-notes
~~~

- [ ] **Step 5: Rewrite consumer documentation**

Document:

~~~bash
npm run registry -- list
npm run registry -- inspect --plugin azure
npm run registry -- verify --plugin azure
npm run registry -- materialize --plugin azure --target codex --output /opt/gravit/plugins/azure
npm run registry -- materialize --plugin azure --target openclaw --output /opt/gravit/plugins/azure-openclaw
openclaw plugins install /opt/gravit/plugins/azure-openclaw --force
~~~

Add local development, pinned CI image, cloud shared-volume, OpenClaw detect-only limitations, and maintainer update sections. State that production consumers pin a tag or commit and never `main`.

- [ ] **Step 6: Run release and repository verification**

Run:

~~~bash
npm test
npm run validate
npm run registry:verify
npm run build
node --test test/integration/release-archives.test.mjs
git diff --check
~~~

Expected: all commands pass and six versioned archives appear under ignored `dist/`.

- [ ] **Step 7: Commit**

~~~bash
git add build.sh scripts/build-release.mjs .github/workflows/release.yml README.md AGENTS.md test/integration/release-archives.test.mjs
git commit -m "feat(registry): distribute verified plugin bundles"
~~~

## Plan 3 Completion Gate

Run:

~~~bash
npm ci
npm test
npm run plugins:sync
npm run validate
npm run registry:verify
npm run smoke:clients
npm run build
git diff --exit-code -- registry .claude-plugin .agents plugins sources
git diff --check
git status --short
~~~

Expected:

- offline tests, sync, validation, and receipt verification pass;
- Claude, Codex, and OpenClaw smoke tests pass in isolated state directories;
- OpenClaw installs a Codex-format bundle and never loads native in-process plugin code;
- six universal release archives build from committed bundles;
- a second sync leaves all managed paths unchanged;
- only unrelated pre-existing user changes remain in the worktree.
