import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRegistry } from "../../scripts/build-registry.mjs";
import { sha256 } from "../../scripts/lib/hash.mjs";
import { writeJson } from "../../scripts/lib/json.mjs";
import { validateReceipt } from "../../scripts/lib/materialize.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const RELEASE_BUILDER = new URL("../../scripts/build-release.mjs", import.meta.url);
const RECEIPT = ".gravit-plugin-receipt.json";
const UNZIP = "/usr/bin/unzip";

function sandbox(context, prefix) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), prefix)));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function runGit(repositoryRoot, ...args) {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      GIT_AUTHOR_EMAIL: "release-test@example.invalid",
      GIT_AUTHOR_NAME: "Release Test",
      GIT_COMMITTER_EMAIL: "release-test@example.invalid",
      GIT_COMMITTER_NAME: "Release Test",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
}

function fixtureRegistry(context) {
  const parent = sandbox(context, "release-fixture-");
  const repositoryRoot = resolve(parent, "repository");
  const sourceRoot = resolve(repositoryRoot, "sources/fixture");
  mkdirSync(resolve(sourceRoot, "skills/fixture"), { recursive: true });
  writeFileSync(resolve(sourceRoot, "LICENSE"), "fixture license\n");
  writeFileSync(resolve(sourceRoot, "skills/fixture/SKILL.md"), [
    "---",
    "name: fixture",
    "description: Release fixture",
    "---",
    "",
    "# Fixture",
    "",
  ].join("\n"));
  mkdirSync(resolve(repositoryRoot, "registry"));
  writeJson(resolve(repositoryRoot, "registry/catalog.json"), {
    schemaVersion: 1,
    name: "fixture-marketplace",
    plugins: [{
      name: "fixture",
      description: "Release fixture",
      category: "development",
      distributionVersion: "1.0.0-gravit.1",
      source: { type: "local", path: "sources/fixture", root: "." },
      targets: ["claude", "codex", "openclaw"],
      adapterOptions: { openclaw: { bundleFormat: "codex" } },
      policies: { default: "transform-or-fail", skills: "transform" },
    }],
  });
  buildRegistry({
    repositoryRoot,
    catalogPath: "registry/catalog.json",
    outputRoot: repositoryRoot,
    production: true,
  });
  runGit(repositoryRoot, "init", "-q");
  runGit(repositoryRoot, "add", ".");
  runGit(repositoryRoot, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  return realpathSync(repositoryRoot);
}

function runUnzip(args) {
  const stats = existsSync(UNZIP) ? lstatSync(UNZIP) : undefined;
  if (
    !stats
    || stats.isSymbolicLink()
    || !stats.isFile()
    || (stats.mode & 0o111) === 0
    || realpathSync(UNZIP) !== UNZIP
  ) {
    throw new Error("trusted unzip executable is unavailable: " + UNZIP);
  }
  const result = spawnSync(UNZIP, args, {
    encoding: "utf8",
    env: { TZ: "UTC" },
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function archiveEntries(archive) {
  return runUnzip(["-Z", "-1", archive])
    .split("\n")
    .filter(Boolean);
}

function archiveReceipt(archive, pluginName) {
  return JSON.parse(runUnzip(["-p", archive, `${pluginName}/${RECEIPT}`]));
}

function assertSafeArchive(pluginName, archive, locked) {
  const entries = archiveEntries(archive);
  assert.equal(new Set(entries).size, entries.length, `${pluginName}: duplicate entries`);
  assert.ok(entries.length > 0, `${pluginName}: empty archive`);

  for (const entry of entries) {
    assert.equal(entry.includes("\\"), false, `${pluginName}: backslash path: ${entry}`);
    assert.equal(entry.startsWith("/"), false, `${pluginName}: absolute path: ${entry}`);
    const segments = entry.split("/");
    assert.equal(segments[0], pluginName, `${pluginName}: unexpected archive root: ${entry}`);
    assert.equal(
      segments.some((segment) => segment === "" || segment === "." || segment === ".."),
      false,
      `${pluginName}: unsafe path: ${entry}`,
    );
    assert.equal(
      segments.some((segment) => [
        ".sources",
        ".tmp",
        ".git",
        "node_modules",
        "__MACOSX",
      ].includes(segment)),
      false,
      `${pluginName}: generated source/cache path: ${entry}`,
    );
  }

  const entrySet = new Set(entries);
  for (const required of [
    ".agent-plugin/plugin.json",
    "targets/claude/.claude-plugin/plugin.json",
    "targets/codex/.codex-plugin/plugin.json",
    "targets/openclaw/.codex-plugin/plugin.json",
    "LICENSE",
    RECEIPT,
  ]) {
    assert.equal(entrySet.has(`${pluginName}/${required}`), true, `${pluginName}: missing ${required}`);
  }
  assert.equal(
    entries.some((entry) => entry.startsWith(`${pluginName}/components/`)),
    true,
    `${pluginName}: missing components`,
  );

  const zipInfo = runUnzip(["-Z", "-l", archive]);
  assert.doesNotMatch(zipInfo, /^l[^\n]*\s[^\s]+$/mu, `${pluginName}: symlink archive entry`);

  const receipt = archiveReceipt(archive, pluginName);
  assert.doesNotThrow(() => validateReceipt(receipt));
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    registry: "gravit-cloud",
    registryRevision: receipt.registryRevision,
    plugin: pluginName,
    target: "universal",
    distributionVersion: locked.distributionVersion,
    sourceBundleDigest: locked.bundleDigest,
    sourceTargetDigest: locked.bundleDigest,
    materializedDigest: locked.bundleDigest,
  });
  assert.match(receipt.registryRevision, /^[a-f0-9]{40}$/u);
}

test("builds one safe deterministic universal archive for every verified plugin", async (context) => {
  const releaseModule = await import(RELEASE_BUILDER).catch(() => undefined);
  assert.equal(typeof releaseModule?.buildRelease, "function", "release builder must exist");

  const root = sandbox(context, "release-archives-");
  const firstDist = resolve(root, "first");
  const secondDist = resolve(root, "second");
  mkdirSync(firstDist);
  mkdirSync(secondDist);

  const previousZipOptions = process.env.ZIPOPT;
  let firstBuild;
  let secondBuild;
  process.env.ZIPOPT = "-j";
  try {
    firstBuild = releaseModule.buildRelease({
      repositoryRoot: REPOSITORY_ROOT,
      distRoot: firstDist,
    });
    secondBuild = releaseModule.buildRelease({
      repositoryRoot: REPOSITORY_ROOT,
      distRoot: secondDist,
    });
  } finally {
    if (previousZipOptions === undefined) delete process.env.ZIPOPT;
    else process.env.ZIPOPT = previousZipOptions;
  }

  for (const build of [firstBuild, secondBuild]) {
    assert.equal(Object.isFrozen(build), true);
    assert.match(build.stagePath, /\/gravit-release-[^/]+$/u);
    assert.equal(realpathSync(build.stagePath), build.stagePath);
    assert.equal(lstatSync(build.stagePath).isDirectory(), true);
  }

  const catalog = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "registry/catalog.json"), "utf8"));
  const lock = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, "registry/lock.json"), "utf8"));
  const expectedNames = catalog.plugins
    .map((plugin) => `${plugin.name}-v${plugin.distributionVersion}.zip`)
    .sort();
  const firstNames = readdirSync(firstDist).sort();
  const secondNames = readdirSync(secondDist).sort();

  assert.equal(expectedNames.length, 6);
  assert.deepEqual(firstNames, expectedNames);
  assert.deepEqual(secondNames, expectedNames);

  for (const archiveName of expectedNames) {
    const pluginName = catalog.plugins.find((plugin) => (
      archiveName === `${plugin.name}-v${plugin.distributionVersion}.zip`
    )).name;
    const firstArchive = resolve(firstDist, archiveName);
    const secondArchive = resolve(secondDist, archiveName);
    assert.equal(basename(firstArchive), archiveName);
    assertSafeArchive(pluginName, firstArchive, lock.plugins[pluginName]);
    assert.equal(
      sha256(readFileSync(firstArchive)),
      sha256(readFileSync(secondArchive)),
      `${pluginName}: release archive is not byte-identical`,
    );
  }

  const localLicense = runUnzip([
    "-p",
    resolve(firstDist, `gravit-custom-v${lock.plugins["gravit-custom"].distributionVersion}.zip`),
    "gravit-custom/LICENSE",
  ]);
  assert.deepEqual(Buffer.from(localLicense), readFileSync(resolve(REPOSITORY_ROOT, "LICENSE")));

  const firstClaims = Object.fromEntries(firstNames.map((archiveName) => [
    archiveName,
    sha256(readFileSync(resolve(firstDist, archiveName))),
  ]));
  assert.throws(
    () => releaseModule.buildRelease({ repositoryRoot: REPOSITORY_ROOT, distRoot: firstDist }),
    /release archive already exists/,
  );
  for (const [archiveName, digest] of Object.entries(firstClaims)) {
    assert.equal(sha256(readFileSync(resolve(firstDist, archiveName))), digest);
  }
});

