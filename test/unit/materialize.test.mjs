import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRegistry } from "../../scripts/build-registry.mjs";
import {
  assertAtomicArtifactClaim,
  claimAtomicArtifact,
} from "../../scripts/lib/atomic-output.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";
import { writeJson } from "../../scripts/lib/json.mjs";
import {
  materializationSource,
  openRegistry,
  registryRevision,
} from "../../scripts/lib/registry-reader.mjs";
import {
  materialize,
  validateReceipt,
} from "../../scripts/lib/materialize.mjs";

const RECEIPT = ".gravit-plugin-receipt.json";
const REVISION = "a".repeat(40);

function sandbox(context, prefix = "materialize-") {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixtureRegistry(context) {
  const parent = sandbox(context, "materialize-registry-");
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
  mkdirSync(resolve(sourceRoot, "bin"));
  writeFileSync(
    resolve(sourceRoot, "bin/helper.sh"),
    "#!/usr/bin/env bash\nprintf 'fixture helper\\n'\n",
    { mode: 0o755 },
  );
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

function setup(context) {
  const repositoryRoot = fixtureRegistry(context);
  const temporaryRoot = sandbox(context, "materialize-output-");
  const reader = openRegistry(repositoryRoot);
  function request(outputPath, overrides = {}) {
    return {
      reader,
      pluginName: "nested-skills",
      target: "codex",
      outputPath,
      registryRevision: REVISION,
      ...overrides,
    };
  }
  return { repositoryRoot, temporaryRoot, reader, request };
}

function receiptAt(outputPath) {
  return JSON.parse(readFileSync(resolve(outputPath, RECEIPT), "utf8"));
}

function runCli(...args) {
  return spawnSync(process.execPath, ["scripts/registry.mjs", ...args], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });
}

test("refuses every existing output without inspecting or mutating it", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  mkdirSync(outputPath);
  writeFileSync(resolve(outputPath, "owned-by-user.txt"), "keep\n");

  assert.throws(() => materialize(request(outputPath)), /output already exists/);
  assert.equal(readFileSync(resolve(outputPath, "owned-by-user.txt"), "utf8"), "keep\n");
});

test("a second call refuses while the first payload stays byte and mode identical", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");

  const first = materialize(request(outputPath));
  const firstClaim = claimAtomicArtifact(outputPath, "first materialization");

  assert.throws(
    () => materialize(request(outputPath)),
    /output already exists/,
  );

  assert.equal(first.plugin, "nested-skills");
  assert.deepEqual(receiptAt(outputPath), first);
  assert.doesNotThrow(() => assertAtomicArtifactClaim(
    outputPath,
    firstClaim,
    "first materialization",
  ));
});

test("a post-create failure retains an incomplete output without a receipt", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  let error;

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      afterCopy() {
        throw new Error("synthetic copy failure");
      },
    },
  })), (caught) => {
    error = caught;
    return caught instanceof AggregateError && /synthetic copy failure/.test(caught.message);
  });

  assert.equal(error.recoveryPath, realpathSync(outputPath));
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
  assert.equal(existsSync(resolve(outputPath, ".codex-plugin/plugin.json")), true);
  assert.throws(() => materialize(request(outputPath)), /output already exists/);
});

test("refuses a target whose committed digest no longer matches the lock", (context) => {
  const { repositoryRoot, temporaryRoot } = setup(context);
  const lockPath = resolve(repositoryRoot, "registry/lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.plugins["nested-skills"].targets.codex = "0".repeat(64);
  writeJson(lockPath, lock);
  const outputPath = resolve(temporaryRoot, "consumer");

  assert.throws(() => materialize({
    reader: openRegistry(repositoryRoot),
    pluginName: "nested-skills",
    target: "codex",
    outputPath,
    registryRevision: REVISION,
  }), /target.*digest mismatch/);
  assert.equal(existsSync(outputPath), false);
});

test("payload tampering never turns a completed output into a replacement candidate", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  writeFileSync(resolve(outputPath, "tampered.txt"), "changed\n");

  assert.throws(() => materialize(request(outputPath)), /output already exists/);
  assert.equal(readFileSync(resolve(outputPath, "tampered.txt"), "utf8"), "changed\n");
});

