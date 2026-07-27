# Plugin Component Adapters and Production Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the registry foundation to account for every supported host component, preserve Azure MCP and hooks, generate complete Claude/Codex bundles, and atomically replace the existing Claude-as-source production sync.

**Architecture:** Parse all upstream manifests and conventional component locations into one typed neutral inventory. Component-specific normalizers produce deterministic records; target adapters render only truthful Claude/Codex support, and a component-accounting gate rejects every silent loss before a staged registry is promoted to `plugins/`, both marketplaces, and `registry/lock.json`.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, Ajv 8.17.1, giget 3.3.1, SHA-256 tree hashes, current repository validation tooling.

## Global Constraints

- Plan 1 completion gate must pass before starting this plan.
- `registry/catalog.json` becomes the only manually maintained plugin-selection and source-pin file at cutover.
- External sources require a lowercase 40-character SHA; the full configured source root is staged.
- Every discovered component receives a target status of `preserved`, `transformed`, `unsupported`, or `rejected`.
- `unsupported` requires an explicit target policy with a stable reason code.
- A required component without a supported disposition stops the build before production files change.
- Commands, agents, MCP, LSP, hooks, app bindings, output styles, monitors, themes, channels, executables, settings, and assets are first-class types.
- Unrecognized manifest component fields and newly discovered conventional component roots fail closed.
- MCP commands may not contain floating package versions or container tags.
- Azure MCP is pinned to `@azure/mcp@2.0.5`; do not retain `@latest`.
- No generated file contains credential values, absolute checkout paths, or build timestamps.
- Runtime scripts and binaries are copied but never executed during sync or validation.
- Bundle replacement and stale-plugin removal happen only after every bundle, marketplace, and lock entry validates.
- A changed bundle hash at an unchanged `distributionVersion` is an error.
- Current unrelated worktree changes must not be staged or overwritten.

---

## File Structure

- Modify `registry/schemas/catalog.schema.json`: production source roots, policies, runtime pins, exceptions, and three-target-ready options.
- Modify `registry/schemas/agent-plugin.schema.json`: complete component records and target dispositions.
- Create `registry/schemas/lock.schema.json`: deterministic provenance and component accounting.
- Create `registry/catalog.json`: six current plugins with immutable sources and distribution versions.
- Create `registry/lock.json`: generated source, component, target, and bundle hashes.
- Create `scripts/lib/upstream-manifest.mjs`: read Claude/Codex manifests and resolve string, array, object, and conventional paths.
- Create `scripts/lib/inventory.mjs`: build a complete typed inventory and reject unknown component roots.
- Create `scripts/lib/mcp.mjs`: normalize direct and wrapped MCP maps and apply exact runtime pins.
- Create `scripts/lib/hooks.mjs`: normalize hook files or inline objects and translate host root variables.
- Create `scripts/lib/component-files.mjs`: commands, agents, LSP, monitors, themes, channels, executables, settings, app bindings, and assets.
- Create `scripts/lib/policy.mjs`: target support matrix and explicit unsupported decisions.
- Create `scripts/lib/provenance.mjs`: accounting, lock entries, and distribution-version collision checks.
- Modify `scripts/lib/bundle-builder.mjs`: render all neutral and target components.
- Modify `scripts/lib/targets/claude.mjs` and `scripts/lib/targets/codex.mjs`: complete host manifests.
- Replace `scripts/sync-plugins.mjs`: thin production orchestrator over the registry modules.
- Replace `scripts/validate.mjs`: offline schema, recursive component, accounting, hash, and version validation.
- Move `plugins/gravit-custom/**` to `sources/gravit-custom/**`: local canonical source.
- Regenerate `plugins/**`, `.claude-plugin/marketplace.json`, and `.agents/plugins/marketplace.json`.
- Create `test/fixtures/complete-plugin/**` and focused unit/integration tests.

### Task 1: Inventory every declared and conventional component

**Files:**

- Create: `test/fixtures/complete-plugin/.claude-plugin/plugin.json`
- Create: `test/fixtures/complete-plugin/.codex-plugin/plugin.json`
- Create: `test/fixtures/complete-plugin/commands/release.md`
- Create: `test/fixtures/complete-plugin/agents/reviewer.md`
- Create: `test/fixtures/complete-plugin/hooks/hooks.json`
- Create: `test/fixtures/complete-plugin/.mcp.json`
- Create: `test/fixtures/complete-plugin/.lsp.json`
- Create: `test/fixtures/complete-plugin/.app.json`
- Create: `test/fixtures/complete-plugin/output-styles/terse.md`
- Create: `test/fixtures/complete-plugin/monitors/monitors.json`
- Create: `test/fixtures/complete-plugin/themes/dark.json`
- Create: `test/fixtures/complete-plugin/channels/alerts.json`
- Create: `test/fixtures/complete-plugin/bin/helper`
- Create: `test/fixtures/complete-plugin/settings.json`
- Create: `test/fixtures/complete-plugin/assets/icon.svg`
- Create: `scripts/lib/upstream-manifest.mjs`
- Create: `scripts/lib/inventory.mjs`
- Create: `test/unit/inventory.test.mjs`

**Interfaces:**

- Produces: `readUpstreamManifests(sourceRoot): { claude, codex }`
- Produces: `inventorySource({ sourceRoot, declaredSkills }): SourceInventory`
- `ComponentRecord`: `{ id, type, sourceFormat, sourcePath, inline, digest, metadata }`
- `SourceInventory`: `{ manifests, skills, components }`, with components sorted by `type:id`.

- [ ] **Step 1: Create complete fixture manifests**

Claude manifest:

~~~json
{
  "name": "complete",
  "version": "1.0.0",
  "description": "Complete component fixture",
  "skills": "./skills/",
  "commands": ["./commands/release.md"],
  "agents": "./agents/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "lspServers": "./.lsp.json",
  "outputStyles": "./output-styles/",
  "channels": ["./channels/alerts.json"],
  "experimental": {
    "themes": "./themes/",
    "monitors": "./monitors/monitors.json"
  }
}
~~~

Codex manifest:

~~~json
{
  "name": "complete",
  "version": "1.0.0",
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks/hooks.json"
}
~~~

Use these minimal component contents:

~~~markdown
---
description: Release the fixture
---

# Release
~~~

~~~markdown
---
name: reviewer
description: Review fixture changes
---

# Reviewer
~~~

~~~json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"\${CLAUDE_PLUGIN_ROOT}/bin/helper\""
          }
        ]
      }
    ]
  }
}
~~~

~~~json
{
  "mcpServers": {
    "fixture": {
      "command": "npx",
      "args": ["-y", "@fixture/mcp@latest", "server", "start"],
      "env": {
        "FIXTURE_TOKEN": "\${FIXTURE_TOKEN}"
      }
    }
  }
}
~~~

~~~json
{
  "fixture-lsp": {
    "command": "fixture-language-server",
    "args": ["--stdio"]
  }
}
~~~

