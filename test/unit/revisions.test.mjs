import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bumpChangedRevisions } from "../../scripts/bump-plugin-revisions.mjs";

const scriptPath = fileURLToPath(
  new URL("../../scripts/bump-plugin-revisions.mjs", import.meta.url),
);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function githubSource(overrides = {}) {
  return {
    type: "github",
    repo: "owner/repository",
    ref: "v1.0.0",
    sha: "a".repeat(40),
    root: ".",
    ...overrides,
  };
}

function catalogPlugin(name, overrides = {}) {
  return {
    name,
    distributionVersion: "1.0.0-gravit.1",
    source: githubSource(),
    ...overrides,
  };
}

function inputsFor(plugins) {
  return {
    catalog: { plugins },
    lock: {
      plugins: Object.fromEntries(
        plugins.map((plugin) => [plugin.name, { source: structuredClone(plugin.source) }]),
      ),
    },
  };
}

function configuredMatches(manager, text) {
  return manager.matchStrings.flatMap((pattern) => (
    [...text.matchAll(new RegExp(pattern, "g"))].map((match) => ({ ...match.groups }))
  ));
}

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
          sha: "a".repeat(40),
          ref: "v1.2.4",
          repo: "a/b",
          type: "github",
        },
      },
      same: {
        source: {
          sha: "c".repeat(40),
          ref: "main",
          repo: "c/d",
          type: "github",
        },
      },
    },
  };

  const result = bumpChangedRevisions({ catalog, lock });

  assert.deepEqual(result.changedNames, ["changed"]);
  assert.equal(result.catalog.plugins[0].distributionVersion, "1.2.5-gravit.4");
  assert.equal(result.catalog.plugins[1].distributionVersion, "1.0.0-gravit.1");
});

test("treats equivalent source records as identical across safe object prototypes", () => {
  const input = inputsFor([catalogPlugin("same")]);
  const source = input.catalog.plugins[0].source;
  input.lock.plugins.same.source = Object.assign(Object.create(null), {
    root: source.root,
    sha: source.sha,
    ref: source.ref,
    repo: source.repo,
    type: source.type,
  });

  const result = bumpChangedRevisions(input);

  assert.deepEqual(result.changedNames, []);
  assert.equal(result.catalog.plugins[0].distributionVersion, "1.0.0-gravit.1");
});

test("fails closed when catalog and lock membership differ", () => {
  const addition = inputsFor([catalogPlugin("added")]);
  addition.lock.plugins = {};
  assert.throws(
    () => bumpChangedRevisions(addition),
    /missing lock entry.*added/,
  );

  const removal = inputsFor([catalogPlugin("kept")]);
  removal.lock.plugins.removed = { source: githubSource({ repo: "old/removed" }) };
  assert.throws(
    () => bumpChangedRevisions(removal),
    /lock entry without matching catalog plugin.*removed/,
  );
});

test("rejects duplicate names and malformed container shapes", () => {
  const duplicate = catalogPlugin("duplicate");
  assert.throws(
    () => bumpChangedRevisions(inputsFor([duplicate, structuredClone(duplicate)])),
    /duplicate plugin name.*duplicate/,
  );

  assert.throws(
    () => bumpChangedRevisions({ catalog: { plugins: {} }, lock: { plugins: {} } }),
    /catalog\.plugins must be an array/,
  );
  assert.throws(
    () => bumpChangedRevisions({
      catalog: { plugins: [catalogPlugin("valid")] },
      lock: { plugins: [] },
    }),
    /lock\.plugins must be an object/,
  );
  assert.throws(
    () => bumpChangedRevisions({ catalog: { plugins: [] }, lock: { plugins: {} } }),
    /catalog\.plugins must not be empty/,
  );
});

test("rejects malformed sources and exact revision boundary violations", () => {
  const cases = [
    {
      label: "unknown source type",
      plugin: catalogPlugin("bad-source", { source: { type: "other" } }),
      error: /source.*type/,
    },
    {
      label: "malformed GitHub repository",
      plugin: catalogPlugin("bad-repository", {
        source: githubSource({ repo: "not-a-repository-pair" }),
      }),
      error: /repo must be owner\/repository/,
    },
    {
      label: "unsafe local source path",
      plugin: catalogPlugin("bad-local-path", {
        source: { type: "local", path: "../outside", root: "." },
      }),
      error: /path must be a safe relative path/,
    },
    {
      label: "malformed distribution version",
      plugin: catalogPlugin("bad-version", {
        distributionVersion: "1.0.0",
        source: githubSource({ sha: "b".repeat(40) }),
      }),
      error: /distributionVersion must match X\.Y\.Z-gravit\.N/,
    },
    {
      label: "non-positive revision",
      plugin: catalogPlugin("zero-revision", {
        distributionVersion: "1.0.0-gravit.0",
        source: githubSource({ sha: "b".repeat(40) }),
      }),
      error: /revision must be a positive safe integer/,
    },
    {
      label: "unsafe revision",
      plugin: catalogPlugin("unsafe-revision", {
        distributionVersion: "1.0.0-gravit.9007199254740991",
        source: githubSource({ sha: "b".repeat(40) }),
      }),
      error: /revision cannot be incremented safely/,
    },
  ];

  for (const { label, plugin, error } of cases) {
    const input = inputsFor([plugin]);
    input.lock.plugins[plugin.name].source = githubSource();
    assert.throws(() => bumpChangedRevisions(input), error, label);
  }
});

