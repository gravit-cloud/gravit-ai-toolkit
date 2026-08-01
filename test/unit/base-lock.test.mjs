import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateVersionHistory } from "../../scripts/lib/validator.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const validateScript = resolve(repositoryRoot, "scripts/validate.mjs");

function lockWith(distributionVersion, bundleDigest) {
  return {
    plugins: {
      azure: { distributionVersion, bundleDigest },
    },
  };
}

test("rejects reuse of one distribution version for another digest", () => {
  const baseLock = lockWith("1.2.5-gravit.4", "a".repeat(64));
  const currentLock = lockWith("1.2.5-gravit.4", "b".repeat(64));

  assert.deepEqual(validateVersionHistory({ currentLock, baseLock }), [
    "azure: distributionVersion 1.2.5-gravit.4 already identifies another bundle",
  ]);
});

test("allows unchanged identities and deliberate version changes", () => {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);

  assert.deepEqual(validateVersionHistory({
    baseLock: lockWith("9.0.0-gravit.8", digestA),
    currentLock: lockWith("9.0.0-gravit.8", digestA),
  }), []);
  assert.deepEqual(validateVersionHistory({
    baseLock: lockWith("9.0.0-gravit.8", digestA),
    currentLock: lockWith("1.0.0-gravit.1", digestB),
  }), []);
  assert.deepEqual(validateVersionHistory({
    baseLock: lockWith("9.0.0-gravit.8", digestA),
    currentLock: lockWith("1.0.0-gravit.1", digestA),
  }), []);
});

test("allows new current plugins and removed base plugins", () => {
  const currentOnly = lockWith("1.0.0-gravit.1", "a".repeat(64));
  const baseOnly = lockWith("2.0.0-gravit.2", "b".repeat(64));

  assert.deepEqual(validateVersionHistory({
    currentLock: currentOnly,
    baseLock: { plugins: {} },
  }), []);
  assert.deepEqual(validateVersionHistory({
    currentLock: { plugins: {} },
    baseLock: baseOnly,
  }), []);
});

test("returns unique collisions sorted by registry plugin name", () => {
  const baseLock = {
    plugins: {
      zeta: { distributionVersion: "2.0.0-gravit.3", bundleDigest: "a".repeat(64) },
      alpha: { distributionVersion: "1.0.0-gravit.7", bundleDigest: "b".repeat(64) },
    },
  };
  const currentLock = {
    plugins: {
      zeta: { distributionVersion: "2.0.0-gravit.3", bundleDigest: "c".repeat(64) },
      alpha: { distributionVersion: "1.0.0-gravit.7", bundleDigest: "d".repeat(64) },
    },
  };

  assert.deepEqual(validateVersionHistory({ currentLock, baseLock }), [
    "alpha: distributionVersion 1.0.0-gravit.7 already identifies another bundle",
    "zeta: distributionVersion 2.0.0-gravit.3 already identifies another bundle",
  ]);
});

test("accepts null-prototype lock containers", () => {
  const plugins = Object.create(null);
  const entry = Object.create(null);
  entry.distributionVersion = "1.0.0-gravit.1";
  entry.bundleDigest = "a".repeat(64);
  plugins.azure = entry;
  const currentLock = Object.create(null);
  currentLock.plugins = plugins;

  assert.deepEqual(validateVersionHistory({
    currentLock,
    baseLock: { plugins: {} },
  }), []);
});

test("rejects malformed lock containers without throwing incidental type errors", () => {
  const valid = lockWith("1.0.0-gravit.1", "a".repeat(64));
  const inheritedPlugins = Object.create({ plugins: {} });
  const customPrototypePlugins = Object.create({ inherited: true });
  const malformedInputs = [
    { currentLock: null, baseLock: valid, fragment: "current lock must be a plain object" },
    { currentLock: inheritedPlugins, baseLock: valid, fragment: "current lock must be a plain object" },
    { currentLock: {}, baseLock: valid, fragment: "current lock requires own plugins" },
    {
      currentLock: { plugins: undefined },
      baseLock: valid,
      fragment: "current lock plugins must be a plain object",
    },
    {
      currentLock: { plugins: customPrototypePlugins },
      baseLock: valid,
      fragment: "current lock plugins must be a plain object",
    },
    { currentLock: valid, baseLock: [], fragment: "base lock must be a plain object" },
    { currentLock: valid, baseLock: {}, fragment: "base lock requires own plugins" },
    {
      currentLock: valid,
      baseLock: { plugins: null },
      fragment: "base lock plugins must be a plain object",
    },
  ];

  for (const { currentLock, baseLock, fragment } of malformedInputs) {
    const errors = validateVersionHistory({ currentLock, baseLock });
    assert.equal(errors.some((error) => error.includes(fragment)), true, JSON.stringify(errors));
  }
});

