import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "../../scripts/build-registry.mjs";
import { promoteManagedPaths } from "../../scripts/lib/atomic-output.mjs";
import { loadCatalog } from "../../scripts/lib/catalog.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedPluginNames = [
  "claude-seo",
  "obsidian",
  "mattpocock-skills",
  "azure",
  "superpowers",
  "gravit-custom",
];

function sandboxRepository(context) {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-production-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = resolve(parent, "repository");
  const skillRoot = resolve(root, "sources/local-plugin/skills/local-skill");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    resolve(skillRoot, "SKILL.md"),
    "---\nname: local-skill\ndescription: Local production fixture\n---\n\n# Local\n",
  );
  mkdirSync(resolve(root, "registry"), { recursive: true });
  writeFileSync(resolve(root, "README.md"), "unrelated\n");
  writeFileSync(resolve(root, "registry/catalog.json"), JSON.stringify({
    schemaVersion: 1,
    name: "fixture-marketplace",
    plugins: [{
      name: "local-plugin",
      description: "Local production plugin",
      category: "development",
      distributionVersion: "1.0.0-gravit.1",
      source: { type: "local", path: "sources/local-plugin", root: "." },
      targets: ["claude", "codex"],
      policies: { default: "transform-or-fail", skills: "transform" },
    }],
  }));
  return { parent, repositoryRoot: root };
}

test("production catalog is neutral and fully pinned", () => {
  const catalog = loadCatalog({
    repositoryRoot,
    catalogPath: "registry/catalog.json",
  });

  assert.deepEqual(catalog.plugins.map((plugin) => plugin.name), expectedPluginNames);
  assert.deepEqual(
    catalog.plugins.map((plugin) => plugin.distributionVersion),
    [
      "2.2.4-gravit.1",
      "1.0.1-gravit.1",
      "1.1.0-gravit.1",
      "1.2.5-gravit.1",
      "6.2.0-gravit.1",
      "1.0.0-gravit.1",
    ],
  );
  for (const plugin of catalog.plugins.filter(({ source }) => source.type === "github")) {
    assert.match(plugin.source.sha, /^[a-f0-9]{40}$/);
    assert.equal(typeof plugin.source.ref, "string");
    assert.equal(plugin.source.ref.length > 0, true);
  }
  assert.deepEqual(
    catalog.plugins.slice(0, 5).map(({ name, source }) => ({ name, source })),
    [
      {
        name: "claude-seo",
        source: {
          type: "github",
          repo: "AgricIDaniel/claude-seo",
          ref: "v2.2.4",
          sha: "6b63c8bb7b2e8e4480060604555e3af629b54c2c",
          root: ".",
        },
      },
      {
        name: "obsidian",
        source: {
          type: "github",
          repo: "kepano/obsidian-skills",
          ref: "main",
          sha: "a1dc48e68138490d522c04cbf5822214c6eb1202",
          root: ".",
        },
      },
      {
        name: "mattpocock-skills",
        source: {
          type: "github",
          repo: "mattpocock/skills",
          ref: "v1.1.0",
          sha: "d574778f94cf620fcc8ce741584093bc650a61d3",
          root: ".",
        },
      },
      {
        name: "azure",
        source: {
          type: "github",
          repo: "microsoft/azure-skills",
          ref: "v1.2.5",
          sha: "013b97d8aab03ce8cd88944976e9988f8c829746",
          root: ".",
        },
      },
      {
        name: "superpowers",
        source: {
          type: "github",
          repo: "obra/superpowers",
          ref: "v6.2.0",
          sha: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
          root: ".",
        },
      },
    ],
  );
  const azure = catalog.plugins.find(({ name }) => name === "azure");
  assert.equal(azure.runtimeDependencies["@azure/mcp"], "2.0.5");
  assert.deepEqual(azure.targetPolicies, {
    claude: { unsupported: { app: "host-uses-mcp-without-app-binding" } },
    codex: {
      unsupported: {
        agent: "host-does-not-load-agents",
        channel: "host-does-not-load-channels",
        lsp: "host-does-not-load-lsp",
        monitor: "host-does-not-load-monitors",
        "output-style": "host-does-not-load-output-styles",
        settings: "host-does-not-load-settings",
        theme: "host-does-not-load-themes",
      },
    },
  });
  assert.deepEqual(catalog.plugins.at(-1).source, {
    type: "local",
    path: "sources/gravit-custom",
    root: ".",
  });
  for (const plugin of catalog.plugins.filter(({ name }) => name !== "azure")) {
    assert.equal(Object.hasOwn(plugin, "targetPolicies"), false, plugin.name);
  }
});

test("current repository validation remains usable before generated cutover", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/validate.mjs"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Validation passed/);
});