test("returns an independent clone without changing review-gated source context", () => {
  const plugin = catalogPlugin("context", {
    source: githubSource({ sha: "b".repeat(40) }),
    sourceContext: [
      { path: "README.md", digest: "c".repeat(64) },
    ],
  });
  const input = inputsFor([plugin]);
  input.lock.plugins.context.source = githubSource({ sha: "a".repeat(40) });
  const before = structuredClone(input);

  const result = bumpChangedRevisions(input);

  assert.deepEqual(input, before);
  assert.notStrictEqual(result.catalog, input.catalog);
  assert.notStrictEqual(result.catalog.plugins[0], input.catalog.plugins[0]);
  assert.notStrictEqual(
    result.catalog.plugins[0].sourceContext,
    input.catalog.plugins[0].sourceContext,
  );
  assert.deepEqual(result.catalog.plugins[0].sourceContext, [
    { path: "README.md", digest: "c".repeat(64) },
  ]);
  assert.equal(result.catalog.plugins[0].distributionVersion, "1.0.0-gravit.2");
});

test("returns changed names deterministically and bumps every changed plugin once", () => {
  const zed = catalogPlugin("zed", { source: githubSource({ sha: "b".repeat(40) }) });
  const alpha = catalogPlugin("alpha", {
    distributionVersion: "2.3.4-gravit.8",
    source: githubSource({ repo: "alpha/repository", sha: "c".repeat(40) }),
  });
  const input = inputsFor([zed, alpha]);
  input.lock.plugins.zed.source.sha = "a".repeat(40);
  input.lock.plugins.alpha.source.sha = "a".repeat(40);

  const result = bumpChangedRevisions(input);

  assert.deepEqual(result.changedNames, ["alpha", "zed"]);
  assert.equal(result.catalog.plugins[0].distributionVersion, "1.0.0-gravit.2");
  assert.equal(result.catalog.plugins[1].distributionVersion, "2.3.4-gravit.9");
});

test("CLI writes a changed revision without refreshing source context", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-revisions-changed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "registry"));
  const catalog = {
    plugins: [
      catalogPlugin("changed", {
        source: githubSource({ sha: "b".repeat(40) }),
        sourceContext: [{ path: "README.md", digest: "d".repeat(64) }],
      }),
    ],
  };
  const lock = {
    plugins: {
      changed: { source: githubSource({ sha: "a".repeat(40) }) },
    },
  };
  writeFileSync(resolve(root, "registry/catalog.json"), JSON.stringify(catalog));
  writeFileSync(resolve(root, "registry/lock.json"), JSON.stringify(lock));

  const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "changed\n");
  const written = JSON.parse(readFileSync(resolve(root, "registry/catalog.json"), "utf8"));
  assert.equal(written.plugins[0].distributionVersion, "1.0.0-gravit.2");
  assert.deepEqual(written.plugins[0].sourceContext, [
    { path: "README.md", digest: "d".repeat(64) },
  ]);
});

test("CLI leaves a no-change catalog byte-for-byte untouched", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-revisions-noop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "registry"));
  const source = githubSource();
  const catalogBytes = `{ "plugins" : [ ${JSON.stringify(catalogPlugin("same"))} ] }\n`;
  writeFileSync(resolve(root, "registry/catalog.json"), catalogBytes);
  writeFileSync(
    resolve(root, "registry/lock.json"),
    JSON.stringify({
      plugins: {
        same: {
          source: {
            sha: source.sha,
            root: source.root,
            ref: source.ref,
            repo: source.repo,
            type: source.type,
          },
        },
      },
    }),
  );
  utimesSync(resolve(root, "registry/catalog.json"), 1, 1);
  const beforeMtime = statSync(resolve(root, "registry/catalog.json")).mtimeMs;

  const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(resolve(root, "registry/catalog.json"), "utf8"), catalogBytes);
  assert.equal(statSync(resolve(root, "registry/catalog.json")).mtimeMs, beforeMtime);
});