test("rejects unsafe names and malformed version entries on either side", () => {
  const digest = "a".repeat(64);
  const invalidEntries = [
    { value: null, fragment: "must be a plain object" },
    {
      value: Object.create({ distributionVersion: "1.0.0-gravit.1", bundleDigest: digest }),
      fragment: "must be a plain object",
    },
    { value: { bundleDigest: digest }, fragment: "requires own distributionVersion" },
    {
      value: { distributionVersion: undefined, bundleDigest: digest },
      fragment: "distributionVersion must match X.Y.Z-gravit.N",
    },
    {
      value: { distributionVersion: "1.0.0-gravit.1" },
      fragment: "requires own bundleDigest",
    },
    {
      value: { distributionVersion: "1.0.0", bundleDigest: digest },
      fragment: "must match X.Y.Z-gravit.N",
    },
    {
      value: { distributionVersion: "1.0.0-gravit.0", bundleDigest: digest },
      fragment: "must match X.Y.Z-gravit.N",
    },
    {
      value: { distributionVersion: "1.0.0-gravit.9007199254740992", bundleDigest: digest },
      fragment: "must match X.Y.Z-gravit.N",
    },
    {
      value: { distributionVersion: "9007199254740992.0.0-gravit.1", bundleDigest: digest },
      fragment: "must match X.Y.Z-gravit.N",
    },
    {
      value: { distributionVersion: "1.0.0-gravit.1", bundleDigest: "A".repeat(64) },
      fragment: "must be a lowercase SHA-256 digest",
    },
  ];

  for (const side of ["currentLock", "baseLock"]) {
    for (const { value, fragment } of invalidEntries) {
      const malformed = { plugins: { azure: value } };
      const input = { currentLock: validLock(), baseLock: validLock(), [side]: malformed };
      const errors = validateVersionHistory(input);
      assert.equal(errors.some((error) => error.includes(fragment)), true, `${side}: ${errors}`);
    }
  }

  for (const unsafeName of ["Azure", "two words", "constructor", "prototype"] ) {
    const plugins = Object.create(null);
    plugins[unsafeName] = {
      distributionVersion: "1.0.0-gravit.1",
      bundleDigest: digest,
    };
    const errors = validateVersionHistory({
      currentLock: { plugins },
      baseLock: { plugins: {} },
    });
    assert.equal(errors.some((error) => error.includes("invalid registry plugin name")), true);
  }
});

