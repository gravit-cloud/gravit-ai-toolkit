import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRegistry } from "../../scripts/build-registry.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";
import { writeJson } from "../../scripts/lib/json.mjs";
import * as registryReader from "../../scripts/lib/registry-reader.mjs";

const { openRegistry } = registryReader;

function fixtureRegistry(context, { objectFormat = "sha1" } = {}) {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-reader-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const sourceRoot = resolve(repositoryRoot, "sources/nested-skills");
  mkdirSync(resolve(sourceRoot, "skills/parent/child"), { recursive: true });
  writeFileSync(resolve(sourceRoot, "LICENSE"), "fixture license\n");
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
  runGit(
    repositoryRoot,
    "init",
    "-q",
    ...(objectFormat === "sha1" ? [] : [`--object-format=${objectFormat}`]),
  );
  runGit(repositoryRoot, "add", ".");
  runGit(
    repositoryRoot,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "fixture",
  );
  return repositoryRoot;
}

function runGit(repositoryRoot, ...args) {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      GIT_AUTHOR_EMAIL: "registry-reader-test@example.invalid",
      GIT_AUTHOR_NAME: "Registry Reader Test",
      GIT_COMMITTER_EMAIL: "registry-reader-test@example.invalid",
      GIT_COMMITTER_NAME: "Registry Reader Test",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function copyFixtureRegistry(context) {
  const source = fixtureRegistry(context);
  const parent = mkdtempSync(resolve(tmpdir(), "registry-reader-copy-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const copy = resolve(parent, "repository");
  cpSync(source, copy, { recursive: true });
  return copy;
}

function multiPluginFixture(context) {
  const root = fixtureRegistry(context);
  const source = resolve(root, "sources/nested-skills");
  const otherSource = resolve(root, "sources/other-skills");
  cpSync(source, otherSource, { recursive: true });
  mkdirSync(resolve(otherSource, "bin"));
  writeFileSync(
    resolve(otherSource, "bin/helper.sh"),
    "#!/usr/bin/env bash\nprintf 'valid fixture\\n'\n",
    { mode: 0o755 },
  );
  const catalogPath = resolve(root, "registry/catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  catalog.plugins.push({
    ...structuredClone(catalog.plugins[0]),
    name: "other-skills",
    source: { type: "local", path: "sources/other-skills", root: "." },
  });
  writeJson(catalogPath, catalog);
  buildRegistry({
    repositoryRoot: root,
    catalogPath: "registry/catalog.json",
    outputRoot: root,
    production: true,
  });
  return root;
}

function marketplaceEntry(root, target, name) {
  const path = resolve(
    root,
    target === "claude"
      ? ".claude-plugin/marketplace.json"
      : ".agents/plugins/marketplace.json",
  );
  const marketplace = JSON.parse(readFileSync(path, "utf8"));
  return { path, marketplace, entry: marketplace.plugins.find((entry) => entry.name === name) };
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

test("public reader APIs cannot expose or poison captured registry state", (context) => {
  const reader = openRegistry(fixtureRegistry(context));
  assert.deepEqual(Object.keys(reader).sort(), ["inspect", "list", "verify"]);
  assert.equal(Object.hasOwn(reader, "entry"), false);

  const summary = reader.list();
  summary[0].targets.push("poisoned");
  const details = reader.inspect("nested-skills");
  details.source.path = "outside";
  details.components[0].id = "poisoned";

  assert.deepEqual(reader.list()[0].targets, ["claude", "codex", "openclaw"]);
  assert.equal(reader.inspect("nested-skills").source.path, "sources/nested-skills");
  assert.notEqual(reader.inspect("nested-skills").components[0].id, "poisoned");
});

test("release source is narrow, fresh, frozen, verified, and bound to the reader", (context) => {
  const root = fixtureRegistry(context);
  const reader = openRegistry(root);
  const first = registryReader.releaseSource(reader, "nested-skills");
  const second = registryReader.releaseSource(reader, "nested-skills");

  assert.deepEqual(Object.keys(reader).sort(), ["inspect", "list", "verify"]);
  assert.deepEqual(Object.keys(first).sort(), [
    "bundleDigest",
    "bundleRoot",
    "distributionVersion",
    "plugin",
  ]);
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.bundleRoot, realpathSync(resolve(root, "plugins/nested-skills")));
  assert.equal(first.bundleDigest, treeHash(first.bundleRoot));
  assert.throws(
    () => registryReader.releaseSource({ verify: reader.verify }, "nested-skills"),
    /trusted registry reader/,
  );
});

test("revision claims are opaque, reader-bound, plugin-bound, and commit-bound", (context) => {
  const root = fixtureRegistry(context);
  const reader = openRegistry(root);
  const claim = registryReader.claimRegistryRevision(reader, ["nested-skills"]);
  const expected = runGit(root, "rev-parse", "HEAD");

  assert.equal(Object.isFrozen(claim), true);
  assert.deepEqual(Object.keys(claim), []);
  assert.equal(
    registryReader.assertRegistryRevisionClaim(reader, claim, ["nested-skills"]),
    expected,
  );
  assert.throws(
    () => registryReader.assertRegistryRevisionClaim(reader, {}, ["nested-skills"]),
    /trusted registry revision claim/,
  );
  assert.throws(
    () => registryReader.assertRegistryRevisionClaim(reader, claim, ["other-skills"]),
    /unknown registry plugin|plugin selection mismatch/,
  );

  runGit(root, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "next");
  assert.throws(
    () => registryReader.assertRegistryRevisionClaim(reader, claim, ["nested-skills"]),
    /Git HEAD changed/,
  );
});

test("revision claims reject coherent but uncommitted registry regeneration", (context) => {
  const root = fixtureRegistry(context);
  appendFileSync(resolve(root, "sources/nested-skills/skills/parent/SKILL.md"), "\nChanged.\n");
  const catalogPath = resolve(root, "registry/catalog.json");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  catalog.plugins[0].distributionVersion = "1.0.0-gravit.2";
  writeJson(catalogPath, catalog);
  buildRegistry({
    repositoryRoot: root,
    catalogPath: "registry/catalog.json",
    outputRoot: root,
    production: true,
  });
  const reader = openRegistry(root);
  assert.deepEqual(reader.verify("nested-skills"), { ok: true, errors: [] });

  assert.throws(
    () => registryReader.claimRegistryRevision(reader, ["nested-skills"]),
    /consumed registry paths are not committed/,
  );
});

test("revision claims reject untracked files below a selected bundle", (context) => {
  const root = fixtureRegistry(context);
  const reader = openRegistry(root);
  const claim = registryReader.claimRegistryRevision(reader, ["nested-skills"]);
  writeFileSync(resolve(root, "plugins/nested-skills/untracked.txt"), "untracked\n");

  assert.throws(
    () => registryReader.assertRegistryRevisionClaim(reader, claim, ["nested-skills"]),
    /consumed registry paths are not committed/,
  );
});

test("revision claims reject changed bytes hidden by assume-unchanged for NUL-delimited paths", (context) => {
  const root = fixtureRegistry(context);
  const relativePath = "plugins/nested-skills/strange name\npayload.txt";
  const path = resolve(root, relativePath);
  writeFileSync(path, "committed\n");
  runGit(root, "add", "--", relativePath);
  runGit(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "strange path");
  runGit(root, "update-index", "--assume-unchanged", "--", relativePath);
  writeFileSync(path, "changed but hidden\n");
  assert.equal(runGit(root, "status", "--porcelain=v1", "--", relativePath), "");

  assert.throws(
    () => registryReader.claimRegistryRevision(openRegistry(root), ["nested-skills"]),
    /index flags|committed registry tree/,
  );
});

test("revision claims reject skip-worktree entries even before bytes diverge", (context) => {
  const root = fixtureRegistry(context);
  const relativePath = "plugins/nested-skills/LICENSE";
  runGit(root, "update-index", "--skip-worktree", "--", relativePath);

  assert.throws(
    () => registryReader.claimRegistryRevision(openRegistry(root), ["nested-skills"]),
    /index flags/,
  );
});

test("revision claims reject ignored files and untracked empty directories", (context) => {
  for (const mutation of ["ignored-file", "empty-directory"]) {
    const root = fixtureRegistry(context);
    if (mutation === "ignored-file") {
      appendFileSync(
        resolve(root, ".git/info/exclude"),
        "\nplugins/nested-skills/ignored.txt\n",
      );
      writeFileSync(resolve(root, "plugins/nested-skills/ignored.txt"), "ignored\n");
    } else {
      mkdirSync(resolve(root, "plugins/nested-skills/untracked-empty"));
    }
    assert.equal(runGit(root, "status", "--porcelain=v1"), "");

    assert.throws(
      () => registryReader.claimRegistryRevision(openRegistry(root), ["nested-skills"]),
      /committed registry tree/,
      mutation,
    );
  }
});

test("revision claims support SHA-256 Git object IDs", (context) => {
  const root = fixtureRegistry(context, { objectFormat: "sha256" });
  const reader = openRegistry(root);
  const claim = registryReader.claimRegistryRevision(reader, ["nested-skills"]);

  assert.match(
    registryReader.assertRegistryRevisionClaim(reader, claim, ["nested-skills"]),
    /^[a-f0-9]{64}$/u,
  );
});

test("release source rejects a reserved universal receipt even if it is relocked", (context) => {
  const root = fixtureRegistry(context);
  const bundleRoot = resolve(root, "plugins/nested-skills");
  writeFileSync(resolve(bundleRoot, ".gravit-plugin-receipt.json"), "reserved\n");
  const lockPath = resolve(root, "registry/lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.plugins["nested-skills"].bundleDigest = treeHash(bundleRoot);
  writeJson(lockPath, lock);

  assert.deepEqual(openRegistry(root).verify("nested-skills"), { ok: true, errors: [] });
  assert.throws(
    () => registryReader.releaseSource(openRegistry(root), "nested-skills"),
    /reserved receipt/,
  );
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

test("list rejects lock entries whose generator digest disagrees with the registry", (context) => {
  const root = copyFixtureRegistry(context);
  const lockPath = resolve(root, "registry/lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.plugins["nested-skills"].generatorDigest = "a".repeat(64);
  writeJson(lockPath, lock);

  assert.throws(() => openRegistry(root).list(), /generator digest mismatch/);
  assert.deepEqual(openRegistry(root).verify("nested-skills"), {
    ok: false,
    errors: ["nested-skills: generator digest mismatch with registry"],
  });
});

test("list rejects duplicate component identities in an otherwise schema-valid lock", (context) => {
  const root = copyFixtureRegistry(context);
  const lockPath = resolve(root, "registry/lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.plugins["nested-skills"].components.push(
    structuredClone(lock.plugins["nested-skills"].components[0]),
  );
  writeJson(lockPath, lock);

  assert.throws(() => openRegistry(root).list(), /duplicate lock component id/);
});

test("selected verification ignores unrelated plugin syntax and marketplace failures", (context) => {
  const root = multiPluginFixture(context);
  const otherManifest = JSON.parse(readFileSync(
    resolve(root, "plugins/other-skills/.agent-plugin/plugin.json"),
    "utf8",
  ));
  const executable = otherManifest.components.find((component) => component.type === "executable");
  writeFileSync(
    resolve(root, "plugins/other-skills", executable.targets.codex.path, "helper.sh"),
    "if then\n",
  );
  const otherMarketplace = marketplaceEntry(root, "claude", "other-skills");
  otherMarketplace.entry.source = "./outside";
  writeJson(otherMarketplace.path, otherMarketplace.marketplace);

  assert.deepEqual(openRegistry(root).verify("nested-skills"), { ok: true, errors: [] });
});

test("selected verification retains selected marketplace and global trust failures", (context) => {
  const root = multiPluginFixture(context);
  const selectedMarketplace = marketplaceEntry(root, "claude", "nested-skills");
  selectedMarketplace.entry.source = "./outside";
  writeJson(selectedMarketplace.path, selectedMarketplace.marketplace);

  assert.match(
    openRegistry(root).verify("nested-skills").errors.join("\n"),
    /claude marketplace nested-skills: expected local source/,
  );
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
