import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
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
import { basename, dirname, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRegistry } from "../../scripts/build-registry.mjs";
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

test("refuses an existing directory without a matching receipt", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  mkdirSync(outputPath);
  writeFileSync(resolve(outputPath, "owned-by-user.txt"), "keep\n");

  assert.throws(() => materialize(request(outputPath)), /refusing to replace unowned output/);
  assert.equal(readFileSync(resolve(outputPath, "owned-by-user.txt"), "utf8"), "keep\n");
});

test("replaces only a matching previously materialized target", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");

  const first = materialize(request(outputPath));
  const second = materialize(request(outputPath));

  assert.equal(first.plugin, "nested-skills");
  assert.equal(second.target, "codex");
  assert.deepEqual(second, first);
  assert.equal(existsSync(resolve(outputPath, RECEIPT)), true);
  assert.equal(existsSync(resolve(outputPath, ".codex-plugin/plugin.json")), true);
});

test("a failed copy keeps the previous target", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const first = materialize(request(outputPath));

  assert.throws(() => materialize(request(outputPath, {
    copyDirectory() {
      throw new Error("synthetic copy failure");
    },
  })), /synthetic copy failure/);

  assert.deepEqual(receiptAt(outputPath), first);
  assert.equal(existsSync(resolve(outputPath, ".codex-plugin/plugin.json")), true);
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
  }), /target digest mismatch/);
  assert.equal(existsSync(outputPath), false);
});

test("refuses to replace a receipt-owned directory after payload tampering", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  writeFileSync(resolve(outputPath, "tampered.txt"), "changed\n");

  assert.throws(() => materialize(request(outputPath)), /receipt payload digest mismatch/);
  assert.equal(readFileSync(resolve(outputPath, "tampered.txt"), "utf8"), "changed\n");
});

test("refuses payload mode tampering and preserves executable modes", (context) => {
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

  assert.throws(() => materialize(request(outputPath)), /receipt payload digest mismatch/);
  assert.equal(statSync(materializedExecutable).mode & 0o777, 0o600);
});

test("receipt identity and schema are required for replacement", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  const receiptPath = resolve(outputPath, RECEIPT);
  const receipt = receiptAt(outputPath);
  writeJson(receiptPath, { ...receipt, plugin: "other-plugin" });

  assert.throws(() => materialize(request(outputPath)), /refusing to replace unowned output/);

  writeJson(receiptPath, { ...receipt, unexpected: true });
  assert.throws(() => materialize(request(outputPath)), /invalid materialization receipt/);
  assert.equal(existsSync(resolve(outputPath, ".codex-plugin/plugin.json")), true);
});

test("a receipt symlink never grants output ownership", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  const receiptPath = resolve(outputPath, RECEIPT);
  const externalReceipt = resolve(temporaryRoot, "external-receipt.json");
  renameSync(receiptPath, externalReceipt);
  symlinkSync(externalReceipt, receiptPath);

  assert.throws(() => materialize(request(outputPath)), /real regular receipt/);
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
  assert.throws(() => materialize(request(filePath)), /real directory/);
  assert.throws(() => materialize(request(symlinkPath)), /symbolic output/);
  assert.throws(() => materialize(request(specialPath)), /special output/);
  assert.equal(readFileSync(filePath, "utf8"), "keep\n");
  assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
});

test("rejects a symlink pivot at the output parent", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outside = resolve(temporaryRoot, "outside");
  const pivot = resolve(temporaryRoot, "pivot");
  mkdirSync(outside);
  symlinkSync(outside, pivot);

  assert.throws(
    () => materialize(request(resolve(pivot, "consumer"))),
    /symbolic output parent|pivot/,
  );
  assert.equal(existsSync(resolve(outside, "consumer")), false);
});

test("revalidates ownership immediately before replacement", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const displaced = resolve(temporaryRoot, "displaced-owned-output");
  materialize(request(outputPath));

  let error;
  assert.throws(() => materialize(request(outputPath, {
    copyDirectory(source, destination, options) {
      cpSync(source, destination, options);
      renameSync(outputPath, displaced);
      mkdirSync(outputPath);
      writeFileSync(resolve(outputPath, "foreign.txt"), "foreign\n");
    },
  })), (caught) => {
    error = caught;
    return /ownership changed/u.test(caught.message);
  });

  assert.equal(readFileSync(resolve(outputPath, "foreign.txt"), "utf8"), "foreign\n");
  assert.equal(existsSync(resolve(displaced, RECEIPT)), true);
  assert.equal(existsSync(error.recoveryPath), true);
  assert.equal(basename(error.recoveryPath).startsWith(".consumer.stage-"), true);
});

test("rejects a copied target whose bytes differ and retains the old output", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const first = materialize(request(outputPath));

  assert.throws(() => materialize(request(outputPath, {
    copyDirectory(source, destination, options) {
      cpSync(source, destination, options);
      writeFileSync(resolve(destination, "copy-mutation.txt"), "mutation\n");
    },
  })), /copied target digest mismatch/);

  assert.deepEqual(receiptAt(outputPath), first);
  assert.equal(existsSync(resolve(outputPath, "copy-mutation.txt")), false);
});

test("retains a stage replaced after its claim and restores the old output", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  const first = materialize(request(outputPath));
  let replaced = false;
  let error;

  assert.throws(() => materialize(request(outputPath, {
    atomicFileSystem: {
      beforeSourceValidation({ phase, source }) {
        if (replaced || phase !== "before-reservation") return;
        replaced = true;
        rmSync(source, { recursive: true });
        mkdirSync(source);
        writeFileSync(resolve(source, "foreign.txt"), "foreign stage\n");
      },
    },
  })), (caught) => {
    error = caught;
    return /stage ownership changed|content or metadata changed/u.test(caught.message)
      || caught instanceof AggregateError;
  });

  assert.equal(replaced, true);
  assert.deepEqual(receiptAt(outputPath), first);
  assert.equal(readFileSync(resolve(error.recoveryPath, "foreign.txt"), "utf8"), "foreign stage\n");
});