test("preserves executable modes and refuses the immutable output after mode tampering", (context) => {
  const { repositoryRoot, temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const source = materializationSource(openRegistry(repositoryRoot), "nested-skills", "codex");
  const sourceManifest = JSON.parse(readFileSync(
    resolve(repositoryRoot, "plugins/nested-skills/.agent-plugin/plugin.json"),
    "utf8",
  ));
  const executable = sourceManifest.components.find((component) => component.type === "executable");
  const relativeExecutable = executable.targets.codex.path
    .replace(/^targets\/codex\//u, "") + "/helper.sh";
  const sourceMode = statSync(resolve(source.targetRoot, relativeExecutable)).mode & 0o777;

  materialize(request(outputPath));
  const materializedExecutable = resolve(outputPath, relativeExecutable);
  assert.equal(statSync(materializedExecutable).mode & 0o777, sourceMode);
  chmodSync(materializedExecutable, 0o600);

  assert.throws(() => materialize(request(outputPath)), /output already exists/);
  assert.equal(statSync(materializedExecutable).mode & 0o777, 0o600);
});

test("a receipt never authorizes replacement", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  const receiptPath = resolve(outputPath, RECEIPT);
  const receipt = receiptAt(outputPath);
  writeJson(receiptPath, { ...receipt, plugin: "other-plugin" });

  assert.throws(() => materialize(request(outputPath)), /output already exists/);

  writeJson(receiptPath, { ...receipt, unexpected: true });
  assert.throws(() => materialize(request(outputPath)), /output already exists/);
  assert.equal(existsSync(resolve(outputPath, ".codex-plugin/plugin.json")), true);
});

test("a receipt symlink never grants replacement authority", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  const receiptPath = resolve(outputPath, RECEIPT);
  const externalReceipt = resolve(temporaryRoot, "external-receipt.json");
  renameSync(receiptPath, externalReceipt);
  symlinkSync(externalReceipt, receiptPath);

  assert.throws(() => materialize(request(outputPath)), /output already exists/);
  assert.equal(lstatSync(receiptPath).isSymbolicLink(), true);
  assert.equal(existsSync(resolve(outputPath, ".codex-plugin/plugin.json")), true);
});

test("rejects roots, target overlap, output symlinks, files, and special entries", (context) => {
  const { repositoryRoot, temporaryRoot, request } = setup(context);
  const source = materializationSource(openRegistry(repositoryRoot), "nested-skills", "codex");
  const filePath = resolve(temporaryRoot, "file-output");
  const symlinkPath = resolve(temporaryRoot, "symlink-output");
  const symlinkTarget = resolve(temporaryRoot, "symlink-target");
  const specialPath = resolve(temporaryRoot, "special-output");
  writeFileSync(filePath, "keep\n");
  mkdirSync(symlinkTarget);
  symlinkSync(symlinkTarget, symlinkPath);
  assert.equal(spawnSync("mkfifo", [specialPath]).status, 0);

  assert.throws(() => materialize(request(parse(temporaryRoot).root)), /filesystem root/);
  assert.throws(() => materialize(request(source.targetRoot)), /overlaps registry target source/);
  const nestedSourceParent = resolve(source.targetRoot, "must-not-be-created");
  assert.throws(
    () => materialize(request(resolve(nestedSourceParent, "consumer"))),
    /overlaps registry target source/,
  );
  assert.equal(existsSync(nestedSourceParent), false);
  assert.throws(() => materialize(request(filePath)), /output already exists/);
  assert.throws(() => materialize(request(symlinkPath)), /output already exists/);
  assert.throws(() => materialize(request(specialPath)), /output already exists/);
  assert.equal(readFileSync(filePath, "utf8"), "keep\n");
  assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
});

test("canonicalizes an existing symlink parent before publication", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outside = resolve(temporaryRoot, "outside");
  const pivot = resolve(temporaryRoot, "pivot");
  mkdirSync(outside);
  symlinkSync(outside, pivot);

  const receipt = materialize(request(resolve(pivot, "consumer")));

  assert.equal(receipt.plugin, "nested-skills");
  assert.equal(existsSync(resolve(outside, "consumer", RECEIPT)), true);
  assert.equal(
    realpathSync(resolve(pivot, "consumer")),
    realpathSync(resolve(outside, "consumer")),
  );
});

test("an output creation race preserves the complete foreign output", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      beforeOutputMkdir({ outputPath: canonicalOutput }) {
        mkdirSync(canonicalOutput);
        writeFileSync(resolve(canonicalOutput, "foreign.txt"), "foreign output\n");
      },
    },
  })), /output already exists/);

  assert.equal(readFileSync(resolve(outputPath, "foreign.txt"), "utf8"), "foreign output\n");
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
});