test("production build promotes only complete managed registry artifacts", (context) => {
  const sandbox = sandboxRepository(context);

  const result = buildRegistry({
    repositoryRoot: sandbox.repositoryRoot,
    catalogPath: "registry/catalog.json",
    outputRoot: sandbox.repositoryRoot,
    production: true,
  });

  assert.equal(result.outputRoot, sandbox.repositoryRoot);
  assert.equal(readFileSync(resolve(sandbox.repositoryRoot, "README.md"), "utf8"), "unrelated\n");
  assert.equal(existsSync(resolve(sandbox.repositoryRoot, "sources/local-plugin")), true);
  const claudeMarketplace = JSON.parse(readFileSync(
    resolve(sandbox.repositoryRoot, ".claude-plugin/marketplace.json"),
    "utf8",
  ));
  const codexMarketplace = JSON.parse(readFileSync(
    resolve(sandbox.repositoryRoot, ".agents/plugins/marketplace.json"),
    "utf8",
  ));
  assert.deepEqual(claudeMarketplace.plugins, [{
    name: "local-plugin",
    description: "Local production plugin",
    source: "./plugins/local-plugin/targets/claude",
    category: "development",
  }]);
  assert.deepEqual(codexMarketplace.plugins, [{
    name: "local-plugin",
    source: { source: "local", path: "./plugins/local-plugin/targets/codex" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Development",
  }]);
  assert.equal(JSON.stringify(claudeMarketplace).includes("sha"), false);
  assert.equal(JSON.stringify(claudeMarketplace).includes("ref"), false);
  assert.equal(JSON.stringify(codexMarketplace).includes("sha"), false);
  assert.equal(JSON.stringify(codexMarketplace).includes("ref"), false);

  const pluginRoot = resolve(sandbox.repositoryRoot, "plugins/local-plugin");
  const lock = JSON.parse(readFileSync(
    resolve(sandbox.repositoryRoot, "registry/lock.json"),
    "utf8",
  ));
  assert.deepEqual(Object.keys(lock.plugins), ["local-plugin"]);
  assert.equal(lock.plugins["local-plugin"].bundleDigest, treeHash(pluginRoot));
  assert.equal(lock.plugins["local-plugin"].source.path, "sources/local-plugin");
  assert.equal(lock.generatorDigest, lock.plugins["local-plugin"].generatorDigest);
  assert.match(lock.generatorDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    readdirSync(sandbox.parent).filter((entry) => entry !== "repository"),
    [],
  );
});

test("production build rejects a non-repository output before changing either location", (context) => {
  const sandbox = sandboxRepository(context);
  const outside = resolve(sandbox.parent, "outside");

  assert.throws(() => buildRegistry({
    repositoryRoot: sandbox.repositoryRoot,
    catalogPath: "registry/catalog.json",
    outputRoot: outside,
    production: true,
  }), /production output must be the repository root/);

  assert.equal(existsSync(outside), false);
  assert.equal(readFileSync(resolve(sandbox.repositoryRoot, "README.md"), "utf8"), "unrelated\n");
  assert.equal(existsSync(resolve(sandbox.repositoryRoot, "plugins")), false);
});

test("production build rejects an existing lock symlink before reading outside the repository", (context) => {
  const sandbox = sandboxRepository(context);
  const outsideLock = resolve(sandbox.parent, "outside-lock.json");
  writeFileSync(outsideLock, "not registry data\n");
  symlinkSync(outsideLock, resolve(sandbox.repositoryRoot, "registry/lock.json"));

  assert.throws(() => buildRegistry({
    repositoryRoot: sandbox.repositoryRoot,
    catalogPath: "registry/catalog.json",
    outputRoot: sandbox.repositoryRoot,
    production: true,
  }), /existing registry lock.*(?:symbolic|unsafe|escapes)/);

  assert.equal(readFileSync(outsideLock, "utf8"), "not registry data\n");
  assert.equal(existsSync(resolve(sandbox.repositoryRoot, "plugins")), false);
});

test("production build retains its stage after a public promotion is rolled back", (context) => {
  const sandbox = sandboxRepository(context);
  mkdirSync(resolve(sandbox.repositoryRoot, "plugins"));
  writeFileSync(resolve(sandbox.repositoryRoot, "plugins/old.txt"), "old plugins\n");
  mkdirSync(resolve(sandbox.repositoryRoot, ".claude-plugin"));
  writeFileSync(
    resolve(sandbox.repositoryRoot, ".claude-plugin/marketplace.json"),
    "{\"old\":\"claude\"}\n",
  );
  mkdirSync(resolve(sandbox.repositoryRoot, ".agents/plugins"), { recursive: true });
  writeFileSync(
    resolve(sandbox.repositoryRoot, ".agents/plugins/marketplace.json"),
    "{\"old\":\"codex\"}\n",
  );
  writeFileSync(
    resolve(sandbox.repositoryRoot, "registry/lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatorDigest: "a".repeat(64),
      plugins: {
        "local-plugin": {
          distributionVersion: "0.9.0",
          bundleDigest: "b".repeat(64),
        },
      },
    }),
  );
  let error;

  assert.throws(() => buildRegistry({
    repositoryRoot: sandbox.repositoryRoot,
    catalogPath: "registry/catalog.json",
    outputRoot: sandbox.repositoryRoot,
    production: true,
    promote(input) {
      let stagedRenames = 0;
      return promoteManagedPaths({
        ...input,
        rename(from, to) {
          if (from.startsWith(input.stageRoot)) {
            stagedRenames += 1;
            if (stagedRenames === 2) {
              writeFileSync(
                resolve(sandbox.repositoryRoot, "plugins/foreign.txt"),
                "foreign\n",
              );
              throw new Error("synthetic production promotion failure");
            }
          }
          renameSync(from, to);
        },
      });
    },
  }), (caught) => {
    error = caught;
    return /synthetic production promotion failure/.test(caught.message);
  });

  assert.match(error.recoveryPath, /\.repository\.registry-stage-/);
  assert.equal(existsSync(error.recoveryPath), true);
  assert.equal(
    readFileSync(resolve(error.recoveryPath, "plugins/foreign.txt"), "utf8"),
    "foreign\n",
  );
  assert.equal(
    readFileSync(resolve(sandbox.repositoryRoot, "plugins/old.txt"), "utf8"),
    "old plugins\n",
  );
  assert.equal(existsSync(resolve(sandbox.repositoryRoot, "plugins/foreign.txt")), false);
});