~~~json
{
  "apps": {
    "fixture": "plugin_asdk_app_fixture"
  }
}
~~~

Use valid small JSON objects for monitor, theme, channel, and settings; use one-line Markdown for the output style. Add a minimal deterministic SVG at `assets/icon.svg`. Make `bin/helper` executable and give it this inert content:

~~~js
#!/usr/bin/env node
process.stdout.write("fixture helper\n");
~~~

- [ ] **Step 2: Write the failing inventory test**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventorySource } from "../../scripts/lib/inventory.mjs";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/complete-plugin");

test("inventories every known component type exactly once", () => {
  const inventory = inventorySource({ sourceRoot: fixture });
  assert.deepEqual(
    [...new Set(inventory.components.map((component) => component.type))].sort(),
    [
      "agent",
      "app",
      "asset",
      "channel",
      "command",
      "executable",
      "hook",
      "lsp",
      "mcp",
      "monitor",
      "output-style",
      "settings",
      "theme",
    ],
  );
  assert.equal(
    new Set(inventory.components.map((component) => component.type + ":" + component.id)).size,
    inventory.components.length,
  );
});

test("rejects a new manifest component field", () => {
  const source = structuredClone(inventorySource({ sourceRoot: fixture }).manifests.claude);
  source.unknownRuntime = "./runtime.json";
  assert.throws(
    () => inventorySource({ sourceRoot: fixture, manifestOverrides: { claude: source } }),
    /unknown Claude component field: unknownRuntime/,
  );
});
~~~

- [ ] **Step 3: Run the test and verify the missing inventory module**

Run: `node --test test/unit/inventory.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement manifest loading and field allowlists**

~~~js
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJson } from "./json.mjs";

export const CLAUDE_COMPONENT_FIELDS = new Set([
  "skills",
  "commands",
  "agents",
  "hooks",
  "mcpServers",
  "lspServers",
  "outputStyles",
  "channels",
]);

export const CODEX_COMPONENT_FIELDS = new Set([
  "skills",
  "hooks",
  "mcpServers",
  "apps",
]);

export function readUpstreamManifests(sourceRoot) {
  const claudePath = resolve(sourceRoot, ".claude-plugin/plugin.json");
  const codexPath = resolve(sourceRoot, ".codex-plugin/plugin.json");
  return {
    claude: existsSync(claudePath) ? readJson(claudePath) : {},
    codex: existsSync(codexPath) ? readJson(codexPath) : {},
  };
}
~~~

- [ ] **Step 5: Implement declaration expansion and conventional discovery**

Use one helper for all string, array, and inline forms:

~~~js
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { treeHash, sha256 } from "./hash.mjs";
import { stableJson } from "./json.mjs";
import { assertInside } from "./path-safety.mjs";
import { declaredSkillPaths, discoverSkills } from "./skills.mjs";
import {
  CLAUDE_COMPONENT_FIELDS,
  CODEX_COMPONENT_FIELDS,
  readUpstreamManifests,
} from "./upstream-manifest.mjs";

const TYPE_CONFIG = {
  commands: { type: "command", defaultPath: "commands" },
  agents: { type: "agent", defaultPath: "agents" },
  hooks: { type: "hook", defaultPath: "hooks/hooks.json" },
  mcpServers: { type: "mcp", defaultPath: ".mcp.json" },
  lspServers: { type: "lsp", defaultPath: ".lsp.json" },
  outputStyles: { type: "output-style", defaultPath: "output-styles" },
  channels: { type: "channel" },
  apps: { type: "app", defaultPath: ".app.json" },
};

function values(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function recordFor({ sourceRoot, type, value, index }) {
  if (typeof value === "string") {
    const sourcePath = assertInside(
      sourceRoot,
      resolve(sourceRoot, value),
      type + " component",
    );
    if (!existsSync(sourcePath)) throw new Error(type + " component does not exist: " + value);
    const relativePath = relative(sourceRoot, sourcePath).replaceAll("\\", "/");
    return {
      id: type + "-" + sha256(relativePath).slice(0, 12),
      type,
      sourceFormat: "path",
      sourcePath,
      inline: undefined,
      digest: treeHash(sourcePath),
      metadata: { relativePath },
    };
  }
  const inlineDigest = sha256(stableJson(value));
  return {
    id: type + "-inline-" + inlineDigest.slice(0, 12),
    type,
    sourceFormat: "inline",
    sourcePath: undefined,
    inline: value,
    digest: inlineDigest,
    metadata: {},
  };
}
~~~

When `treeHash` receives a file, update it to hash one `basename + file hash` line; retain existing directory behavior. Complete `inventorySource` with:

~~~js
export function inventorySource({ sourceRoot, manifestOverrides }) {
  const manifests = {
    ...readUpstreamManifests(sourceRoot),
    ...manifestOverrides,
  };
  for (const key of Object.keys(manifests.claude)) {
    if (
      key === "experimental" ||
      !/^[a-z]/.test(key) ||
      ["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "displayName", "defaultEnabled", "userConfig", "dependencies"].includes(key)
    ) continue;
    if (!CLAUDE_COMPONENT_FIELDS.has(key)) {
      throw new Error("unknown Claude component field: " + key);
    }
  }
  for (const key of Object.keys(manifests.codex)) {
    if (
      !/^[a-z]/.test(key) ||
      ["name", "version", "description", "author", "homepage", "repository", "license", "keywords", "interface"].includes(key)
    ) continue;
    if (!CODEX_COMPONENT_FIELDS.has(key)) {
      throw new Error("unknown Codex component field: " + key);
    }
  }

  const components = [];
  const seen = new Set();
  function addRecord(record) {
    const key = record.type + ":" + (
      record.sourceFormat === "path"
        ? record.metadata.relativePath
        : record.digest
    );
    if (seen.has(key)) return;
    components.push(record);
    seen.add(key);
  }
  for (const manifest of [manifests.claude, manifests.codex]) {
    for (const [field, config] of Object.entries(TYPE_CONFIG)) {
      const configured = manifest[field];
      const candidates = configured === undefined && config.defaultPath &&
        existsSync(resolve(sourceRoot, config.defaultPath))
        ? [config.defaultPath]
        : values(configured);
      for (const [index, value] of candidates.entries()) {
        const record = recordFor({ sourceRoot, type: config.type, value, index });
        addRecord(record);
      }
    }
  }

  for (const [field, type] of [["themes", "theme"], ["monitors", "monitor"]]) {
    for (const [index, value] of values(manifests.claude.experimental?.[field]).entries()) {
      addRecord(recordFor({ sourceRoot, type, value, index }));
    }
  }

  const extra = [
    ["monitor", "monitors/monitors.json"],
    ["theme", "themes"],
    ["executable", "bin"],
    ["settings", "settings.json"],
    ["asset", "assets"],
  ];
  for (const [type, path] of extra) {
    if (!existsSync(resolve(sourceRoot, path))) continue;
    addRecord(recordFor({ sourceRoot, type, value: path, index: 0 }));
  }

  const skillPaths = [
    ...(declaredSkillPaths(manifests.claude.skills) || []),
    ...(declaredSkillPaths(manifests.codex.skills) || []),
  ].filter((value, index, all) => all.indexOf(value) === index);
  return {
    manifests,
    skills: discoverSkills({
      sourceRoot,
      declaredSkills: skillPaths.length ? skillPaths : undefined,
    }),
    components: components.sort((left, right) => (
      (left.type + ":" + left.id).localeCompare(right.type + ":" + right.id)
    )),
  };
}
~~~

- [ ] **Step 6: Run the focused and complete tests**

Run: `node --test test/unit/inventory.test.mjs && npm test`

Expected: all known fixture types appear once; the unknown field fails closed.

- [ ] **Step 7: Commit**

~~~bash
git add test/fixtures/complete-plugin scripts/lib/upstream-manifest.mjs scripts/lib/inventory.mjs scripts/lib/hash.mjs test/unit/inventory.test.mjs
git commit -m "feat(registry): inventory all plugin components"
~~~

### Task 2: Normalize MCP servers and enforce runtime pins

**Files:**

- Create: `scripts/lib/mcp.mjs`
- Create: `test/unit/mcp.test.mjs`
- Modify: `registry/schemas/catalog.schema.json`
- Modify: `test/fixtures/skill-only-catalog.json`

**Interfaces:**

- Produces: `normalizeMcp({ record, runtimePins }): NormalizedMcpServer[]`
- Produces: `writeMcpConfig({ servers, target, filePath }): void`
- `NormalizedMcpServer`: `{ id, transport, command, args, env, runtimeDependencies }`

- [ ] **Step 1: Extend the catalog schema for exact runtime pins**

Add to each plugin:

~~~json
{
  "runtimeDependencies": {
    "type": "object",
    "additionalProperties": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    }
  }
}
~~~

The fixture catalog adds:

~~~json
{
  "runtimeDependencies": {
    "@fixture/mcp": "1.4.2"
  }
}
~~~

- [ ] **Step 2: Write failing MCP tests**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventorySource } from "../../scripts/lib/inventory.mjs";
import { normalizeMcp } from "../../scripts/lib/mcp.mjs";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/complete-plugin");

test("unwraps mcpServers and replaces latest with the catalog pin", () => {
  const record = inventorySource({ sourceRoot: fixture }).components
    .find((component) => component.type === "mcp");
  assert.deepEqual(normalizeMcp({
    record,
    runtimePins: { "@fixture/mcp": "1.4.2" },
  }), [{
    id: "fixture",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@fixture/mcp@1.4.2", "server", "start"],
    env: { FIXTURE_TOKEN: "\${FIXTURE_TOKEN}" },
    runtimeDependencies: { "@fixture/mcp": "1.4.2" },
  }]);
});

test("rejects latest without an exact catalog pin", () => {
  const record = inventorySource({ sourceRoot: fixture }).components
    .find((component) => component.type === "mcp");
  assert.throws(() => normalizeMcp({ record, runtimePins: {} }), /unpinned MCP package @fixture\/mcp/);
});

test("rejects an exact source version that disagrees with the catalog pin", () => {
  const record = {
    sourceFormat: "inline",
    inline: {
      mcpServers: {
        fixture: { command: "npx", args: ["-y", "@fixture/mcp@1.4.1"] },
      },
    },
  };
  assert.throws(
    () => normalizeMcp({ record, runtimePins: { "@fixture/mcp": "1.4.2" } }),
    /MCP package version disagrees with catalog pin/,
  );
});
~~~

- [ ] **Step 3: Run the test and verify the missing module failure**

Run: `node --test test/unit/mcp.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement MCP normalization**

