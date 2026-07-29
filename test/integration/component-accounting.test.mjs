import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import { buildPluginBundle } from "../../scripts/lib/bundle-builder.mjs";
import { sha256, treeHash } from "../../scripts/lib/hash.mjs";
import { createLockEntry } from "../../scripts/lib/provenance.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const completeFixture = resolve(repositoryRoot, "test/fixtures/complete-plugin");
const allTypes = [
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
  "skill",
  "theme",
];

function completePlugin() {
  return {
    name: "complete",
    description: "Complete component fixture",
    category: "development",
    distributionVersion: "1.0.0-gravit.1",
    runtimeDependencies: { "@fixture/mcp": "1.2.3" },
    source: {
      type: "local",
      path: "test/fixtures/complete-plugin",
      root: ".",
    },
    targets: ["codex", "claude"],
    policies: { default: "transform-or-fail", skills: "transform" },
    targetPolicies: {
      claude: { unsupported: { app: "host-does-not-load-apps" } },
      codex: {
        unsupported: {
          agent: "host-does-not-load-agents",
          lsp: "host-does-not-load-lsp",
          "output-style": "host-does-not-load-output-styles",
          monitor: "host-does-not-load-monitors",
          theme: "host-does-not-load-themes",
          channel: "host-does-not-load-channels",
          settings: "host-does-not-load-settings",
        },
      },
    },
  };
}

function sandbox(context, prefix = "component-accounting-") {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, bundleRoot: resolve(root, "bundle") };
}

function validateManifest(manifest) {
  const schema = JSON.parse(readFileSync(
    resolve(repositoryRoot, "registry/schemas/agent-plugin.schema.json"),
    "utf8",
  ));
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
}

test("materializes every inventory component and accounts for it on every target", (context) => {
  const { bundleRoot } = sandbox(context);
  const plugin = completePlugin();
  const before = structuredClone(plugin);

  const manifest = buildPluginBundle({
    plugin,
    sourceRoot: completeFixture,
    bundleRoot,
  });

  assert.deepEqual(plugin, before);
  assert.deepEqual(
    [...new Set(manifest.components.map(({ type }) => type))].sort(),
    allTypes,
  );
  assert.equal(manifest.components.length, 14);
  assert.deepEqual(
    manifest.components.map(({ id }) => id),
    [...manifest.components.map(({ id }) => id)].sort(),
  );

  const componentIds = manifest.components.map(({ id }) => id);
  for (const component of manifest.components) {
    const materialized = resolve(bundleRoot, component.path);
    assert.equal(existsSync(materialized), true, component.type + ":" + component.id);
    assert.equal(component.digest, treeHash(materialized));
    assert.deepEqual(Object.keys(component.targets), ["claude", "codex"]);
    assert.equal(JSON.stringify(component.targets).includes("renderAs"), false);
    for (const target of ["claude", "codex"]) {
      assert.deepEqual(
        manifest.targets[target].components[component.id],
        component.targets[target],
      );
      if (["unsupported", "rejected"].includes(component.targets[target].status)) {
        assert.equal(Object.hasOwn(component.targets[target], "path"), false);
      } else {
        assert.equal(existsSync(resolve(bundleRoot, component.targets[target].path)), true);
      }
    }
  }

  assert.deepEqual(Object.keys(manifest.targets), ["claude", "codex"]);
  for (const target of ["claude", "codex"]) {
    const result = manifest.targets[target];
    assert.equal(result.path, "targets/" + target);
    assert.equal(result.digest, treeHash(resolve(bundleRoot, result.path)));
    assert.deepEqual(Object.keys(result.components), componentIds);
  }
  validateManifest(manifest);

  const lockEntry = createLockEntry({
    plugin,
    source: plugin.source,
    bundleRoot,
    components: manifest.components.map(({ id, type, digest }) => ({ id, type, digest })),
    targets: manifest.targets,
    generatorDigest: "d".repeat(64),
  });
  assert.deepEqual(lockEntry.targets, {
    claude: manifest.targets.claude.digest,
    codex: manifest.targets.codex.digest,
  });
  assert.equal(lockEntry.components.length, manifest.components.length);
  assert.equal(lockEntry.bundleDigest, treeHash(bundleRoot));
});

test("duplicate component IDs fail before a neutral manifest is exposed", (context) => {
  const { root, bundleRoot } = sandbox(context, "component-duplicate-");
  const sourceRoot = resolve(root, "source");
  const duplicateId = "asset-" + sha256("assets").slice(0, 12);
  mkdirSync(resolve(sourceRoot, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(sourceRoot, "skills/duplicate"), { recursive: true });
  mkdirSync(resolve(sourceRoot, "assets"), { recursive: true });
  writeFileSync(
    resolve(sourceRoot, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "duplicate", version: "1.0.0" }),
  );
  writeFileSync(
    resolve(sourceRoot, "skills/duplicate/SKILL.md"),
    "---\nname: " + duplicateId + "\ndescription: Duplicate ID fixture\n---\n",
  );
  writeFileSync(resolve(sourceRoot, "assets/icon.svg"), "<svg/>\n");
  const plugin = completePlugin();
  plugin.name = "duplicate";
  plugin.targets = ["claude"];
  plugin.targetPolicies = {};

  assert.throws(
    () => buildPluginBundle({ plugin, sourceRoot, bundleRoot }),
    new RegExp("duplicate component id: " + duplicateId),
  );
  assert.equal(existsSync(resolve(bundleRoot, ".agent-plugin/plugin.json")), false);
});

test("an accounting failure leaves no neutral manifest", (context) => {
  const { bundleRoot } = sandbox(context, "component-unaccounted-");
  const plugin = completePlugin();
  plugin.targetPolicies.codex.unsupported = {};

  assert.throws(
    () => buildPluginBundle({ plugin, sourceRoot: completeFixture, bundleRoot }),
    /missing unsupported policy for codex agent/,
  );
  assert.equal(existsSync(resolve(bundleRoot, ".agent-plugin/plugin.json")), false);
});