test("a parent identity change is detected before output creation", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const displacedParent = temporaryRoot + "-displaced";
  context.after(() => rmSync(displacedParent, { recursive: true, force: true }));

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      beforeOutputCreate() {
        renameSync(temporaryRoot, displacedParent);
        mkdirSync(temporaryRoot);
        writeFileSync(resolve(temporaryRoot, "foreign.txt"), "foreign parent\n");
      },
    },
  })), /output parent ownership changed/);

  assert.equal(readFileSync(resolve(temporaryRoot, "foreign.txt"), "utf8"), "foreign parent\n");
  assert.equal(existsSync(resolve(temporaryRoot, "consumer")), false);
  assert.equal(existsSync(resolve(displacedParent, "consumer")), false);
});

test("an output swapped after exclusive creation is never chmodded or populated", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const displaced = resolve(temporaryRoot, "displaced-created-output");

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      afterOutputMkdir({ outputPath: createdOutput }) {
        renameSync(createdOutput, displaced);
        mkdirSync(createdOutput, { mode: 0o700 });
        writeFileSync(resolve(createdOutput, "foreign.txt"), "foreign output\n", {
          mode: 0o600,
        });
      },
    },
  })), /materialization output ownership changed/);

  assert.equal(readFileSync(resolve(outputPath, "foreign.txt"), "utf8"), "foreign output\n");
  assert.equal(statSync(outputPath).mode & 0o777, 0o700);
  assert.equal(statSync(resolve(outputPath, "foreign.txt")).mode & 0o777, 0o600);
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
  assert.equal(existsSync(displaced), true);
});

test("an unexpected directory race is retained without overwrite", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  let injectedPath;

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      beforeEntryCreate({ destination, type }) {
        if (injectedPath || type !== "directory") return;
        injectedPath = destination;
        mkdirSync(destination);
        writeFileSync(resolve(destination, "foreign.txt"), "foreign directory\n");
      },
    },
  })), /incomplete.*EEXIST|incomplete.*exist/u);

  assert.equal(readFileSync(resolve(injectedPath, "foreign.txt"), "utf8"), "foreign directory\n");
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
});

test("an unexpected file race is retained byte-identical without overwrite", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  let injectedPath;

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      beforeEntryCreate({ destination, type }) {
        if (injectedPath || type !== "file") return;
        injectedPath = destination;
        writeFileSync(destination, "foreign file\n", { mode: 0o600 });
      },
    },
  })), /incomplete.*EEXIST|incomplete.*exist/u);

  assert.equal(readFileSync(injectedPath, "utf8"), "foreign file\n");
  assert.equal(statSync(injectedPath).mode & 0o777, 0o600);
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
});

test("a nested-directory pivot is detected before another destination create", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const outside = resolve(temporaryRoot, "outside");
  mkdirSync(outside);
  writeFileSync(resolve(outside, "foreign.txt"), "foreign outside\n");
  let candidateDirectory;
  let pivoted = false;

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      beforeEntryCreate({ destination, type }) {
        if (!candidateDirectory && type === "directory") {
          candidateDirectory = destination;
          return;
        }
        if (pivoted || !destination.startsWith(candidateDirectory + "/")) return;
        rmSync(candidateDirectory, { recursive: true });
        symlinkSync(outside, candidateDirectory);
        pivoted = true;
      },
    },
  })), /destination directory ownership changed/);

  assert.equal(pivoted, true);
  assert.equal(readFileSync(resolve(outside, "foreign.txt"), "utf8"), "foreign outside\n");
  assert.equal(existsSync(resolve(outside, "plugin.json")), false);
  assert.equal(lstatSync(candidateDirectory).isSymbolicLink(), true);
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
});

test("a directory swapped after exclusive creation is never chmodded or populated", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const displaced = resolve(temporaryRoot, "displaced-created-directory");
  let swappedDirectory;

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      afterDirectoryCreate({ destination }) {
        if (swappedDirectory) return;
        swappedDirectory = destination;
        renameSync(destination, displaced);
        mkdirSync(destination, { mode: 0o700 });
        writeFileSync(resolve(destination, "foreign.txt"), "foreign directory\n", {
          mode: 0o600,
        });
      },
    },
  })), /destination directory ownership changed/);

  assert.equal(readFileSync(resolve(swappedDirectory, "foreign.txt"), "utf8"), "foreign directory\n");
  assert.equal(statSync(swappedDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(resolve(swappedDirectory, "foreign.txt")).mode & 0o777, 0o600);
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
  assert.equal(existsSync(displaced), true);
});

