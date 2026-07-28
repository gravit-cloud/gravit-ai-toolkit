import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventorySource } from "../../scripts/lib/inventory.mjs";
import { sha256, treeHash } from "../../scripts/lib/hash.mjs";
import { stableJson } from "../../scripts/lib/json.mjs";

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
  assert.equal(inventory.components.length, 13);
  assert.equal(
    new Set(inventory.components.map((component) => component.type + ":" + component.id)).size,
    inventory.components.length,
  );
  assert.deepEqual(inventory.skills.map((skill) => skill.name), ["fixture"]);
  assert.deepEqual(
    inventory.components.map((component) => component.type + ":" + component.id),
    [...inventory.components]
      .map((component) => component.type + ":" + component.id)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  );
  for (const component of inventory.components) {
    assert.match(component.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.match(component.digest, /^[a-f0-9]{64}$/);
    assert.equal(component.sourceFormat, "path");
    assert.equal(component.inline, undefined);
    assert.equal(component.digest, treeHash(component.sourcePath));
    assert.doesNotMatch(component.metadata.relativePath, /\\/);
  }
});

test("expands string, array, and inline component declarations without duplicate paths", () => {
  const manifests = inventorySource({ sourceRoot: fixture }).manifests;
  const inlineCommand = { name: "inline-release", prompt: "Release safely" };
  const inventory = inventorySource({
    sourceRoot: fixture,
    manifestOverrides: {
      claude: {
        ...manifests.claude,
        commands: ["./commands/release.md", inlineCommand, "commands/release.md"],
      },
      codex: {
        ...manifests.codex,
        apps: ["./.app.json", { apps: { inline: "plugin_asdk_app_inline" } }],
      },
    },
  });
  const commands = inventory.components.filter(({ type }) => type === "command");
  const apps = inventory.components.filter(({ type }) => type === "app");

  assert.equal(commands.length, 2);
  assert.deepEqual(commands.map(({ sourceFormat }) => sourceFormat).sort(), ["inline", "path"]);
  const inlineCommandRecord = commands.find(({ sourceFormat }) => sourceFormat === "inline");
  assert.deepEqual(inlineCommandRecord.inline, inlineCommand);
  assert.equal(inlineCommandRecord.digest, sha256(stableJson(inlineCommand)));
  assert.deepEqual(inlineCommandRecord.metadata, {});
  assert.equal(apps.length, 2);
  assert.deepEqual(apps.map(({ sourceFormat }) => sourceFormat).sort(), ["inline", "path"]);
});

test("honors an explicit declared skill selection", () => {
  assert.deepEqual(
    inventorySource({
      sourceRoot: fixture,
      declaredSkills: "./skills/fixture",
    }).skills.map((skill) => skill.name),
    ["fixture"],
  );
  assert.throws(
    () => inventorySource({ sourceRoot: fixture, declaredSkills: "../outside" }),
    /declared skill escapes source root/,
  );
});

test("rejects unknown Claude, experimental, and Codex component fields", () => {
  const manifests = inventorySource({ sourceRoot: fixture }).manifests;
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        claude: { ...manifests.claude, unknownRuntime: "./runtime.json" },
      },
    }),
    /unknown Claude component field: unknownRuntime/,
  );
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        claude: {
          ...manifests.claude,
          experimental: { ...manifests.claude.experimental, daemons: "./daemons/" },
        },
      },
    }),
    /unknown Claude experimental component field: daemons/,
  );
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        codex: { ...manifests.codex, runtimes: "./runtimes.json" },
      },
    }),
    /unknown Codex component field: runtimes/,
  );
});

test("rejects malformed inline payloads and escaping component paths", () => {
  const manifests = inventorySource({ sourceRoot: fixture }).manifests;
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        claude: { ...manifests.claude, commands: [42] },
      },
    }),
    /command component must be a path or inline object/,
  );
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        claude: { ...manifests.claude, commands: "../outside.md" },
      },
    }),
    /command component escapes source root/,
  );
});

test("rejects component roots and nested files reached through symbolic links", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "inventory-symlink-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  const outside = resolve(root, "outside");
  mkdirSync(resolve(source, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(source, "assets"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(resolve(outside, "component.json"), "{}\n");
  writeFileSync(
    resolve(source, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", commands: "./linked" }),
  );
  symlinkSync(outside, resolve(source, "linked"));

  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /command component escapes source root|symbolic links are not allowed/,
  );

  rmSync(resolve(source, "linked"));
  writeFileSync(
    resolve(source, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  symlinkSync(resolve(outside, "component.json"), resolve(source, "assets/linked.json"));
  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /symbolic links are not allowed in staged components/,
  );
});

test("inventorying executable content never runs it", () => {
  const helper = resolve(fixture, "bin/helper");
  const before = readFileSync(helper, "utf8");
  const executable = inventorySource({ sourceRoot: fixture }).components
    .find(({ type }) => type === "executable");

  assert.equal(executable.metadata.relativePath, "bin");
  assert.equal(readFileSync(helper, "utf8"), before);
});
