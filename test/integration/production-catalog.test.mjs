import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
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
      "2.2.4-gravit.6",
      "1.0.1-gravit.3",
      "1.2.3-gravit.1",
      "1.2.30-gravit.1",
      "6.3.0-gravit.1",
      "1.0.0-gravit.4",
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
          ref: "v1.2.3",
          sha: "6acc160e4e0cd062dbbbd7a1b26ae92855edf07e",
          root: ".",
        },
      },
      {
        name: "azure",
        source: {
          type: "github",
          repo: "microsoft/azure-skills",
          ref: "v1.2.29",
          sha: "16dc8c51ba7fda44c18781b5e4c0ca40a7a06a55",
          root: ".",
        },
      },
      {
        name: "superpowers",
        source: {
          type: "github",
          repo: "obra/superpowers",
          ref: "v6.3.0",
          sha: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797",
          root: ".",
        },
      },
    ],
  );
  const claudeSeo = catalog.plugins.find(({ name }) => name === "claude-seo");
  assert.deepEqual(claudeSeo.targetPolicies, {
    codex: {
      unsupported: {
        agent: "host-does-not-load-agents",
      },
    },
  });
  const azure = catalog.plugins.find(({ name }) => name === "azure");
  assert.equal(azure.runtimeDependencies["@azure/mcp"], "2.0.5");
  assert.deepEqual(azure.resources, [
    { type: "executable", path: "hooks/scripts" },
  ]);
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
  for (const plugin of catalog.plugins) {
    assert.deepEqual(plugin.targets, ["claude", "codex"], plugin.name);
    assert.equal(Object.hasOwn(plugin, "adapterOptions"), false, plugin.name);
    assert.equal(Object.hasOwn(plugin.targetPolicies || {}, "openclaw"), false, plugin.name);
  }
});

test("current repository passes offline validation after generated cutover", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/validate.mjs"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "Registry validation passed.\n");
  assert.equal(result.stderr, "");
});

test("production bundles contain only Claude and Codex targets", () => {
  for (const name of expectedPluginNames) {
    const targets = readdirSync(resolve(repositoryRoot, "plugins", name, "targets"), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.deepEqual(targets, ["claude", "codex"], name);
  }
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
  assert.deepEqual(claudeMarketplace, {
    name: "fixture-marketplace",
    owner: { name: "Gravit Cloud" },
    description: "Kuratierter Gravit-Cloud-Marketplace für Claude Code und Codex.",
    plugins: [{
      name: "local-plugin",
      description: "Local production plugin",
      source: "./plugins/local-plugin/targets/claude",
      category: "development",
    }],
  });
  assert.deepEqual(codexMarketplace, {
    name: "fixture-marketplace",
    interface: { displayName: "Fixture Marketplace" },
    plugins: [{
      name: "local-plugin",
      source: { source: "local", path: "./plugins/local-plugin/targets/codex" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Development",
    }],
  });
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

const postValidationMutations = [
  {
    name: "an extra plugin file",
    mutate(stageRoot) {
      const path = resolve(stageRoot, "plugins/local-plugin/post-validation.txt");
      writeFileSync(path, "post validation\n");
      return {
        assertRetained() {
          assert.equal(readFileSync(path, "utf8"), "post validation\n");
        },
      };
    },
  },
  {
    name: "different marketplace bytes",
    mutate(stageRoot) {
      const path = resolve(stageRoot, ".claude-plugin/marketplace.json");
      writeFileSync(path, readFileSync(path, "utf8") + "\n");
      return {
        assertRetained() {
          assert.equal(readFileSync(path, "utf8").endsWith("\n\n"), true);
        },
      };
    },
  },
  {
    name: "a different marketplace mode",
    mutate(stageRoot) {
      const path = resolve(stageRoot, ".agents/plugins/marketplace.json");
      chmodSync(path, 0o600);
      return {
        assertRetained() {
          assert.equal(statSync(path).mode & 0o777, 0o600);
        },
      };
    },
  },
];

for (const mutation of postValidationMutations) {
  test("production build rejects " + mutation.name + " introduced after validation", (context) => {
    const sandbox = sandboxRepository(context);
    let retained;
    let error;

    assert.throws(() => buildRegistry({
      repositoryRoot: sandbox.repositoryRoot,
      catalogPath: "registry/catalog.json",
      outputRoot: sandbox.repositoryRoot,
      production: true,
      promote(input) {
        retained = mutation.mutate(input.stageRoot);
        return promoteManagedPaths(input);
      },
    }), (caught) => {
      error = caught;
      return caught instanceof AggregateError;
    });

    assert.match(error.recoveryPath, /\.repository\.registry-stage-/);
    assert.equal(existsSync(error.recoveryPath), true);
    retained.assertRetained();
    assert.equal(existsSync(resolve(sandbox.repositoryRoot, "plugins")), false);
    assert.equal(existsSync(resolve(sandbox.repositoryRoot, ".claude-plugin")), false);
    assert.equal(existsSync(resolve(sandbox.repositoryRoot, ".agents")), false);
    assert.equal(existsSync(resolve(sandbox.repositoryRoot, "registry/lock.json")), false);
  });
}

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

test("production build never cleans a replaced source root after preflight", (context) => {
  const sandbox = sandboxRepository(context);
  let error;

  assert.throws(() => buildRegistry({
    repositoryRoot: sandbox.repositoryRoot,
    catalogPath: "registry/catalog.json",
    outputRoot: sandbox.repositoryRoot,
    production: true,
    promote(input) {
      let replaced = false;
      return promoteManagedPaths(input, {
        beforeSourceValidation({ phase, relativePath, source }) {
          if (replaced || phase !== "before-backup" || relativePath !== "plugins") return;
          replaced = true;
          rmSync(source, { recursive: true });
          mkdirSync(source);
          writeFileSync(resolve(source, "foreign.txt"), "foreign replacement\n");
        },
      });
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.match(error.recoveryPath, /\.repository\.registry-stage-/);
  assert.equal(existsSync(error.recoveryPath), true);
  assert.equal(
    readFileSync(resolve(error.recoveryPath, "plugins/foreign.txt"), "utf8"),
    "foreign replacement\n",
  );
  assert.equal(existsSync(resolve(sandbox.repositoryRoot, "plugins")), false);
  assert.equal(readFileSync(resolve(sandbox.repositoryRoot, "README.md"), "utf8"), "unrelated\n");
});