~~~js
import { readJson, writeJson } from "./json.mjs";

function sourceObject(record) {
  return record.sourceFormat === "inline" ? record.inline : readJson(record.sourcePath);
}

function serverMap(value) {
  return value.mcpServers || value.mcp_servers || value;
}

function npmPackage(spec) {
  const scoped = spec.match(/^(@[^/]+\/[^@]+)(?:@(.+))?$/);
  if (scoped) return { name: scoped[1], version: scoped[2] };
  const unscoped = spec.match(/^([^@/]+)(?:@(.+))?$/);
  return unscoped ? { name: unscoped[1], version: unscoped[2] } : undefined;
}

function pinArgs(command, args, runtimePins) {
  if (!["npx", "npx.cmd"].includes(command)) {
    return { args, runtimeDependencies: {} };
  }
  const packageIndex = args.findIndex((argument) => !String(argument).startsWith("-"));
  if (packageIndex === -1) throw new Error("npx MCP command is missing a package");
  const parsed = npmPackage(String(args[packageIndex]));
  if (!parsed) throw new Error("invalid npx MCP package: " + args[packageIndex]);
  const pinnedVersion = runtimePins[parsed.name];
  if (!pinnedVersion) throw new Error("unpinned MCP package " + parsed.name);
  if (
    parsed.version &&
    !["latest", "next", "*"].includes(parsed.version) &&
    parsed.version !== pinnedVersion
  ) {
    throw new Error("MCP package version disagrees with catalog pin: " + parsed.name);
  }
  const rewritten = [...args];
  rewritten[packageIndex] = parsed.name + "@" + pinnedVersion;
  return {
    args: rewritten,
    runtimeDependencies: { [parsed.name]: pinnedVersion },
  };
}

export function normalizeMcp({ record, runtimePins = {} }) {
  return Object.entries(serverMap(sourceObject(record)))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, server]) => {
      const pinned = pinArgs(server.command, server.args || [], runtimePins);
      const transport = server.type || (server.url ? "http" : "stdio");
      if (!["stdio", "http", "sse"].includes(transport)) {
        throw new Error("unsupported MCP transport for " + id + ": " + transport);
      }
      return {
        id,
        transport,
        command: server.command,
        args: pinned.args,
        env: server.env || {},
        url: server.url,
        runtimeDependencies: pinned.runtimeDependencies,
      };
    });
}

export function writeMcpConfig({ servers, target, filePath }) {
  const mapped = Object.fromEntries(servers.map((server) => [
    server.id,
    Object.fromEntries(Object.entries({
      type: server.transport === "stdio" ? undefined : server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
    }).filter(([, value]) => value !== undefined)),
  ]));
  writeJson(filePath, target === "codex" ? { mcp_servers: mapped } : { mcpServers: mapped });
}
~~~

- [ ] **Step 5: Add secret-value safety**

Add a test asserting an env value equal to a non-placeholder literal such as `secret-value` fails. Implement this rule:

~~~js
function assertSafeEnv(serverId, env) {
  for (const [name, value] of Object.entries(env)) {
    if (value !== "\${" + name + "}" && value !== "") {
      throw new Error("MCP env must not embed a value: " + serverId + "." + name);
    }
  }
}
~~~