test("Renovate rediscovers tag and branch sources after the CLI canonicalizes JSON", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-revisions-renovate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "registry"));
  const tagged = catalogPlugin("tagged", {
    source: githubSource({
      repo: "owner/tagged",
      ref: "v1.2.3-rc.1+build.5",
      sha: "b".repeat(40),
    }),
  });
  const branch = catalogPlugin("branch", {
    source: {
      type: "github",
      repo: "owner/branch",
      ref: "master",
      sha: "d".repeat(40),
    },
  });
  writeFileSync(
    resolve(root, "registry/catalog.json"),
    JSON.stringify({ plugins: [tagged, branch] }),
  );
  writeFileSync(
    resolve(root, "registry/lock.json"),
    JSON.stringify({
      plugins: {
        tagged: { source: githubSource({ repo: "owner/tagged", sha: "a".repeat(40) }) },
        branch: {
          source: {
            type: "github",
            repo: "owner/branch",
            ref: "master",
            sha: "c".repeat(40),
          },
        },
      },
    }),
  );

  const cli = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });

  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, "branch\ntagged\n");
  const serializedCatalog = readFileSync(resolve(root, "registry/catalog.json"), "utf8");
  const config = JSON.parse(readFileSync(resolve(repositoryRoot, "renovate.json"), "utf8"));
  const [tagManager, branchManager] = config.customManagers;
  assert.deepEqual(configuredMatches(tagManager, serializedCatalog), [
    {
      currentValue: "v1.2.3-rc.1+build.5",
      packageName: "owner/tagged",
      currentDigest: "b".repeat(40),
    },
  ]);
  assert.deepEqual(configuredMatches(branchManager, serializedCatalog), [
    {
      currentValue: "master",
      packageName: "owner/branch",
      currentDigest: "d".repeat(40),
    },
  ]);
});

test("Renovate managers update only GitHub sources in the neutral catalog", () => {
  const config = JSON.parse(readFileSync(resolve(repositoryRoot, "renovate.json"), "utf8"));
  assert.equal(config.customManagers.length, 2);
  for (const manager of config.customManagers) {
    assert.deepEqual(manager.managerFilePatterns, ["/^registry\\/catalog\\.json$/"]);
  }

  const [tagManager, branchManager] = config.customManagers;
  const tagSource = JSON.stringify({
    plugins: [{
      name: "tagged",
      source: githubSource({
        repo: "owner/tagged",
        ref: "v1.2.3-rc.1+build.5",
        sha: "b".repeat(40),
      }),
    }],
  }, null, 2);
  const branchSource = JSON.stringify({
    plugins: [{
      name: "branch",
      source: githubSource({
        repo: "owner/branch",
        ref: "master",
        sha: "c".repeat(40),
      }),
    }],
  }, null, 2);
  const tagMatch = new RegExp(tagManager.matchStrings[0]).exec(tagSource);
  const branchMatch = new RegExp(branchManager.matchStrings[0]).exec(branchSource);
  assert.deepEqual(
    {
      packageName: tagMatch?.groups?.packageName,
      currentValue: tagMatch?.groups?.currentValue,
      currentDigest: tagMatch?.groups?.currentDigest,
    },
    {
      packageName: "owner/tagged",
      currentValue: "v1.2.3-rc.1+build.5",
      currentDigest: "b".repeat(40),
    },
  );
  assert.deepEqual(
    {
      packageName: branchMatch?.groups?.packageName,
      currentValue: branchMatch?.groups?.currentValue,
      currentDigest: branchMatch?.groups?.currentDigest,
    },
    {
      packageName: "owner/branch",
      currentValue: "master",
      currentDigest: "c".repeat(40),
    },
  );
  assert.equal(new RegExp(tagManager.matchStrings[0]).test(branchSource), false);
  assert.equal(new RegExp(branchManager.matchStrings[0]).test(tagSource), false);
  assert.equal(configuredMatches(tagManager, tagSource).length, 1);
  assert.equal(configuredMatches(branchManager, branchSource).length, 1);
  assert.equal(
    new RegExp(tagManager.matchStrings[0]).test(
      JSON.stringify({ source: { source: "github", repo: "old/shape" } }),
    ),
    false,
  );
  const contextOnly = JSON.stringify({
    sourceContext: [{
      type: "github",
      repo: "unrelated/context",
      ref: "v1.2.3",
      sha: "e".repeat(40),
    }],
  });
  assert.deepEqual(configuredMatches(tagManager, contextOnly), []);
  assert.deepEqual(configuredMatches(branchManager, contextOnly), []);
  const unrelatedSourceObject = JSON.stringify({
    source: {
      type: "github",
      repo: "unrelated/object",
      ref: "v1.2.3",
      sha: "f".repeat(40),
      unrelated: true,
    },
  });
  assert.deepEqual(configuredMatches(tagManager, unrelatedSourceObject), []);
  assert.deepEqual(configuredMatches(branchManager, unrelatedSourceObject), []);

  const productionCatalogText = readFileSync(
    resolve(repositoryRoot, "registry/catalog.json"),
    "utf8",
  );
  const productionCatalog = JSON.parse(productionCatalogText);
  const expectedRepositories = productionCatalog.plugins
    .filter((plugin) => plugin.source.type === "github")
    .map((plugin) => plugin.source.repo)
    .sort();
  const discoveredRepositories = config.customManagers
    .flatMap((manager) => configuredMatches(manager, productionCatalogText))
    .map((match) => match.packageName)
    .sort();
  assert.deepEqual(discoveredRepositories, expectedRepositories);

  const customRule = config.packageRules.find(
    (rule) => rule.matchManagers?.includes("custom.regex"),
  );
  assert.deepEqual(customRule?.matchFileNames, ["registry/catalog.json"]);
  assert.deepEqual(config.postUpgradeTasks.fileFilters, [
    "registry/catalog.json",
    "registry/lock.json",
    ".claude-plugin/marketplace.json",
    ".agents/**",
    "plugins/**",
  ]);
});