test("directory mode changes caused by umask fail closed without reopening chmod", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const previousUmask = process.umask(0o077);
  try {
    assert.throws(
      () => materialize(request(outputPath)),
      /directory mode mismatch/,
    );
  } finally {
    process.umask(previousUmask);
  }

  assert.equal(existsSync(outputPath), true);
  assert.equal(statSync(outputPath).mode & 0o777, 0o700);
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
});

test("a copied payload mutation is retained as explicit incomplete recovery", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  let error;

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      afterCopy({ outputPath: canonicalOutput }) {
        writeFileSync(resolve(canonicalOutput, "copy-mutation.txt"), "mutation\n");
      },
    },
  })), (caught) => {
    error = caught;
    return caught instanceof AggregateError && /copied target digest mismatch/u.test(caught.message);
  });

  assert.equal(error.recoveryPath, realpathSync(outputPath));
  assert.equal(readFileSync(resolve(outputPath, "copy-mutation.txt"), "utf8"), "mutation\n");
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
});

test("versioned sibling outputs can both be materialized", (context) => {
  const { temporaryRoot, request } = setup(context);
  const firstPath = resolve(temporaryRoot, "nested-skills-1.0.0-rev-a");
  const secondPath = resolve(temporaryRoot, "nested-skills-1.0.0-rev-b");

  const first = materialize(request(firstPath));
  const second = materialize(request(secondPath, { registryRevision: "b".repeat(40) }));

  assert.equal(first.registryRevision, REVISION);
  assert.equal(second.registryRevision, "b".repeat(40));
  assert.equal(existsSync(resolve(firstPath, RECEIPT)), true);
  assert.equal(existsSync(resolve(secondPath, RECEIPT)), true);
});