Call it before returning each normalized server.

- [ ] **Step 6: Run tests and commit**

Run: `npm test`

Expected: all tests pass.

~~~bash
git add scripts/lib/mcp.mjs registry/schemas/catalog.schema.json test/fixtures/skill-only-catalog.json test/unit/mcp.test.mjs
git commit -m "feat(registry): normalize pinned MCP servers"
~~~

### Task 3: Normalize hooks and translate host root variables

**Files:**

- Create: `scripts/lib/hooks.mjs`
- Create: `test/unit/hooks.test.mjs`

**Interfaces:**

- Produces: `normalizeHooks(record): NormalizedHookConfig`
- Produces: `renderHooks({ config, target }): object`
- Root mapping: Claude uses `CLAUDE_PLUGIN_ROOT`; Codex uses `PLUGIN_ROOT`.

- [ ] **Step 1: Write failing hook tests**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventorySource } from "../../scripts/lib/inventory.mjs";
import { normalizeHooks, renderHooks } from "../../scripts/lib/hooks.mjs";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/complete-plugin");
const record = inventorySource({ sourceRoot: fixture }).components
  .find((component) => component.type === "hook");

test("preserves Claude roots and maps Codex roots", () => {
  const config = normalizeHooks(record);
  const claude = JSON.stringify(renderHooks({ config, target: "claude" }));
  const codex = JSON.stringify(renderHooks({ config, target: "codex" }));
  assert.match(claude, /CLAUDE_PLUGIN_ROOT/);
  assert.match(codex, /PLUGIN_ROOT/);
  assert.doesNotMatch(codex, /CLAUDE_PLUGIN_ROOT/);
});