test("Renovate ignores exact source-shaped objects outside direct plugin records", () => {
  const config = JSON.parse(readFileSync(resolve(repositoryRoot, "renovate.json"), "utf8"));
  const [tagManager, branchManager] = config.customManagers;
  const prettyMetadata = JSON.stringify({
    metadata: [
      {
        source: {
          type: "github",
          repo: "metadata/type-first-tag",
          ref: "v1.2.3",
          sha: "a".repeat(40),
          root: ".",
        },
      },
      {
        source: {
          ref: "master",
          repo: "metadata/canonical-branch",
          sha: "b".repeat(40),
          type: "github",
        },
      },
    ],
  }, null, 2);
  const compactMetadata = JSON.stringify({
    metadata: [
      {
        source: {
          ref: "v1.2.3-rc.1+build.5",
          repo: "metadata/canonical-tag",
          root: ".",
          sha: "c".repeat(40),
          type: "github",
        },
      },
      {
        source: {
          type: "github",
          repo: "metadata/type-first-branch",
          ref: "main",
          sha: "d".repeat(40),
        },
      },
    ],
  });

  for (const unrelated of [prettyMetadata, compactMetadata]) {
    assert.deepEqual(configuredMatches(tagManager, unrelated), []);
    assert.deepEqual(configuredMatches(branchManager, unrelated), []);
  }
});

test("Renovate regexes scan the production catalog within bounded time", () => {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const { readFileSync } = require("node:fs");
const config = JSON.parse(readFileSync(process.argv[1], "utf8"));
const catalog = readFileSync(process.argv[2], "utf8");
for (const manager of config.customManagers) {
  for (const pattern of manager.matchStrings) {
    [...catalog.matchAll(new RegExp(pattern, "g"))];
  }
}`,
      resolve(repositoryRoot, "renovate.json"),
      resolve(repositoryRoot, "registry/catalog.json"),
    ],
    { encoding: "utf8", timeout: 2_000 },
  );

  assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
});

test("post-upgrade script runs only the safe registry synchronization sequence", (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-renovate-script-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = resolve(root, "bin");
  const log = resolve(root, "commands.log");
  mkdirSync(bin);
  const recorder = `#!/bin/sh
printf '%s' "\${0##*/}" >> "$GRAVIT_COMMAND_LOG"
for arg in "$@"; do printf '\\t%s' "$arg" >> "$GRAVIT_COMMAND_LOG"; done
printf '\\n' >> "$GRAVIT_COMMAND_LOG"
`;
  for (const command of ["npm", "node"]) {
    const executable = resolve(bin, command);
    writeFileSync(executable, recorder);
    chmodSync(executable, 0o755);
  }

  const result = spawnSync(
    "bash",
    [resolve(repositoryRoot, "scripts/renovate-plugin-sync.sh")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GRAVIT_COMMAND_LOG: log,
        PATH: bin + ":" + process.env.PATH,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, "utf8"), [
    "npm\tci\t--ignore-scripts",
    "node\tscripts/bump-plugin-revisions.mjs",
    "npm\trun\tplugins:sync",
    "npm\trun\tvalidate",
    "",
  ].join("\n"));
});