test("the materializer has no consumer-output rename or deletion path", () => {
  const implementation = readFileSync(
    new URL("../../scripts/lib/materialize.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(implementation, /\b(?:rename|unlink|rmdir|rm)Sync\b/u);
  assert.doesNotMatch(implementation, /\bbindDirectoryMode\b/u);
});

test("materialization source is narrow, fresh, frozen, and bound to the reader", (context) => {
  const { repositoryRoot, reader } = setup(context);
  const first = materializationSource(reader, "nested-skills", "codex");
  const second = materializationSource(reader, "nested-skills", "codex");

  assert.deepEqual(Object.keys(reader).sort(), ["inspect", "list", "verify"]);
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(
    first.targetRoot,
    realpathSync(resolve(repositoryRoot, "plugins/nested-skills/targets/codex")),
  );
  assert.throws(
    () => materializationSource({ verify: reader.verify }, "nested-skills", "codex"),
    /trusted registry reader/,
  );
});

test("treeHash excludes only an exact safe relative file and can bind modes", (context) => {
  const root = sandbox(context, "materialize-hash-");
  const payload = resolve(root, "payload.txt");
  const receipt = resolve(root, RECEIPT);
  writeFileSync(payload, "payload\n", { mode: 0o644 });
  writeFileSync(receipt, "first receipt\n");
  const withoutReceipt = treeHash(root, { exclude: [RECEIPT] });
  const withModes = treeHash(root, { exclude: [RECEIPT], includeModes: true });

  writeFileSync(receipt, "changed receipt\n");
  assert.equal(treeHash(root, { exclude: [RECEIPT] }), withoutReceipt);
  chmodSync(payload, 0o755);
  assert.equal(treeHash(root, { exclude: [RECEIPT] }), withoutReceipt);
  assert.notEqual(treeHash(root, { exclude: [RECEIPT], includeModes: true }), withModes);

  for (const unsafe of ["", ".", "../receipt", "/receipt", "nested\\receipt", "missing"]) {
    assert.throws(() => treeHash(root, { exclude: [unsafe] }), /unsafe|regular file/);
  }
});

test("registryRevision returns a strict Git HEAD and rejects non-checkouts", (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const expected = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).stdout.trim();
  assert.equal(registryRevision(repositoryRoot), expected);
  assert.match(registryRevision(repositoryRoot), /^[a-f0-9]{40}$/);

  const notRepository = sandbox(context, "materialize-no-git-");
  assert.throws(
    () => registryRevision(notRepository),
    /registry checkout must have a resolvable Git HEAD/,
  );
});

test("validates complete receipts and rejects malformed receipt values", () => {
  const valid = {
    schemaVersion: 1,
    registry: "gravit-cloud",
    registryRevision: REVISION,
    plugin: "nested-skills",
    target: "codex",
    distributionVersion: "1.0.0-gravit.1",
    sourceBundleDigest: "b".repeat(64),
    sourceTargetDigest: "c".repeat(64),
    materializedDigest: "d".repeat(64),
  };
  assert.doesNotThrow(() => validateReceipt(valid));
  assert.throws(
    () => validateReceipt({ ...valid, registryRevision: "HEAD" }),
    /invalid materialization receipt/,
  );
  assert.doesNotThrow(() => validateReceipt({
    ...valid,
    target: "universal",
    sourceTargetDigest: valid.sourceBundleDigest,
    materializedDigest: valid.sourceBundleDigest,
  }));
  assert.throws(
    () => validateReceipt({ ...valid, target: "universal" }),
    /universal receipt digests must equal sourceBundleDigest/,
  );
  assert.throws(
    () => materialize({ target: "universal" }),
    /unsupported materialization target: universal/,
  );
});

test("CLI validates materialize options and target before output resolution", (context) => {
  const root = sandbox(context, "materialize-cli-");
  const output = resolve(root, "output");
  const invalidCases = [
    ["materialize"],
    ["materialize", "--plugin", "azure", "--target", "invalid", "--output", output],
    ["materialize", "--plugin", "azure", "--target", "codex"],
    ["materialize", "--plugin", "azure", "--plugin", "azure", "--target", "codex", "--output", output],
    ["materialize", "--plugin", "azure", "--target", "codex", "--output", output, "--unknown", "x"],
  ];

  for (const args of invalidCases) {
    const result = runCli(...args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.equal(existsSync(output), false, args.join(" "));
  }
});

test("CLI materializes a verified target and emits its receipt", (context) => {
  const root = sandbox(context, "materialize-cli-success-");
  const output = resolve(root, "gravit-custom-codex");

  const result = runCli(
    "materialize",
    "--plugin",
    "gravit-custom",
    "--target",
    "codex",
    "--output",
    output,
  );

  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.plugin, "gravit-custom");
  assert.equal(receipt.target, "codex");
  assert.match(receipt.registryRevision, /^[a-f0-9]{40}$/u);
  assert.equal(existsSync(resolve(output, RECEIPT)), true);
  assert.equal(existsSync(resolve(output, ".codex-plugin/plugin.json")), true);
});

test("artifact claims reject identical nested inode replacements", (context) => {
  const root = sandbox(context, "materialize-claim-identity-");
  const nested = resolve(root, "nested.txt");
  writeFileSync(nested, "same bytes\n", { mode: 0o644 });
  const claim = claimAtomicArtifact(root, "identity fixture");
  rmSync(nested);
  writeFileSync(nested, "same bytes\n", { mode: 0o644 });

  assert.throws(
    () => assertAtomicArtifactClaim(root, claim, "identity fixture"),
    /ownership changed/,
  );
});

test("reader verification cannot be replaced through the public object", (context) => {
  const { reader } = setup(context);
  assert.equal(Object.isFrozen(reader), true);
  assert.throws(() => {
    reader.verify = () => ({ ok: true, errors: [] });
  }, TypeError);
});

test("requires an existing immediate output parent without creating descendants", (context) => {
  const { temporaryRoot, request } = setup(context);
  const missingParent = resolve(temporaryRoot, "missing-parent");

  assert.throws(
    () => materialize(request(resolve(missingParent, "consumer"))),
    /immediate output parent must exist/,
  );
  assert.equal(existsSync(missingParent), false);
});

test("accepts a canonicalized system symlink as the existing output parent", (context) => {
  const temporaryParent = "/tmp";
  if (!lstatSync(temporaryParent).isSymbolicLink()) {
    context.skip("system /tmp is not a symlink on this platform");
    return;
  }
  const { request } = setup(context);
  const outputPath = resolve(
    temporaryParent,
    `gravit-materialize-${process.pid}-${Date.now()}`,
  );
  context.after(() => rmSync(outputPath, { recursive: true, force: true }));

  assert.doesNotThrow(() => materialize(request(outputPath)));
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), true);
});