test("rejects a hook command with an absolute source path", () => {
  assert.throws(
    () => normalizeHooks({
      sourceFormat: "inline",
      inline: { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/tmp/run.sh" }] }] } },
    }),
    /absolute hook command path/,
  );
});
~~~

- [ ] **Step 2: Run and verify the missing module**

Run: `node --test test/unit/hooks.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement normalization and rendering**

~~~js
import { isAbsolute } from "node:path";
import { readJson } from "./json.mjs";

function sourceObject(record) {
  return record.sourceFormat === "inline" ? record.inline : readJson(record.sourcePath);
}

export function normalizeHooks(record) {
  const config = structuredClone(sourceObject(record));
  const hooks = config.hooks || config;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error("hook event must contain an array: " + event);
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (hook.type === "command" && isAbsolute(String(hook.command).split(/\s+/, 1)[0])) {
          throw new Error("absolute hook command path: " + hook.command);
        }
      }
    }
  }
  return { hooks };
}

export function renderHooks({ config, target }) {
  if (!["claude", "codex"].includes(target)) throw new Error("unsupported hook target: " + target);
  const rendered = structuredClone(config);
  if (target === "codex") {
    for (const groups of Object.values(rendered.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          if (typeof hook.command === "string") {
            hook.command = hook.command.replaceAll(
              "\${CLAUDE_PLUGIN_ROOT}",
              "\${PLUGIN_ROOT}",
            );
          }
        }
      }
    }
  }
  return rendered;
}
~~~

- [ ] **Step 4: Run tests and commit**

Run: `npm test`

Expected: all tests pass.

~~~bash
git add scripts/lib/hooks.mjs test/unit/hooks.test.mjs
git commit -m "feat(registry): translate trusted hook definitions"
~~~

### Task 4: Apply a truthful support matrix to all remaining components

**Files:**

- Create: `scripts/lib/component-files.mjs`
- Create: `scripts/lib/policy.mjs`
- Create: `test/unit/policy.test.mjs`
- Modify: `registry/schemas/catalog.schema.json`

**Interfaces:**

- Produces: `targetDisposition({ component, target, targetPolicies }): Disposition`
- `Disposition`: `{ status, reasonCode, renderAs }`
- Produces: `copyComponent({ component, bundleRoot, neutralRoot }): string`

- [ ] **Step 1: Add explicit target policies to the schema**

Use this value shape per target:

~~~json
{
  "targetPolicies": {
    "type": "object",
    "additionalProperties": {
      "type": "object",
      "additionalProperties": false,
      "required": ["unsupported"],
      "properties": {
        "unsupported": {
          "type": "object",
          "additionalProperties": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9-]*$"
          }
        }
      }
    }
  }
}
~~~

Keys in `unsupported` are component types; values are stable reason codes such as `host-does-not-load-agents`.

- [ ] **Step 2: Write the support-matrix tests**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { targetDisposition } from "../../scripts/lib/policy.mjs";

const component = (type) => ({ id: type + "-fixture", type });

test("maps commands to skills for Codex and preserves them for Claude", () => {
  assert.deepEqual(targetDisposition({
    component: component("command"),
    target: "codex",
    targetPolicies: {},
  }), { status: "transformed", reasonCode: "command-to-skill", renderAs: "skill" });
  assert.deepEqual(targetDisposition({
    component: component("command"),
    target: "claude",
    targetPolicies: {},
  }), { status: "preserved", reasonCode: "native-component", renderAs: "command" });
});

test("requires an explicit policy for unsupported Codex agents", () => {
  assert.throws(
    () => targetDisposition({
      component: component("agent"),
      target: "codex",
      targetPolicies: {},
    }),
    /missing unsupported policy for codex agent/,
  );
  assert.deepEqual(targetDisposition({
    component: component("agent"),
    target: "codex",
    targetPolicies: {
      codex: { unsupported: { agent: "host-does-not-load-agents" } },
    },
  }), {
    status: "unsupported",
    reasonCode: "host-does-not-load-agents",
    renderAs: undefined,
  });
});
~~~

- [ ] **Step 3: Implement the matrix**

~~~js
const SUPPORT = {
  claude: {
    skill: ["preserved", "skill"],
    command: ["preserved", "command"],
    agent: ["preserved", "agent"],
    hook: ["transformed", "hook"],
    mcp: ["transformed", "mcp"],
    lsp: ["preserved", "lsp"],
    "output-style": ["preserved", "output-style"],
    monitor: ["preserved", "monitor"],
    theme: ["preserved", "theme"],
    channel: ["preserved", "channel"],
    executable: ["preserved", "executable"],
    settings: ["preserved", "settings"],
    asset: ["preserved", "asset"],
    app: undefined,
  },
  codex: {
    skill: ["transformed", "skill"],
    command: ["transformed", "skill"],
    hook: ["transformed", "hook"],
    mcp: ["transformed", "mcp"],
    app: ["preserved", "app"],
    agent: undefined,
    lsp: undefined,
    "output-style": undefined,
    monitor: undefined,
    theme: undefined,
    channel: undefined,
    executable: ["preserved", "executable"],
    asset: ["preserved", "asset"],
    settings: undefined,
  },
};

export function targetDisposition({ component, target, targetPolicies }) {
  const supported = SUPPORT[target]?.[component.type];
  if (supported) {
    return {
      status: supported[0],
      reasonCode: supported[0] === "preserved" ? "native-component" :
        component.type === "command" ? "command-to-skill" : "target-translation",
      renderAs: supported[1],
    };
  }
  const reasonCode = targetPolicies[target]?.unsupported?.[component.type];
  if (!reasonCode) {
    throw new Error("missing unsupported policy for " + target + " " + component.type);
  }
  return { status: "unsupported", reasonCode, renderAs: undefined };
}
~~~

- [ ] **Step 4: Implement neutral component copying**

~~~js
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stableJson } from "./json.mjs";

export function copyComponent({ component, neutralRoot }) {
  const destination = resolve(neutralRoot, component.type, component.id);
  if (component.sourceFormat === "inline") {
    mkdirSync(destination, { recursive: true });
    writeFileSync(resolve(destination, "component.json"), stableJson(component.inline));
  } else {
    cpSync(component.sourcePath, destination, { recursive: true });
  }
  return destination;
}
~~~

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Expected: all tests pass.

~~~bash
git add registry/schemas/catalog.schema.json scripts/lib/component-files.mjs scripts/lib/policy.mjs test/unit/policy.test.mjs
git commit -m "feat(registry): account for target component support"
~~~

### Task 5: Generate component accounting and immutable provenance

**Files:**

- Create: `registry/schemas/lock.schema.json`
- Create: `scripts/lib/provenance.mjs`
- Create: `test/unit/provenance.test.mjs`
- Modify: `registry/schemas/agent-plugin.schema.json`
- Modify: `scripts/lib/bundle-builder.mjs`

**Interfaces:**

- Produces: `accountComponents({ components, targets, targetPolicies }): ComponentAccounting[]`
- Produces: `createLockEntry({ plugin, source, bundleRoot, components, targets, generatorDigest }): LockEntry`
- Produces: `assertVersionChange({ previousEntry, nextEntry }): void`

- [ ] **Step 1: Write failing accounting and version tests**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { assertVersionChange } from "../../scripts/lib/provenance.mjs";

test("rejects a changed bundle at the same distribution version", () => {
  assert.throws(() => assertVersionChange({
    previousEntry: { distributionVersion: "1.0.0-gravit.1", bundleDigest: "a".repeat(64) },
    nextEntry: { distributionVersion: "1.0.0-gravit.1", bundleDigest: "b".repeat(64) },
  }), /bundle changed without distributionVersion bump/);
});

test("accepts unchanged content or a bumped version", () => {
  assert.doesNotThrow(() => assertVersionChange({
    previousEntry: { distributionVersion: "1.0.0-gravit.1", bundleDigest: "a".repeat(64) },
    nextEntry: { distributionVersion: "1.0.0-gravit.2", bundleDigest: "b".repeat(64) },
  }));
});
~~~

- [ ] **Step 2: Run and verify the missing module**

Run: `node --test test/unit/provenance.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement version collision and lock creation**

~~~js
import { treeHash } from "./hash.mjs";

export function assertVersionChange({ previousEntry, nextEntry }) {
  if (!previousEntry) return;
  if (
    previousEntry.distributionVersion === nextEntry.distributionVersion &&
    previousEntry.bundleDigest !== nextEntry.bundleDigest
  ) {
    throw new Error("bundle changed without distributionVersion bump");
  }
}

export function createLockEntry({
  plugin,
  source,
  bundleRoot,
  components,
  targets,
  generatorDigest,
}) {
  return {
    name: plugin.name,
    distributionVersion: plugin.distributionVersion,
    source,
    generatorDigest,
    bundleDigest: treeHash(bundleRoot),
    components: components.map((component) => ({
      id: component.id,
      type: component.type,
      digest: component.digest,
      targets: Object.fromEntries(
        Object.entries(targets).map(([target, result]) => [
          target,
          result.components[component.id],
        ]),
      ),
    })),
    targets: Object.fromEntries(
      Object.entries(targets).map(([name, target]) => [name, target.digest]),
    ),
  };
}
~~~

- [ ] **Step 4: Expand the schemas and bundle builder**

Update the neutral manifest component schema to allow all global component types and require:

~~~json
{
  "targets": {
    "type": "object",
    "additionalProperties": {
      "type": "object",
      "additionalProperties": false,
      "required": ["status", "reasonCode"],
      "properties": {
        "status": {
          "enum": ["preserved", "transformed", "unsupported", "rejected"]
        },
        "reasonCode": { "type": "string" },
        "path": { "type": "string" }
      }
    }
  }
}
~~~

Update `buildPluginBundle` to call `inventorySource`, copy every component under `components/`, calculate every target disposition before rendering, and write the neutral manifest only after every target result contains one entry per component ID. Add this hard gate:

~~~js
for (const component of neutralComponents) {
  for (const target of plugin.targets) {
    if (!targetResults[target].components[component.id]) {
      throw new Error(
        plugin.name + ": unaccounted component " + component.type + ":" + component.id +
        " for " + target,
      );
    }
  }
}
~~~

- [ ] **Step 5: Define and validate the lock schema**

The lock root requires `schemaVersion: 1`, `generatorDigest`, and a name-keyed `plugins` object. Each plugin requires source, distributionVersion, bundleDigest, components, and target digests. All digests use `^[a-f0-9]{64}$`; GitHub source SHAs use `^[a-f0-9]{40}$`. Set `additionalProperties: false` on every defined object except name-keyed maps.

- [ ] **Step 6: Run tests and commit**

Run: `npm test`

Expected: all tests pass, including the version collision.

~~~bash
git add registry/schemas/agent-plugin.schema.json registry/schemas/lock.schema.json scripts/lib/provenance.mjs scripts/lib/bundle-builder.mjs test/unit/provenance.test.mjs
git commit -m "feat(registry): lock component provenance"
~~~

### Task 6: Render complete Claude and Codex target bundles

**Files:**

- Modify: `scripts/lib/json.mjs`
- Modify: `scripts/lib/component-files.mjs`
- Modify: `scripts/lib/targets/claude.mjs`
- Modify: `scripts/lib/targets/codex.mjs`
- Create: `test/unit/component-files.test.mjs`
- Create: `test/integration/component-targets.test.mjs`

**Interfaces:**

- Both adapters consume `{ plugin, inventory, neutralComponents, bundleRoot }`.
- Both return `{ digest, components: Record<componentId, Disposition> }`.
- Claude manifest lives at `targets/claude/.claude-plugin/plugin.json` and uses paths relative to that standalone target root.
- Codex manifest lives at `targets/codex/.codex-plugin/plugin.json` and uses paths relative to that standalone target root.

- [ ] **Step 1: Write the failing target integration test**

Build `complete-plugin` with target policies that mark Claude app and Codex agent/LSP/style/monitor/theme/channel/settings unsupported. Assert:

~~~js
assert.equal(claudeManifest.skills, "./skills/");
assert.equal(claudeManifest.mcpServers, "./.mcp.json");
assert.equal(claudeManifest.hooks, "./hooks/hooks.json");
assert.equal(claudeManifest.lspServers, "./.lsp.json");
assert.deepEqual(claudeManifest.commands, ["./commands/release.md"]);
assert.deepEqual(claudeManifest.agents, ["./agents/reviewer.md"]);
assert.equal(existsSync(resolve(bundleRoot, "targets/claude/assets/icon.svg")), true);

assert.equal(codexManifest.skills, "./skills/");
assert.equal(codexManifest.mcpServers, "./.mcp.json");
assert.equal(codexManifest.apps, "./.app.json");
assert.equal(codexManifest.hooks, "./hooks/hooks.json");
assert.equal(existsSync(resolve(bundleRoot, "targets/codex/assets/icon.svg")), true);
assert.deepEqual(codexManifest.interface.defaultPrompt, [
  "Use complete to help with this task.",
]);
~~~

Also recursively inspect `targets/codex/skills` and assert that a converted command has a unique skill name `release`.

Add this focused collision test in `test/unit/component-files.test.mjs`:

~~~js
test("command-to-skill refuses an existing target skill name", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "command-skill-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "release"), { recursive: true });
  assert.throws(() => commandToSkill({
    component: {
      sourcePath: resolve(completeFixtureRoot, "commands/release.md"),
    },
    destinationRoot: root,
  }), /duplicate target skill name: release/);
});
~~~