test("rejects accessor, symbol, and non-enumerable plugin properties", () => {
  const accessorLock = {};
  Object.defineProperty(accessorLock, "plugins", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  const symbolPlugins = { [Symbol("hidden")]: validLock().plugins.azure };
  const nonEnumerablePlugins = {};
  Object.defineProperty(nonEnumerablePlugins, "azure", {
    enumerable: false,
    value: null,
  });

  assert.deepEqual(validateVersionHistory({
    currentLock: accessorLock,
    baseLock: validLock(),
  }), ["current lock plugins must be an own data property"]);
  assert.equal(validateVersionHistory({
    currentLock: { plugins: symbolPlugins },
    baseLock: validLock(),
  }).some((error) => error.includes("invalid registry plugin name")), true);
  assert.equal(validateVersionHistory({
    currentLock: { plugins: nonEnumerablePlugins },
    baseLock: validLock(),
  }).some((error) => error.includes("current lock plugin azure must be a plain object")), true);
});

test("does not mutate frozen history inputs", () => {
  const currentLock = lockWith("1.0.0-gravit.1", "a".repeat(64));
  const baseLock = lockWith("1.0.0-gravit.1", "b".repeat(64));
  Object.freeze(currentLock.plugins.azure);
  Object.freeze(currentLock.plugins);
  Object.freeze(currentLock);
  Object.freeze(baseLock.plugins.azure);
  Object.freeze(baseLock.plugins);
  Object.freeze(baseLock);

  assert.doesNotThrow(() => validateVersionHistory({ currentLock, baseLock }));
  assert.equal(currentLock.plugins.azure.bundleDigest, "a".repeat(64));
  assert.equal(baseLock.plugins.azure.bundleDigest, "b".repeat(64));
});

test("CLI rejects unknown, repeated, missing, and extra arguments before reading files", () => {
  const cases = [
    ["--unknown", "/definitely/not/a/lock.json"],
    ["--compare-lock"],
    ["--compare-lock", "/not/read.json", "extra"],
    ["--compare-lock", "/not/read.json", "--compare-lock", "/also-not-read.json"],
  ];
  for (const args of cases) {
    const result = runValidate(args);
    assert.equal(result.status, 1, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /usage: node scripts\/validate\.mjs \[--compare-lock <path>\]/);
    assert.doesNotMatch(result.stderr, /ENOENT|not\/a\/lock|not\/read|also-not-read/);
  }
});

test("CLI reports collisions from a JSON base lock", (context) => {
  const temporaryRoot = temporaryDirectory(context);
  const baseLock = JSON.parse(readFileSync(resolve(repositoryRoot, "registry/lock.json"), "utf8"));
  const [name] = Object.keys(baseLock.plugins).sort();
  baseLock.plugins[name].bundleDigest = baseLock.plugins[name].bundleDigest === "a".repeat(64)
    ? "b".repeat(64)
    : "a".repeat(64);
  const basePath = resolve(temporaryRoot, "base-lock.json");
  writeFileSync(basePath, JSON.stringify(baseLock));

  const result = runValidate(["--compare-lock", basePath]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(
    result.stderr,
    new RegExp(`${name}: distributionVersion [^ ]+ already identifies another bundle`),
  );
});

test("CLI parses base data only as bounded JSON and rejects invalid shapes", (context) => {
  const temporaryRoot = temporaryDirectory(context);
  const marker = resolve(temporaryRoot, "executed");
  const malformedPath = resolve(temporaryRoot, "base-lock.mjs");
  writeFileSync(
    malformedPath,
    `{${"x".repeat(10_000)}}; require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`,
  );

  const malformed = runValidate(["--compare-lock", malformedPath]);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /compare lock: invalid JSON/);
  assert.equal(malformed.stderr.length < 500, true, malformed.stderr.length);
  assert.equal(existsSync(marker), false);

  const invalidShapePath = resolve(temporaryRoot, "invalid-shape.json");
  writeFileSync(invalidShapePath, "{}\n");
  const invalidShape = runValidate(["--compare-lock", invalidShapePath]);
  assert.equal(invalidShape.status, 1);
  assert.match(invalidShape.stderr, /base lock requires own plugins/);
});

test("validation workflow extracts only a fully identified merge-base lock", () => {
  const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/validate.yml"), "utf8");
  const checkoutBlocks = workflow.split(/\n(?=\s*- uses: actions\/checkout@)/u).slice(1);

  assert.equal(checkoutBlocks.length, 2);
  assert.match(checkoutBlocks[0], /fetch-depth:\s*0/u);
  assert.doesNotMatch(checkoutBlocks[1], /fetch-depth:/u);
  assert.match(workflow, /name: Extract merge-base registry lock/u);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/u);
  assert.match(workflow, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(workflow, /git rev-parse --show-object-format/u);
  assert.match(workflow, /git rev-parse --verify --end-of-options/u);
  assert.match(workflow, /git merge-base -- HEAD "\$BASE_COMMIT"/u);
  assert.match(workflow, /git ls-tree "\$REGISTRY_BASE_COMMIT" -- registry\/lock\.json/u);
  assert.match(workflow, /"\$RUNNER_TEMP\/gravit-base-lock\.json"/u);
  assert.match(workflow, /printf '%s\\n' '\{"plugins":\{\}\}'/u);
  assert.match(
    workflow,
    /node scripts\/validate\.mjs --compare-lock "\$RUNNER_TEMP\/gravit-base-lock\.json"/u,
  );
  assert.doesNotMatch(workflow, /git (?:fetch|checkout|worktree)/u);
});

function validLock() {
  return lockWith("1.0.0-gravit.1", "a".repeat(64));
}

function runValidate(args) {
  return spawnSync(process.execPath, [validateScript, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function temporaryDirectory(context) {
  const root = mkdtempSync(resolve(tmpdir(), "registry-base-lock-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