test("retains a mutated backup instead of deleting it after publication", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  let backupPath;
  let error;

  assert.throws(() => materialize(request(outputPath, {
    atomicFileSystem: {
      beforeBackupValidation({ phase, backup }) {
        if (phase !== "before-cleanup") return;
        backupPath = backup;
        writeFileSync(resolve(backup, "foreign.txt"), "foreign backup\n");
      },
    },
  })), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(existsSync(resolve(outputPath, RECEIPT)), true);
  assert.equal(readFileSync(resolve(backupPath, "foreign.txt"), "utf8"), "foreign backup\n");
  assert.equal(
    [error.recoveryPath, ...(error.additionalRecoveryPaths || [])]
      .some((path) => backupPath.startsWith(path) || path === backupPath),
    true,
  );
});

test("retains a mutated backup when promotion needs the previous output restored", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  let stagePath;
  let stageMoves = 0;
  let backupPath;
  let error;

  assert.throws(() => materialize(request(outputPath, {
    atomicFileSystem: {
      beforeSourceValidation({ phase, source }) {
        if (phase === "before-backup") stagePath = source;
      },
      beforeBackupValidation({ phase, backup }) {
        if (phase !== "before-restore") return;
        backupPath = backup;
        writeFileSync(resolve(backup, "foreign.txt"), "foreign backup\n");
      },
      renameSync(from, to) {
        if (stagePath && dirname(from) === stagePath && ++stageMoves === 2) {
          throw new Error("synthetic promotion failure");
        }
        renameSync(from, to);
      },
    },
  })), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(existsSync(outputPath), false);
  assert.equal(existsSync(resolve(backupPath, RECEIPT)), true);
  assert.equal(readFileSync(resolve(backupPath, "foreign.txt"), "utf8"), "foreign backup\n");
  assert.equal(error.errors.some((item) => /synthetic promotion failure/u.test(item.message)), true);
});

test("foreign content added to a promoted entry is retained during rollback", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  let stagePath;
  let stageMoves = 0;
  let foreignPath;
  let error;

  assert.throws(() => materialize(request(outputPath, {
    atomicFileSystem: {
      beforeSourceValidation({ phase, source }) {
        if (phase === "before-backup") stagePath = source;
      },
      beforePromotedValidation({ phase, destination }) {
        if (phase !== "before-rollback" || foreignPath) return;
        foreignPath = resolve(destination, "foreign.txt");
        writeFileSync(foreignPath, "foreign promoted content\n");
      },
      renameSync(from, to) {
        if (stagePath && dirname(from) === stagePath && ++stageMoves === 2) {
          throw new Error("synthetic later promotion failure");
        }
        renameSync(from, to);
      },
    },
  })), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(readFileSync(foreignPath, "utf8"), "foreign promoted content\n");
  assert.equal(error.errors.length > 1, true);
  assert.equal(
    [error.recoveryPath, ...(error.additionalRecoveryPaths || [])]
      .some((path) => path === realpathSync(outputPath)),
    true,
  );
});

test("a rollback rename failure retains stage, public, and backup recovery", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  materialize(request(outputPath));
  let stagePath;
  let atomicOutputPath;
  let stageMoves = 0;
  let error;

  assert.throws(() => materialize(request(outputPath, {
    atomicFileSystem: {
      beforeExistingValidation({ outputRoot }) {
        atomicOutputPath = outputRoot;
      },
      beforeSourceValidation({ phase, source }) {
        if (phase === "before-backup") stagePath = source;
      },
      renameSync(from, to) {
        if (stagePath && dirname(from) === stagePath && ++stageMoves === 2) {
          throw new Error("synthetic promotion failure");
        }
        if (from.startsWith(atomicOutputPath + "/") && to.startsWith(stagePath + "/")) {
          throw new Error("synthetic rollback failure");
        }
        renameSync(from, to);
      },
    },
  })), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  const recoveryPaths = [error.recoveryPath, ...(error.additionalRecoveryPaths || [])];
  assert.equal(error.message.includes("recovery data retained"), true);
  assert.equal(
    recoveryPaths.some((path) => path === realpathSync(outputPath)),
    true,
    JSON.stringify(recoveryPaths),
  );
  assert.equal(recoveryPaths.some((path) => basename(path).startsWith(".consumer.stage-")), true);
  assert.equal(
    recoveryPaths.some((path) => path.includes(".consumer.backup-") || dirname(path).includes(".consumer.backup-")),
    true,
  );
});

test("an absent-output race preserves the foreign output and retains the stage", (context) => {
  const { temporaryRoot, request } = setup(context);
  const outputPath = resolve(temporaryRoot, "consumer");
  let injected = false;
  let error;

  assert.throws(() => materialize(request(outputPath, {
    atomicFileSystem: {
      beforeExistingValidation({ expectedExisting }) {
        if (expectedExisting || injected) return;
        injected = true;
        mkdirSync(outputPath);
        writeFileSync(resolve(outputPath, "foreign.txt"), "foreign race\n");
      },
    },
  })), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(readFileSync(resolve(outputPath, "foreign.txt"), "utf8"), "foreign race\n");
  assert.equal(existsSync(error.recoveryPath), true);
  assert.equal(basename(error.recoveryPath).startsWith(".consumer.stage-"), true);
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