- [ ] **Step 2: Run and verify the missing component output**

Run: `node --test test/integration/component-targets.test.mjs`

Expected: FAIL because the adapters still render skills only.

- [ ] **Step 3: Complete the Claude adapter**

Render native component paths under `targets/claude`, use `writeMcpConfig` and `renderHooks`, preserve executable mode bits, and set only fields whose components exist. Write `settings.json` and `bin/` directly in that target root so Claude's conventional discovery works. Write the following manifest to `targets/claude/.claude-plugin/plugin.json`:

~~~js
const manifest = {
  name: plugin.name,
  version: plugin.distributionVersion,
  description: plugin.description,
  author: { name: plugin.author || "Gravit Cloud" },
  skills: skillCount ? "./skills/" : undefined,
  commands: commandPaths,
  agents: agentPaths,
  hooks: hookCount ? "./hooks/hooks.json" : undefined,
  mcpServers: mcpCount ? "./.mcp.json" : undefined,
  lspServers: lspCount ? "./.lsp.json" : undefined,
  outputStyles: outputStylePaths,
  channels: channelPaths,
  experimental: {
    themes: themeCount ? "./themes/" : undefined,
    monitors: monitorCount ? "./monitors/monitors.json" : undefined,
  },
};
~~~

Add and export this shared helper from `scripts/lib/json.mjs`, then pass the manifest through it before `writeJson`:

~~~js
export function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, removeUndefined(entry)]),
    );
  }
  return value;
}
~~~

Copy preserved asset components into `targets/claude/assets/` without changing their relative layout.

- [ ] **Step 4: Complete the Codex adapter**

Add this shared renderer to `scripts/lib/component-files.mjs` and use it from the Codex adapter. It converts commands to valid `skills/<name>/SKILL.md`, parses the command frontmatter using Plan 1's parser, derives the normalized name from the source filename, and preserves the Markdown body:

~~~js
export function commandToSkill({ component, destinationRoot }) {
  const source = readFileSync(component.sourcePath, "utf8");
  const parsed = parseFrontmatter(source);
  const name = basename(component.sourcePath, extname(component.sourcePath))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!name) throw new Error("command filename does not produce a valid skill name");
  const description = parsed.attributes.description || "Run the " + name + " command";
  const directory = resolve(destinationRoot, name);
  if (existsSync(directory)) {
    throw new Error("duplicate target skill name: " + name);
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "SKILL.md"),
    "---\\nname: " + name + "\\ndescription: " + JSON.stringify(description) +
      "\\n---\\n" + parsed.body,
  );
  return name;
}
~~~

Write MCP using the wrapped `mcp_servers` form, write transformed hooks, preserve `.app.json`, copy preserved assets into `targets/codex/assets/`, and write this manifest to `targets/codex/.codex-plugin/plugin.json`:

~~~js
const manifest = {
  name: plugin.name,
  version: plugin.distributionVersion,
  description: plugin.description,
  author: { name: plugin.author || "Gravit Cloud" },
  skills: "./skills/",
  mcpServers: mcpCount ? "./.mcp.json" : undefined,
  apps: appCount ? "./.app.json" : undefined,
  hooks: hookCount ? "./hooks/hooks.json" : undefined,
  interface: {
    displayName: plugin.displayName || plugin.name,
    shortDescription: plugin.description.slice(0, 110),
    longDescription: plugin.description,
    developerName: plugin.author || "Gravit Cloud",
    category: CATEGORY[plugin.category],
    capabilities: [],
    defaultPrompt: ["Use " + (plugin.displayName || plugin.name) + " to help with this task."],
  },
};
~~~

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Expected: all target manifest and recursive uniqueness checks pass.

~~~bash
git add scripts/lib/json.mjs scripts/lib/component-files.mjs scripts/lib/targets scripts/lib/bundle-builder.mjs test/unit/component-files.test.mjs test/integration/component-targets.test.mjs
git commit -m "feat(registry): render complete Claude and Codex bundles"
~~~

### Task 7: Migrate the production catalog and local source

**Files:**

- Create: `registry/catalog.json`
- Move: `plugins/gravit-custom/**` to `sources/gravit-custom/**`
- Modify: `scripts/set-version.mjs`
- Modify: `build.sh`
- Modify: `package.json`
- Modify: `scripts/build-registry.mjs`
- Modify: `scripts/lib/atomic-output.mjs`
- Replace: `scripts/sync-plugins.mjs`
- Modify: `test/unit/artifacts.test.mjs`
- Create: `test/integration/production-catalog.test.mjs`

**Interfaces:**

- Production command remains `npm run plugins:sync`.
- `buildRegistry` accepts separate staged roots for bundles, marketplaces, and lock data, then promotes them together.
- Local source is always `sources/gravit-custom`; `plugins/gravit-custom` becomes generated.

- [ ] **Step 1: Write the production catalog**

Before adding the production catalog, change the local-source schema pattern from `^test/fixtures/` to `^(?:sources|test/fixtures)/`. Keep the boundary check in `stageSource`; the regex is not a substitute for canonical path validation.

Create all six existing entries using current refs and SHAs from `.claude-plugin/marketplace.json`. Use these distribution versions:

~~~text
claude-seo        2.2.4-gravit.1
obsidian          1.0.1-gravit.1
mattpocock-skills 1.1.0-gravit.1
azure             1.2.5-gravit.1
superpowers       6.2.0-gravit.1
gravit-custom     1.0.0-gravit.1
~~~