test("rejects a reserved receipt introduced into the copied target", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  let error;

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      beforeReceiptCreate({ outputPath: canonicalOutput }) {
        writeFileSync(resolve(canonicalOutput, RECEIPT), "foreign receipt\n", {
          flag: "wx",
        });
      },
    },
  })), (caught) => {
    error = caught;
    return caught instanceof AggregateError && /reserved receipt/u.test(caught.message);
  });

  assert.equal(error.recoveryPath, realpathSync(outputPath));
  assert.equal(readFileSync(resolve(outputPath, RECEIPT), "utf8"), "foreign receipt\n");
  assert.throws(() => receiptAt(outputPath), SyntaxError);
});

test("a receipt seam race is rejected without overwriting foreign data", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const foreignReceipt = "foreign receipt race\n";

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      beforeReceiptOpen({ receiptPath }) {
        writeFileSync(receiptPath, foreignReceipt, { flag: "wx", mode: 0o600 });
      },
    },
  })), /incomplete.*ownership changed/u);

  const receiptPath = resolve(outputPath, RECEIPT);
  assert.equal(readFileSync(receiptPath, "utf8"), foreignReceipt);
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
});

test("the complete bundle is revalidated after the final receipt seam", (context) => {
  const { repositoryRoot, temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const neutralManifest = resolve(
    repositoryRoot,
    "plugins/nested-skills/.agent-plugin/plugin.json",
  );

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      beforeReceiptOpen() {
        writeFileSync(neutralManifest, readFileSync(neutralManifest, "utf8") + " ");
      },
    },
  })), /bundle.*(?:ownership|content or metadata) changed/);

  assert.equal(existsSync(outputPath), true);
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
});

test("an output swapped at the final receipt seam never receives a valid receipt", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const displaced = resolve(temporaryRoot, "displaced-populated-output");

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      beforeReceiptOpen({ receiptPath }) {
        const populatedOutput = resolve(receiptPath, "..");
        renameSync(populatedOutput, displaced);
        mkdirSync(populatedOutput, { mode: 0o700 });
        writeFileSync(resolve(populatedOutput, "foreign.txt"), "foreign final output\n");
      },
    },
  })), /materialization output ownership changed/);

  assert.equal(readFileSync(resolve(outputPath, "foreign.txt"), "utf8"), "foreign final output\n");
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
  assert.equal(existsSync(resolve(displaced, RECEIPT)), false);
});

test("rejects a reserved receipt already present in a verified source target", (context) => {
  const { repositoryRoot, temporaryRoot } = setup(context);
  const bundleRoot = resolve(repositoryRoot, "plugins/nested-skills");
  const targetRoot = resolve(bundleRoot, "targets/codex");
  const manifestPath = resolve(bundleRoot, ".agent-plugin/plugin.json");
  const lockPath = resolve(repositoryRoot, "registry/lock.json");
  writeFileSync(resolve(targetRoot, RECEIPT), "reserved source receipt\n");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const targetDigest = treeHash(targetRoot);
  manifest.targets.codex.digest = targetDigest;
  writeJson(manifestPath, manifest);
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.plugins["nested-skills"].targets.codex = targetDigest;
  lock.plugins["nested-skills"].bundleDigest = treeHash(bundleRoot);
  writeJson(lockPath, lock);

  const outputPath = resolve(temporaryRoot, "consumer");
  assert.throws(() => materialize({
    reader: openRegistry(repositoryRoot),
    pluginName: "nested-skills",
    target: "codex",
    outputPath,
    registryRevision: REVISION,
  }), /source target contains reserved receipt/);
  assert.equal(existsSync(outputPath), false);
});

test("revalidates the complete bundle immediately before publication", (context) => {
  const { repositoryRoot, temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const neutralManifest = resolve(
    repositoryRoot,
    "plugins/nested-skills/.agent-plugin/plugin.json",
  );

  assert.throws(() => materialize(request(outputPath, {
    publicationHooks: {
      afterCopy() {
        writeFileSync(neutralManifest, readFileSync(neutralManifest, "utf8") + " ");
      },
    },
  })), /bundle.*(?:ownership|content or metadata) changed/);

  assert.equal(existsSync(outputPath), true);
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), false);
});