test("rejects unsafe DIST_DIR values before creating an output", async (context) => {
  const { buildRelease } = await import(RELEASE_BUILDER);
  const repositoryRoot = fixtureRegistry(context);
  const root = sandbox(context, "release-dist-safety-");
  const realOutput = resolve(root, "real-output");
  const linkedOutput = resolve(root, "linked-output");
  mkdirSync(realOutput);
  symlinkSync(realOutput, linkedOutput);
  const managedOutput = resolve(repositoryRoot, "plugins/release-output");

  assert.throws(
    () => buildRelease({ repositoryRoot, distRoot: "/" }),
    /must not be a filesystem root/,
  );
  assert.throws(
    () => buildRelease({ repositoryRoot, distRoot: linkedOutput }),
    /must be canonical/,
  );
  assert.throws(
    () => buildRelease({ repositoryRoot, distRoot: managedOutput }),
    /overlaps managed registry inputs/,
  );
  assert.equal(existsSync(managedOutput), false);
});

test("a source mutation retains private recovery staging without publication", async (context) => {
  const { buildRelease } = await import(RELEASE_BUILDER);
  const repositoryRoot = fixtureRegistry(context);
  const root = sandbox(context, "release-source-race-");
  const distRoot = resolve(root, "dist");
  mkdirSync(distRoot);
  let error;

  assert.throws(() => buildRelease({
    repositoryRoot,
    distRoot,
    publicationHooks: {
      afterSourceClaim({ source }) {
        writeFileSync(resolve(source.bundleRoot, "mutation.txt"), "mutation\n");
      },
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError
      && /source bundle.*changed/u.test(caught.errors[0]?.message);
  });

  assert.equal(realpathSync(error.recoveryPath), error.recoveryPath);
  assert.equal(lstatSync(error.recoveryPath).isDirectory(), true);
  assert.deepEqual(readdirSync(distRoot), []);
  assert.deepEqual(error.publishedArchives, []);
});

test("an archive publication race preserves foreign bytes and retains staging", async (context) => {
  const { buildRelease } = await import(RELEASE_BUILDER);
  const repositoryRoot = fixtureRegistry(context);
  const root = sandbox(context, "release-publication-race-");
  const distRoot = resolve(root, "dist");
  mkdirSync(distRoot);
  const foreign = Buffer.from("foreign archive\n");
  let racedArchive;
  let error;

  assert.throws(() => buildRelease({
    repositoryRoot,
    distRoot,
    publicationHooks: {
      beforePublication({ staged }) {
        racedArchive = staged[0].destination;
        writeFileSync(racedArchive, foreign, { flag: "wx", mode: 0o600 });
      },
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError
      && /archive already exists/u.test(caught.errors[0]?.message);
  });

  assert.deepEqual(readFileSync(racedArchive), foreign);
  assert.equal(realpathSync(error.recoveryPath), error.recoveryPath);
  assert.equal(lstatSync(error.recoveryPath).isDirectory(), true);
  assert.deepEqual(error.publishedArchives, []);
});

test("a staged archive mutation is retained and never published", async (context) => {
  const { buildRelease } = await import(RELEASE_BUILDER);
  const repositoryRoot = fixtureRegistry(context);
  const root = sandbox(context, "release-stage-race-");
  const distRoot = resolve(root, "dist");
  mkdirSync(distRoot);
  let error;

  assert.throws(() => buildRelease({
    repositoryRoot,
    distRoot,
    publicationHooks: {
      beforePublication({ staged }) {
        writeFileSync(staged[0].archivePath, "mutated archive\n");
      },
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError
      && /completed release stage.*changed/u.test(caught.errors[0]?.message);
  });

  assert.equal(realpathSync(error.recoveryPath), error.recoveryPath);
  assert.equal(lstatSync(error.recoveryPath).isDirectory(), true);
  assert.deepEqual(readdirSync(distRoot), []);
  assert.deepEqual(error.publishedArchives, []);
});

test("release CLI rejects positional arguments before creating DIST_DIR", (context) => {
  const root = sandbox(context, "release-cli-args-");
  const distRoot = resolve(root, "dist");
  const result = spawnSync(process.execPath, ["scripts/build-release.mjs", "unexpected"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { DIST_DIR: distRoot, PATH: "/usr/bin:/bin", TZ: "UTC" },
    maxBuffer: 1024 * 1024,
    shell: false,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /accepts no positional arguments/);
  assert.equal(existsSync(distRoot), false);
});