For Azure add:

~~~json
{
  "runtimeDependencies": {
    "@azure/mcp": "2.0.5"
  },
  "targetPolicies": {
    "codex": {
      "unsupported": {
        "agent": "host-does-not-load-agents",
        "lsp": "host-does-not-load-lsp",
        "monitor": "host-does-not-load-monitors",
        "output-style": "host-does-not-load-output-styles",
        "theme": "host-does-not-load-themes",
        "channel": "host-does-not-load-channels",
        "settings": "host-does-not-load-settings"
      }
    },
    "claude": {
      "unsupported": {
        "app": "host-uses-mcp-without-app-binding"
      }
    }
  }
}
~~~

Apply the same host-limit map to other entries when their inventories contain those types. Do not add unsupported entries for types absent from a plugin.

- [ ] **Step 2: Move the local canonical source**

Run:

~~~bash
mkdir -p sources
git mv plugins/gravit-custom sources/gravit-custom
~~~

Update `scripts/set-version.mjs` and `build.sh` to read `sources/gravit-custom` for maintained source and `plugins/gravit-custom` only after sync for generated archives.

- [ ] **Step 3: Write the failing catalog integration test**

~~~js
test("production catalog is neutral and fully pinned", () => {
  const catalog = loadCatalog({
    repositoryRoot,
    catalogPath: "registry/catalog.json",
  });
  assert.deepEqual(catalog.plugins.map((plugin) => plugin.name), [
    "claude-seo",
    "obsidian",
    "mattpocock-skills",
    "azure",
    "superpowers",
    "gravit-custom",
  ]);
  for (const plugin of catalog.plugins.filter(({ source }) => source.type === "github")) {
    assert.match(plugin.source.sha, /^[a-f0-9]{40}$/);
  }
  assert.equal(
    catalog.plugins.find(({ name }) => name === "azure")
      .runtimeDependencies["@azure/mcp"],
    "2.0.5",
  );
});
~~~

- [ ] **Step 4: Replace the production orchestrator**

Reduce `scripts/sync-plugins.mjs` to:

~~~js
#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "./build-registry.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

buildRegistry({
  repositoryRoot,
  catalogPath: "registry/catalog.json",
  outputRoot: repositoryRoot,
  production: true,
});
~~~

In production mode, `buildRegistry` must stage only the managed paths under a temporary sibling directory, validate them, then promote:

~~~text
plugins/
.claude-plugin/marketplace.json
.agents/plugins/marketplace.json
registry/lock.json
~~~

Never atomically rename the repository root. Implement a `promoteManagedPaths` function that backs up and replaces only these four exact targets, rolls all four back if any rename fails, and removes the backups only after success.

Add this failing transaction test to `test/unit/artifacts.test.mjs` before implementing the helper:

~~~js
test("promoteManagedPaths rolls every managed path back after a mid-promotion failure", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  for (const root of [repositoryRoot, stageRoot]) {
    for (const path of MANAGED_REGISTRY_PATHS) {
      const file = path.endsWith(".json") ? resolve(root, path) : resolve(root, path, "marker.txt");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, (root === repositoryRoot ? "old:" : "new:") + path + "\n");
    }
  }
  let stagedRenames = 0;
  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      if (from.startsWith(stageRoot) && ++stagedRenames === 3) {
        throw new Error("synthetic promotion failure");
      }
      renameSync(from, to);
    },
  }), /synthetic promotion failure/);
  for (const path of MANAGED_REGISTRY_PATHS) {
    const file = path.endsWith(".json")
      ? resolve(repositoryRoot, path)
      : resolve(repositoryRoot, path, "marker.txt");
    assert.equal(readFileSync(file, "utf8"), "old:" + path + "\n");
  }
});
~~~

Implement the transaction in `scripts/lib/atomic-output.mjs`:

~~~js
export const MANAGED_REGISTRY_PATHS = [
  "plugins",
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  "registry/lock.json",
];

export function promoteManagedPaths({
  repositoryRoot,
  stageRoot,
  rename = renameSync,
}) {
  const pending = MANAGED_REGISTRY_PATHS.map((relativePath, index) => {
    const source = assertInside(stageRoot, resolve(stageRoot, relativePath), "staged artifact");
    const target = assertInside(repositoryRoot, resolve(repositoryRoot, relativePath), "managed artifact");
    if (!existsSync(source)) throw new Error("missing staged artifact: " + relativePath);
    return { relativePath, source, target, index, hadTarget: existsSync(target), promoted: false };
  });
  const transactionRoot = mkdtempSync(resolve(
    dirname(repositoryRoot),
    "." + basename(repositoryRoot) + ".promote-",
  ));
  try {
    for (const item of pending) {
      item.backup = resolve(transactionRoot, "backup", String(item.index));
      mkdirSync(dirname(item.backup), { recursive: true });
      mkdirSync(dirname(item.target), { recursive: true });
      if (item.hadTarget) rename(item.target, item.backup);
      rename(item.source, item.target);
      item.promoted = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...pending].reverse()) {
      try {
        if (item.promoted && existsSync(item.target)) {
          rmSync(item.target, { recursive: true, force: true });
        }
        if (item.hadTarget && item.backup && existsSync(item.backup) && !existsSync(item.target)) {
          renameSync(item.backup, item.target);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors],
        "registry promotion and rollback failed; backups remain at " + transactionRoot);
    }
    rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }
  rmSync(transactionRoot, { recursive: true, force: true });
}
~~~

Import `assertInside` from `path-safety.mjs` and the required filesystem/path functions. The preflight resolves and checks all four staged paths before moving any existing target. Keep the transaction directory when rollback itself fails so recovery data is not destroyed.

- [ ] **Step 5: Generate both marketplaces from the catalog**

Claude entries use `./plugins/<name>/targets/claude` local sources. Codex entries keep:

