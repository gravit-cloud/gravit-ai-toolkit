import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRegistry } from "../../scripts/build-registry.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";
import { writeJson } from "../../scripts/lib/json.mjs";
import { openRegistry } from "../../scripts/lib/registry-reader.mjs";

function fixtureRegistry(context) {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-reader-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const sourceRoot = resolve(repositoryRoot, "sources/nested-skills");
  mkdirSync(resolve(sourceRoot, "skills/parent/child"), { recursive: true });
  writeFileSync(resolve(sourceRoot, "skills/parent/SKILL.md"), [
    "---",
    "name: parent",
    "description: Parent fixture skill",
    "---",
    "",
    "# Parent",
    "",
  ].join("\n"));
  writeFileSync(resolve(sourceRoot, "skills/parent/child/SKILL.md"), [
    "---",
    "name: child",
    "description: Child fixture skill",
    "---",
    "",
    "# Child",
    "",
  ].join("\n"));
  mkdirSync(resolve(repositoryRoot, "registry"), { recursive: true });
  writeJson(resolve(repositoryRoot, "registry/catalog.json"), {
    schemaVersion: 1,
    name: "fixture-marketplace",
    plugins: [{
      name: "nested-skills",
      description: "Nested skill fixture",
      category: "development",
      distributionVersion: "1.0.0-gravit.1",
      source: { type: "local", path: "sources/nested-skills", root: "." },
      targets: ["claude", "codex", "openclaw"],
      adapterOptions: { openclaw: { bundleFormat: "codex" } },
      targetPolicies: {
        openclaw: {
          unsupported: { hook: "openclaw-does-not-run-claude-hook-json" },
        },
      },
      policies: { default: "transform-or-fail", skills: "transform" },
    }],
  });
  buildRegistry({
    repositoryRoot,
    catalogPath: "registry/catalog.json",
    outputRoot: repositoryRoot,
    production: true,
  });
  return repositoryRoot;
}

function copyFixtureRegistry(context) {
  const source = fixtureRegistry(context);
  const parent = mkdtempSync(resolve(tmpdir(), "registry-reader-copy-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const copy = resolve(parent, "repository");
  cpSync(source, copy, { recursive: true });
  return copy;
}

function runCli(...args) {
  return spawnSync(process.execPath, ["scripts/registry.mjs", ...args], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });
}

test("list returns locked versions and configured targets", (context) => {
  const fixtureRegistryRoot = fixtureRegistry(context);
  const fixtureBundleDigest = treeHash(resolve(
    fixtureRegistryRoot,
    "plugins/nested-skills",
  ));
  const reader = openRegistry(fixtureRegistryRoot);

  assert.deepEqual(reader.list(), [{
    name: "nested-skills",
    distributionVersion: "1.0.0-gravit.1",
    targets: ["claude", "codex", "openclaw"],
    bundleDigest: fixtureBundleDigest,
  }]);
});

test("verify reports a mutated bundle file", (context) => {
  const root = copyFixtureRegistry(context);
  appendFileSync(
    resolve(root, "plugins/nested-skills/targets/codex/skills/parent/SKILL.md"),
    "\nmutation\n",
  );

  assert.deepEqual(openRegistry(root).verify("nested-skills").errors, [
    "nested-skills: bundle digest mismatch",
  ]);
});

test("inspect refuses details when committed bundle bytes fail verification", (context) => {
  const root = copyFixtureRegistry(context);
  appendFileSync(
    resolve(root, "plugins/nested-skills/targets/openclaw/skills/parent/SKILL.md"),
    "\nmutation\n",
  );

  assert.throws(
    () => openRegistry(root).inspect("nested-skills"),
    /nested-skills: bundle digest mismatch/,
  );
});

test("verify retains offline host validation after a changed bundle digest is relocked", (context) => {
  const root = copyFixtureRegistry(context);
  const hostPath = resolve(
    root,
    "plugins/nested-skills/targets/codex/.codex-plugin/plugin.json",
  );
  const host = JSON.parse(readFileSync(hostPath, "utf8"));
  host.version = "9.9.9";
  writeJson(hostPath, host);
  const manifestPath = resolve(root, "plugins/nested-skills/.agent-plugin/plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const targetDigest = treeHash(resolve(root, "plugins/nested-skills/targets/codex"));
  manifest.targets.codex.digest = targetDigest;
  writeJson(manifestPath, manifest);
  const lockPath = resolve(root, "registry/lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.plugins["nested-skills"].targets.codex = targetDigest;
  lock.plugins["nested-skills"].bundleDigest = treeHash(resolve(
    root,
    "plugins/nested-skills",
  ));
  writeJson(lockPath, lock);

  assert.equal(openRegistry(root).verify("nested-skills").ok, false);
  assert.match(
    openRegistry(root).verify("nested-skills").errors.join("\n"),
    /nested-skills codex: host manifest version mismatch/,
  );
});

test("reader rejects unsafe plugin names and catalog-lock disagreement", (context) => {
  const root = copyFixtureRegistry(context);
  const reader = openRegistry(root);
  assert.throws(() => reader.inspect("__proto__"), /prototype registry name/);

  const catalogPath = resolve(root, "registry/catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  catalog.plugins[0].targets = ["claude", "codex"];
  writeJson(catalogPath, catalog);
  assert.throws(() => openRegistry(root).list(), /configured targets/);
});

test("CLI rejects malformed command lines without materializing bundles", () => {
  for (const args of [
    ["materialize"],
    ["list", "--plugin", "nested-skills"],
    ["inspect", "--plugin", "nested-skills", "--plugin", "nested-skills"],
    ["verify", "--plugin", "__proto__"],
  ]) {
    const result = runCli(...args);
    assert.notEqual(result.status, 0, `${args.join(" ")} should fail`);
  }
});