~~~json
{
  "source": {
    "source": "local",
    "path": "./plugins/azure/targets/codex"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Cloud"
}
~~~

Generate equivalent entries for all catalog plugins; never copy source pins back into either target marketplace.

- [ ] **Step 6: Add production scripts**

Set:

~~~json
{
  "scripts": {
    "plugins:sync": "node scripts/sync-plugins.mjs",
    "plugins:verify": "node scripts/validate.mjs",
    "registry:build:foundation": "node scripts/build-registry.mjs --catalog test/fixtures/skill-only-catalog.json --output .tmp/registry-foundation"
  }
}
~~~

- [ ] **Step 7: Run local tests without the network sync**

Run:

~~~bash
npm test
node --check scripts/sync-plugins.mjs
bash -n build.sh
git diff --check
~~~

Expected: all commands exit 0.

- [ ] **Step 8: Commit the catalog cutover code before generated output**

~~~bash
git add registry/catalog.json sources/gravit-custom scripts package.json build.sh test/unit/artifacts.test.mjs test/integration/production-catalog.test.mjs
git commit -m "refactor(registry): make neutral catalog authoritative"
~~~

### Task 8: Replace blind validation with recursive offline verification

**Files:**

- Replace: `scripts/validate.mjs`
- Create: `scripts/lib/validator.mjs`
- Create: `test/unit/validator.test.mjs`

**Interfaces:**

- Produces: `validateRepository({ repositoryRoot, compareLock }): string[]`
- Produces: `validateRecursiveSkills(targetSkillsRoot): string[]`
- CLI exits 1 and prints one error per line when any error exists.

- [ ] **Step 1: Write a failing nested-duplicate test**

Copy a valid target into a temp root, add `skills/parent/copied-child/SKILL.md` with `name: child`, then assert:

~~~js
assert.deepEqual(
  validateRecursiveSkills(skillsRoot).filter((error) => error.includes("duplicate skill name")),
  ["duplicate skill name child: child/SKILL.md, parent/copied-child/SKILL.md"],
);
~~~

Also mutate one component file after the lock digest is calculated and assert `validateRepository` reports `bundle digest mismatch`.

- [ ] **Step 2: Run and verify the missing validator module**

Run: `node --test test/unit/validator.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement recursive skill validation**

Use `walkFiles`, `parseFrontmatter`, and a name-to-relative-path map. Check every `SKILL.md`, including nested files with frontmatter; validate required name and description, target-specific flags, and every relative Markdown link. Sort errors lexicographically before returning them.

- [ ] **Step 4: Implement repository validation**

Perform these exact gates:

~~~text
catalog schema
lock schema
neutral manifest schema for every plugin
catalog names equal lock names equal both marketplace names
local marketplace paths resolve inside repository
every target manifest path resolves inside its plugin bundle
recursive skill name uniqueness per target
every relative Markdown link resolves
every component path and digest matches neutral manifest
every bundle digest matches lock
every lock component has one disposition per configured target
no latest, next, wildcard, absolute checkout path, or non-placeholder env secret
LICENSE exists for every external bundle
all configured exceptions are unexpired
shell and Node syntax checks
~~~

The offline validator must never call curl, giget, npm, npx, Claude, Codex, OpenClaw, Azure, or GitHub.

- [ ] **Step 5: Replace the CLI wrapper**

~~~js
#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRepository } from "./lib/validator.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = validateRepository({ repositoryRoot });
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Registry validation passed.");
~~~

- [ ] **Step 6: Run tests and commit**

Run: `npm test`

Expected: all validator regressions pass.

~~~bash
git add scripts/validate.mjs scripts/lib/validator.mjs test/unit/validator.test.mjs
git commit -m "test(registry): validate all bundled components"
~~~

### Task 9: Regenerate the real registry and prove the Azure fix

**Files:**

- Generate: `registry/lock.json`
- Generate: `plugins/**`
- Generate: `.claude-plugin/marketplace.json`
- Generate: `.agents/plugins/marketplace.json`
- Create: `test/integration/azure-regression.test.mjs`
- Modify: `AGENTS.md`

**Interfaces:**

- Production output contains Azure neutral, Claude, and Codex MCP definitions.
- Production output contains no recursive duplicate skill name.

- [ ] **Step 1: Write the Azure regression test before syncing**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateRecursiveSkills } from "../../scripts/lib/validator.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Azure Codex bundle contains pinned MCP and unique skills", () => {
  const root = resolve(repositoryRoot, "plugins/azure");
  const manifest = JSON.parse(readFileSync(
    resolve(root, "targets/codex/.codex-plugin/plugin.json"),
  ));
  assert.equal(manifest.mcpServers, "./.mcp.json");
  const mcp = readFileSync(resolve(root, "targets/codex/.mcp.json"), "utf8");
  assert.match(mcp, /@azure\/mcp@2\.0\.5/);
  assert.doesNotMatch(mcp, /@latest/);
  assert.deepEqual(
    validateRecursiveSkills(resolve(root, "targets/codex/skills")),
    [],
  );
});
~~~

- [ ] **Step 2: Run the regression and verify the old artifact fails**

Run: `node --test test/integration/azure-regression.test.mjs`

Expected: FAIL because the current Azure manifest lacks `mcpServers`.

- [ ] **Step 3: Run the real network sync**

Run:

~~~bash
npm ci
npm run plugins:sync
~~~

Expected: six plugins are staged, fully validated, and promoted together. Azure reports a nonzero MCP component count.

- [ ] **Step 4: Run the Azure regression and offline verification**

Run:

~~~bash
node --test test/integration/azure-regression.test.mjs
npm test
npm run validate
npm run plugins:verify
~~~

Expected: all commands exit 0.

- [ ] **Step 5: Prove deterministic regeneration**

Run:

~~~bash
npm run plugins:sync
git diff --exit-code -- registry/lock.json .claude-plugin/marketplace.json .agents/plugins/marketplace.json plugins
~~~

Expected: the second sync produces no diff relative to the first generated state.

- [ ] **Step 6: Update repository guidance**

Update `AGENTS.md` to say:

~~~markdown
- `registry/catalog.json` is the only manually maintained plugin catalog and source-pin file.
- `sources/` contains maintained local plugin sources.
- Every directory under `plugins/`, both target marketplaces, and `registry/lock.json` are generated.
- Run `npm run plugins:sync` after catalog or local-source changes and commit all generated outputs together.
- Run `npm test && npm run validate` before committing.
~~~

Remove outdated version tables and the claim that MCP works only when configured outside the plugin.

- [ ] **Step 7: Review generated licenses and component accounting**

Run:

~~~bash
node -e 'const lock=require("./registry/lock.json"); for (const [name,p] of Object.entries(lock.plugins)) console.log(name, p.components.length, Object.keys(p.targets).join(","))'
find plugins -mindepth 2 -maxdepth 2 -name LICENSE -print
~~~

Expected: all six lock entries print; every external plugin has a LICENSE.

- [ ] **Step 8: Commit generated outputs and regression proof**

~~~bash
git add registry/lock.json plugins .claude-plugin/marketplace.json .agents/plugins/marketplace.json test/integration/azure-regression.test.mjs AGENTS.md
git commit -m "fix(registry): preserve Azure MCP and unique skills"
~~~

## Plan 2 Completion Gate

Run:

~~~bash
npm ci
npm test
npm run plugins:sync
npm run validate
npx --no-install @anthropic-ai/claude-code plugin validate .
git diff --exit-code -- registry .claude-plugin .agents plugins sources
git diff --check
git status --short
~~~

Expected:

- all unit and integration tests pass;
- sync is deterministic and leaves no managed diff;
- Claude validates the generated marketplace;
- Azure Codex MCP points to `@azure/mcp@2.0.5`;
- every Codex skill name is recursively unique;
- the only remaining worktree changes are unrelated pre-existing user files.

Do not start distribution work until the generated diff and lock accounting have been reviewed.
