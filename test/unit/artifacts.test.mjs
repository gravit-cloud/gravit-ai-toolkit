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
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { removeUndefined, stableJson, writeJson } from "../../scripts/lib/json.mjs";
import { sha256, sourceContextHash, treeHash } from "../../scripts/lib/hash.mjs";
import {
  MANAGED_REGISTRY_PATHS,
  promoteManagedPaths,
  withAtomicOutput,
} from "../../scripts/lib/atomic-output.mjs";

function writeManagedArtifact(root, relativePath, value) {
  const path = relativePath.endsWith(".json")
    ? resolve(root, relativePath)
    : resolve(root, relativePath, "marker.txt");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value + relativePath + "\n");
  return path;
}

function seedManagedArtifacts(root, value, selected = MANAGED_REGISTRY_PATHS) {
  return Object.fromEntries(selected.map((relativePath) => [
    relativePath,
    writeManagedArtifact(root, relativePath, value),
  ]));
}

test("stableJson sorts object keys recursively", () => {
  assert.equal(
    stableJson({ z: 1, a: { y: 2, b: 3 } }),
    '{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n',
  );
});

test("writeJson creates parent directories with stable two-space JSON", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-json-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = resolve(root, "nested", "catalog.json");

  writeJson(filePath, { b: [3, { z: true, a: false }], a: 1 });

  assert.equal(
    readFileSync(filePath, "utf8"),
    '{\n  "a": 1,\n  "b": [\n    3,\n    {\n      "a": false,\n      "z": true\n    }\n  ]\n}\n',
  );
});

test("removeUndefined is deterministic, non-mutating, and safe for own prototype-like keys", () => {
  const input = JSON.parse('{"z":null,"__proto__":{"polluted":true},"b":{"drop":null,"a":1}}');
  input.b.drop = undefined;
  const beforeKeys = Object.keys(input);

  const output = removeUndefined(input);

  assert.deepEqual(Object.keys(output), ["__proto__", "b", "z"]);
  assert.deepEqual(output.b, { a: 1 });
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(Object.hasOwn(output, "__proto__"), true);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(input), beforeKeys);
  assert.equal(Object.hasOwn(input.b, "drop"), true);
});

test("sha256 returns the SHA-256 digest of strings and buffers", () => {
  const expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  assert.equal(sha256("hello"), expected);
  assert.equal(sha256(Buffer.from("hello")), expected);
});

test("treeHash is independent of file creation order", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-hash-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, "b.txt"), "two\n");
  writeFileSync(resolve(root, "a.txt"), "one\n");
  const first = treeHash(root);
  rmSync(resolve(root, "a.txt"));
  writeFileSync(resolve(root, "a.txt"), "one\n");
  assert.equal(treeHash(root), first);
});

test("treeHash hashes sorted POSIX paths and file hashes", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-hash-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "nested"));
  writeFileSync(resolve(root, "z.txt"), "z");
  writeFileSync(resolve(root, "nested", "a.txt"), "a");

  assert.equal(treeHash(root), "ce575966a7e73b38ca7002f75c0e772c724d058f0d50887bb3287a03af59cfbf");
});

test("treeHash hashes a file as one basename and content-digest record", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-file-hash-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = resolve(root, "component.json");
  writeFileSync(filePath, "{\"fixture\":true}\n");

  assert.equal(
    treeHash(filePath),
    sha256("component.json\0" + sha256("{\"fixture\":true}\n")),
  );
});

test("sourceContextHash v1 separates the reproduced treeHash file-directory collision", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-context-collision-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const fileRoot = resolve(root, "file", "README.md");
  const directoryRoot = resolve(root, "directory", "README.md");
  mkdirSync(dirname(fileRoot), { recursive: true });
  mkdirSync(directoryRoot, { recursive: true });
  writeFileSync(fileRoot, "identical\n");
  writeFileSync(resolve(directoryRoot, "README.md"), "identical\n");

  assert.equal(treeHash(fileRoot), treeHash(directoryRoot), "reproduces the old collision");
  assert.equal(
    sourceContextHash(fileRoot),
    "5afda75f305de37e1fce6481b502ce67a2a4c128c80ed9042d8bccb834a19c49",
    "pins the gravit-ai-toolkit/source-context-hash/v1 domain and record format",
  );
  assert.notEqual(sourceContextHash(fileRoot), sourceContextHash(directoryRoot));
});

test("sourceContextHash v1 binds empty directory additions and removals", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-context-empty-directory-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(resolve(root, "payload.txt"), "payload\n");
  const withoutEmptyDirectory = sourceContextHash(root);

  mkdirSync(resolve(root, "empty"));
  assert.notEqual(sourceContextHash(root), withoutEmptyDirectory);
  rmdirSync(resolve(root, "empty"));
  assert.equal(sourceContextHash(root), withoutEmptyDirectory);
});

test("sourceContextHash v1 binds nested file and directory entry types", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-context-entry-type-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const fileTree = resolve(root, "file-tree");
  const directoryTree = resolve(root, "directory-tree");
  mkdirSync(resolve(fileTree, "nested"), { recursive: true });
  mkdirSync(resolve(directoryTree, "nested", "item"), { recursive: true });
  writeFileSync(resolve(fileTree, "nested", "item"), "");

  assert.notEqual(sourceContextHash(fileTree), sourceContextHash(directoryTree));
});

test("sourceContextHash v1 binds only portable regular-versus-executable state", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-context-mode-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = resolve(root, "script.sh");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");

  chmodSync(file, 0o600);
  const regular = sourceContextHash(root);
  chmodSync(file, 0o644);
  assert.equal(sourceContextHash(root), regular);
  chmodSync(file, 0o755);
  const executable = sourceContextHash(root);
  assert.notEqual(executable, regular);
  chmodSync(file, 0o700);
  assert.equal(sourceContextHash(root), executable);
});

test("withAtomicOutput preserves the old tree when build throws", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "state.txt"), "old\n");
    },
  });
  assert.throws(() => withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "state.txt"), "new\n");
      throw new Error("synthetic failure");
    },
  }), /synthetic failure/);
  assert.equal(readFileSync(resolve(finalRoot, "state.txt"), "utf8"), "old\n");
});

test("withAtomicOutput replaces an existing output only after the new tree is built", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "state.txt"), "old\n");
    },
  });

  withAtomicOutput({
    finalRoot,
    build(stage) {
      mkdirSync(resolve(stage, "nested"));
      writeFileSync(resolve(stage, "nested", "state.txt"), "new\n");
    },
  });

  assert.equal(existsSync(resolve(finalRoot, "state.txt")), false);
  assert.equal(readFileSync(resolve(finalRoot, "nested", "state.txt"), "utf8"), "new\n");
});

test("withAtomicOutput can require an absent final output without replacing races", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-absent-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  mkdirSync(finalRoot);

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build() {
      assert.fail("build must not run for an existing empty final output");
    },
  }), (error) => error.code === "EEXIST");
  assert.deepEqual(readdirSync(finalRoot), []);

  writeFileSync(resolve(finalRoot, "sentinel.txt"), "keep\n");

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build() {
      assert.fail("build must not run for an existing final output");
    },
  }), /atomic output already exists/);
  assert.equal(readFileSync(resolve(finalRoot, "sentinel.txt"), "utf8"), "keep\n");
  assert.deepEqual(readdirSync(parent), ["output"]);

  rmSync(finalRoot, { recursive: true });
  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      writeFileSync(resolve(stage, "new.txt"), "new\n");
      mkdirSync(finalRoot);
      writeFileSync(resolve(finalRoot, "concurrent.txt"), "concurrent\n");
    },
  }), /atomic output already exists/);
  assert.equal(readFileSync(resolve(finalRoot, "concurrent.txt"), "utf8"), "concurrent\n");
  assert.equal(existsSync(resolve(finalRoot, "new.txt")), false);
  assert.deepEqual(readdirSync(parent), ["output"]);
});

test("absent-only atomic promotion preserves the staged output structure", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-absent-success-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");

  withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      mkdirSync(resolve(stage, "nested"));
      writeFileSync(resolve(stage, "root.txt"), "root\n");
      writeFileSync(resolve(stage, "nested", "child.txt"), "child\n");
    },
  });

  assert.deepEqual(readdirSync(finalRoot), ["nested", "root.txt"]);
  assert.equal(readFileSync(resolve(finalRoot, "root.txt"), "utf8"), "root\n");
  assert.equal(readFileSync(resolve(finalRoot, "nested", "child.txt"), "utf8"), "child\n");
  assert.deepEqual(readdirSync(parent), ["output"]);
});

test("absent-only atomic promotion exclusively reserves the final output", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-race-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  let raced = false;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      writeFileSync(resolve(stage, "new.txt"), "new\n");
    },
  }, {
    mkdirSync(path, options) {
      if (path === finalRoot && !raced) {
        raced = true;
        mkdirSync(path);
      }
      return mkdirSync(path, options);
    },
    renameSync(source, destination) {
      // Exercises the old whole-directory promotion while the production
      // implementation is still RED. The reserving implementation races at
      // mkdirSync above and never reaches this branch.
      if (destination === finalRoot && !raced) {
        raced = true;
        mkdirSync(finalRoot);
      }
      return renameSync(source, destination);
    },
  }), (error) => error.code === "EEXIST");

  assert.equal(raced, true);
  assert.deepEqual(readdirSync(finalRoot), []);
  assert.deepEqual(readdirSync(parent), ["output"]);
});

test("absent-only atomic promotion rolls moved entries back after a later move fails", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-rollback-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  const promotionError = new Error("synthetic second-entry promotion failure");
  let stageRoot;
  let error;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      stageRoot = stage;
      writeFileSync(resolve(stage, "a.txt"), "a\n");
      writeFileSync(resolve(stage, "b.txt"), "b\n");
    },
  }, {
    renameSync(source, destination) {
      if (destination === resolve(finalRoot, "b.txt")) throw promotionError;
      return renameSync(source, destination);
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.deepEqual(error.errors, [promotionError]);
  assert.equal(error.recoveryPath, stageRoot);
  assert.deepEqual(readdirSync(stageRoot), ["a.txt", "b.txt"]);
  assert.equal(existsSync(finalRoot), false);
  assert.deepEqual(readdirSync(parent), [basename(stageRoot)]);
});

test("absent-only first-entry failure safely cleans the unpublished stage", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-first-move-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  const promotionError = new Error("synthetic first-entry promotion failure");

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      writeFileSync(resolve(stage, "a.txt"), "a\n");
      writeFileSync(resolve(stage, "b.txt"), "b\n");
    },
  }, {
    renameSync(source, destination) {
      if (destination === resolve(finalRoot, "a.txt")) throw promotionError;
      return renameSync(source, destination);
    },
  }), (error) => error === promotionError);

  assert.equal(existsSync(finalRoot), false);
  assert.deepEqual(readdirSync(parent), []);
});

test("absent-only promotion rolls back when its empty stage cannot be removed", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-stage-rmdir-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  const stageCleanupError = new Error("synthetic empty-stage cleanup failure");
  let stageRoot;
  let error;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      stageRoot = stage;
      writeFileSync(resolve(stage, "a.txt"), "a\n");
      writeFileSync(resolve(stage, "b.txt"), "b\n");
    },
  }, {
    rmdirSync(path) {
      if (path === stageRoot) throw stageCleanupError;
      return rmdirSync(path);
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.deepEqual(error.errors, [stageCleanupError]);
  assert.equal(error.recoveryPath, stageRoot);
  assert.deepEqual(readdirSync(stageRoot), ["a.txt", "b.txt"]);
  assert.equal(existsSync(finalRoot), false);
  assert.deepEqual(readdirSync(parent), [basename(stageRoot)]);
});

test("absent-only rollback retains a foreign file nested in a moved directory", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-nested-foreign-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  const promotionError = new Error("synthetic later promotion failure");
  let stageRoot;
  let error;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      stageRoot = stage;
      mkdirSync(resolve(stage, "a"));
      writeFileSync(resolve(stage, "a", "owned.txt"), "owned\n");
      writeFileSync(resolve(stage, "b.txt"), "b\n");
    },
  }, {
    renameSync(source, destination) {
      if (destination === resolve(finalRoot, "b.txt")) {
        writeFileSync(resolve(finalRoot, "a", "foreign.txt"), "foreign\n");
        throw promotionError;
      }
      return renameSync(source, destination);
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.deepEqual(error.errors, [promotionError]);
  assert.equal(error.recoveryPath, stageRoot);
  assert.equal(Object.hasOwn(error, "additionalRecoveryPaths"), false);
  assert.equal(readFileSync(resolve(stageRoot, "a", "owned.txt"), "utf8"), "owned\n");
  assert.equal(readFileSync(resolve(stageRoot, "a", "foreign.txt"), "utf8"), "foreign\n");
  assert.equal(readFileSync(resolve(stageRoot, "b.txt"), "utf8"), "b\n");
  assert.equal(existsSync(finalRoot), false);
  assert.deepEqual(readdirSync(parent), [basename(stageRoot)]);
});

test("absent-only rollback preserves recovery data and an unexpected foreign entry", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-foreign-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  const promotionError = new Error("synthetic promotion collision");
  let error;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      writeFileSync(resolve(stage, "a.txt"), "a\n");
      writeFileSync(resolve(stage, "b.txt"), "b\n");
    },
  }, {
    renameSync(source, destination) {
      if (destination === resolve(finalRoot, "b.txt")) {
        writeFileSync(resolve(finalRoot, "foreign.txt"), "foreign\n");
        throw promotionError;
      }
      return renameSync(source, destination);
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(error.errors[0], promotionError);
  assert.match(error.message, /recovery data retained/);
  assert.match(basename(error.recoveryPath), /^\.output\.stage-/);
  assert.deepEqual(error.additionalRecoveryPaths, [finalRoot]);
  assert.deepEqual(readdirSync(error.recoveryPath), ["a.txt", "b.txt"]);
  assert.equal(readFileSync(resolve(finalRoot, "foreign.txt"), "utf8"), "foreign\n");
  assert.deepEqual(readdirSync(finalRoot), ["foreign.txt"]);
});

test("absent-only rollback failure retains both staged and promoted recovery data", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-recovery-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  const promotionError = new Error("synthetic promotion failure");
  const rollbackError = new Error("synthetic rollback failure");
  let stageRoot;
  let error;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      stageRoot = stage;
      writeFileSync(resolve(stage, "a.txt"), "a\n");
      writeFileSync(resolve(stage, "b.txt"), "b\n");
    },
  }, {
    renameSync(source, destination) {
      if (destination === resolve(finalRoot, "b.txt")) throw promotionError;
      if (source === resolve(finalRoot, "a.txt") && destination === resolve(stageRoot, "a.txt")) {
        throw rollbackError;
      }
      return renameSync(source, destination);
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(error.errors[0], promotionError);
  assert.equal(error.errors[1], rollbackError);
  assert.equal(error.recoveryPath, stageRoot);
  assert.deepEqual(error.additionalRecoveryPaths, [finalRoot]);
  assert.deepEqual(readdirSync(stageRoot), ["b.txt"]);
  assert.equal(readFileSync(resolve(finalRoot, "a.txt"), "utf8"), "a\n");
  assert.deepEqual(readdirSync(finalRoot), ["a.txt"]);
});

test("absent-only recovery stages are never offered to recursive cleanup", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-cleanup-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  const promotionError = new Error("synthetic promotion failure");
  const cleanupError = new Error("synthetic stage cleanup failure");
  let stageRoot;
  let error;
  let cleanupAttempted = false;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      stageRoot = stage;
      writeFileSync(resolve(stage, "a.txt"), "a\n");
      writeFileSync(resolve(stage, "b.txt"), "b\n");
    },
  }, {
    renameSync(source, destination) {
      if (destination === resolve(finalRoot, "b.txt")) throw promotionError;
      return renameSync(source, destination);
    },
    rmSync(path, options) {
      if (path === stageRoot) {
        cleanupAttempted = true;
        throw cleanupError;
      }
      return rmSync(path, options);
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.deepEqual(error.errors, [promotionError]);
  assert.equal(error.recoveryPath, stageRoot);
  assert.equal(cleanupAttempted, false);
  assert.deepEqual(readdirSync(stageRoot), ["a.txt", "b.txt"]);
  assert.equal(existsSync(finalRoot), false);
});

test("withAtomicOutput never deletes a pre-existing sibling backup path", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  const foreignBackup = resolve(parent, "output.backup");
  mkdirSync(foreignBackup);
  writeFileSync(resolve(foreignBackup, "owned-by-user.txt"), "keep\n");
  withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "state.txt"), "new\n");
    },
  });
  assert.equal(readFileSync(resolve(foreignBackup, "owned-by-user.txt"), "utf8"), "keep\n");
});

test("withAtomicOutput removes its stage when backup allocation fails", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  mkdirSync(finalRoot);
  writeFileSync(resolve(finalRoot, "state.txt"), "old\n");
  let allocation = 0;
  let stage;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    build() {
      assert.fail("build must not run when backup allocation fails");
    },
  }, {
    mkdtempSync(prefix) {
      allocation += 1;
      if (allocation === 2) throw new Error("synthetic backup allocation failure");
      stage = mkdtempSync(prefix);
      return stage;
    },
  }), /synthetic backup allocation failure/);

  assert.equal(existsSync(stage), false);
  assert.equal(readFileSync(resolve(finalRoot, "state.txt"), "utf8"), "old\n");
  assert.deepEqual(readdirSync(parent), ["output"]);
});

test("withAtomicOutput restores only the old tree when promotion fails", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  mkdirSync(finalRoot);
  writeFileSync(resolve(finalRoot, "old-only.txt"), "old\n");
  let rename = 0;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "new-only.txt"), "new\n");
    },
  }, {
    renameSync(source, destination) {
      rename += 1;
      if (rename === 2) throw new Error("synthetic promotion failure");
      renameSync(source, destination);
    },
  }), /synthetic promotion failure/);

  assert.equal(readFileSync(resolve(finalRoot, "old-only.txt"), "utf8"), "old\n");
  assert.equal(existsSync(resolve(finalRoot, "new-only.txt")), false);
  assert.deepEqual(readdirSync(parent), ["output"]);
});

test("withAtomicOutput retains and reports recovery data when rollback fails", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  mkdirSync(finalRoot);
  writeFileSync(resolve(finalRoot, "old-only.txt"), "old\n");
  let rename = 0;

  let error;
  assert.throws(() => withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "new-only.txt"), "new\n");
    },
  }, {
    renameSync(source, destination) {
      rename += 1;
      if (rename === 2) throw new Error("synthetic promotion failure");
      if (rename === 3) throw new Error("synthetic rollback failure");
      renameSync(source, destination);
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.match(error.message, /could not promote atomic output or restore the previous output/);
  assert.equal(error.errors[0].message, "synthetic promotion failure");
  assert.equal(error.errors[1].message, "synthetic rollback failure");
  const recoveryRoot = dirname(error.recoveryPath);
  assert.equal(dirname(recoveryRoot), parent);
  assert.match(basename(recoveryRoot), /^\.output\.backup-/);
  assert.equal(readFileSync(resolve(error.recoveryPath, "old-only.txt"), "utf8"), "old\n");
  assert.equal(existsSync(finalRoot), false);
  assert.deepEqual(readdirSync(parent), [basename(recoveryRoot)]);
});

test("withAtomicOutput reports retained backup when output reappears during promotion", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");
  mkdirSync(finalRoot);
  writeFileSync(resolve(finalRoot, "old-only.txt"), "old\n");
  let rename = 0;
  let error;

  assert.throws(() => withAtomicOutput({
    finalRoot,
    build(stage) {
      writeFileSync(resolve(stage, "new-only.txt"), "new\n");
    },
  }, {
    renameSync(source, destination) {
      rename += 1;
      if (rename === 2) {
        mkdirSync(finalRoot);
        writeFileSync(resolve(finalRoot, "concurrent.txt"), "concurrent\n");
        throw new Error("synthetic promotion failure");
      }
      renameSync(source, destination);
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(error.errors[0].message, "synthetic promotion failure");
  assert.match(error.errors[1].message, /output path reappeared during promotion/);
  assert.equal(readFileSync(resolve(finalRoot, "concurrent.txt"), "utf8"), "concurrent\n");
  assert.equal(readFileSync(resolve(error.recoveryPath, "old-only.txt"), "utf8"), "old\n");
  assert.equal(dirname(dirname(error.recoveryPath)), parent);
});

test("promoteManagedPaths rolls every managed path back after a mid-promotion failure", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  const oldPaths = seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(stageRoot, "new:");
  writeFileSync(resolve(repositoryRoot, "unrelated.txt"), "keep\n");
  let stagedRenames = 0;

  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      if (from.startsWith(stageRoot) && ++stagedRenames === 3) {
        throw new Error("synthetic promotion failure");
      }
      renameSync(from, to);
    },
  }), /synthetic promotion failure/);

  for (const relativePath of MANAGED_REGISTRY_PATHS) {
    assert.equal(readFileSync(oldPaths[relativePath], "utf8"), "old:" + relativePath + "\n");
  }
  assert.equal(readFileSync(resolve(repositoryRoot, "unrelated.txt"), "utf8"), "keep\n");
});

test("promoteManagedPaths preflights every staged artifact before moving production", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-preflight-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  const oldPaths = seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(
    stageRoot,
    "new:",
    MANAGED_REGISTRY_PATHS.filter((path) => path !== "registry/lock.json"),
  );

  assert.throws(
    () => promoteManagedPaths({ repositoryRoot, stageRoot }),
    /missing staged artifact: registry\/lock\.json/,
  );

  for (const relativePath of MANAGED_REGISTRY_PATHS) {
    assert.equal(readFileSync(oldPaths[relativePath], "utf8"), "old:" + relativePath + "\n");
  }
  assert.equal(
    readdirSync(parent).some((entry) => entry.startsWith(".repository.promote-")),
    false,
  );
});

test("promoteManagedPaths rejects malformed required source-claim maps before publication", (context) => {
  const malformedClaims = [
    {},
    Object.create({ inherited: true }),
    {
      ...Object.fromEntries(MANAGED_REGISTRY_PATHS.map((path) => [path, {}])),
      unexpected: {},
    },
  ];

  for (const [index, sourceClaims] of malformedClaims.entries()) {
    const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-claim-shape-"));
    context.after(() => rmSync(parent, { recursive: true, force: true }));
    const repositoryRoot = resolve(parent, "repository");
    const stageRoot = resolve(parent, "stage");
    const oldPaths = seedManagedArtifacts(repositoryRoot, "old:");
    seedManagedArtifacts(stageRoot, "new:");
    let error;

    assert.throws(() => promoteManagedPaths({
      repositoryRoot,
      stageRoot,
      sourceClaims,
      requireSourceClaims: true,
    }), (caught) => {
      error = caught;
      return caught instanceof AggregateError;
    }, "case " + index);

    assert.equal(error.recoveryPath, stageRoot, "case " + index);
    for (const relativePath of MANAGED_REGISTRY_PATHS) {
      assert.equal(
        readFileSync(oldPaths[relativePath], "utf8"),
        "old:" + relativePath + "\n",
        "case " + index,
      );
    }
  }
});

test("promoteManagedPaths replaces mixed existing and missing targets without touching siblings", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-mixed-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  seedManagedArtifacts(
    repositoryRoot,
    "old:",
    ["plugins", "registry/lock.json"],
  );
  const newPaths = seedManagedArtifacts(stageRoot, "new:");
  mkdirSync(resolve(repositoryRoot, ".github"), { recursive: true });
  writeFileSync(resolve(repositoryRoot, ".github/workflow.yml"), "keep\n");

  promoteManagedPaths({ repositoryRoot, stageRoot });

  for (const relativePath of MANAGED_REGISTRY_PATHS) {
    const publicPath = relativePath.endsWith(".json")
      ? resolve(repositoryRoot, relativePath)
      : resolve(repositoryRoot, relativePath, "marker.txt");
    assert.equal(readFileSync(publicPath, "utf8"), "new:" + relativePath + "\n");
    assert.equal(existsSync(newPaths[relativePath]), false);
  }
  assert.equal(readFileSync(resolve(repositoryRoot, ".github/workflow.yml"), "utf8"), "keep\n");
  assert.equal(
    readdirSync(parent).some((entry) => entry.startsWith(".repository.promote-")),
    false,
  );
});

test("promoteManagedPaths restores mixed target absence after rollback", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-mixed-rollback-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  const oldPaths = seedManagedArtifacts(
    repositoryRoot,
    "old:",
    ["plugins", "registry/lock.json"],
  );
  seedManagedArtifacts(stageRoot, "new:");
  let stagedRenames = 0;
  let error;

  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      if (from.startsWith(stageRoot) && ++stagedRenames === 3) {
        throw new Error("synthetic mixed promotion failure");
      }
      renameSync(from, to);
    },
  }), (caught) => {
    error = caught;
    return /synthetic mixed promotion failure/.test(caught.message);
  });

  assert.equal(error.recoveryPath, stageRoot);
  assert.equal(readFileSync(oldPaths.plugins, "utf8"), "old:plugins\n");
  assert.equal(readFileSync(oldPaths["registry/lock.json"], "utf8"), "old:registry/lock.json\n");
  assert.equal(existsSync(resolve(repositoryRoot, ".claude-plugin")), false);
  assert.equal(existsSync(resolve(repositoryRoot, ".agents")), false);
});

test("promoteManagedPaths retains explicit recovery paths when rollback fails", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-recovery-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(stageRoot, "new:");
  let stagedRenames = 0;
  let error;

  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      if (from.startsWith(stageRoot) && ++stagedRenames === 3) {
        throw new Error("synthetic promotion failure");
      }
      if (from.includes("/backup/2")) {
        throw new Error("synthetic rollback failure");
      }
      renameSync(from, to);
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.match(error.message, /registry promotion and rollback failed/);
  assert.equal(error.errors[0].message, "synthetic promotion failure");
  assert.equal(error.errors[1].message, "synthetic rollback failure");
  assert.match(basename(error.recoveryPath), /^\.repository\.promote-/);
  assert.equal(existsSync(resolve(error.recoveryPath, "backup/2")), true);
  assert.equal(error.additionalRecoveryPaths.includes(stageRoot), true);
  assert.equal(existsSync(error.recoveryPath), true);
});

test("promoteManagedPaths rejects staged and production symlink pivots before mutation", (context) => {
  const cases = ["staged-artifact", "production-parent", "dangling-production-parent"];
  for (const kind of cases) {
    const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-pivot-"));
    context.after(() => rmSync(parent, { recursive: true, force: true }));
    const repositoryRoot = resolve(parent, "repository");
    const stageRoot = resolve(parent, "stage");
    const outside = resolve(parent, "outside");
    const oldPaths = seedManagedArtifacts(repositoryRoot, "old:");
    seedManagedArtifacts(stageRoot, "new:");
    mkdirSync(outside);

    if (kind === "staged-artifact") {
      rmSync(resolve(stageRoot, "plugins"), { recursive: true });
      symlinkSync(outside, resolve(stageRoot, "plugins"));
    } else {
      rmSync(resolve(repositoryRoot, ".agents"), { recursive: true });
      const target = kind === "production-parent"
        ? outside
        : resolve(parent, "missing-outside");
      symlinkSync(target, resolve(repositoryRoot, ".agents"));
      if (kind === "production-parent") {
        writeFileSync(resolve(outside, "sentinel.txt"), "keep\n");
      }
    }

    assert.throws(
      () => promoteManagedPaths({ repositoryRoot, stageRoot }),
      /unsafe|symbolic|escapes|pivot/,
      kind,
    );
    for (const relativePath of ["plugins", ".claude-plugin/marketplace.json", "registry/lock.json"]) {
      assert.equal(readFileSync(oldPaths[relativePath], "utf8"), "old:" + relativePath + "\n", kind);
    }
    if (kind === "production-parent") {
      assert.equal(readFileSync(resolve(outside, "sentinel.txt"), "utf8"), "keep\n");
    }
  }
});

test("promoteManagedPaths preserves foreign content introduced into a promoted directory", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-foreign-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  const oldPaths = seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(stageRoot, "new:");
  let stagedRenames = 0;
  let error;

  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      if (from.startsWith(stageRoot)) {
        stagedRenames += 1;
        if (stagedRenames === 2) {
          writeFileSync(resolve(repositoryRoot, "plugins/foreign.txt"), "foreign\n");
          throw new Error("synthetic later promotion failure");
        }
      }
      renameSync(from, to);
    },
  }), (caught) => {
    error = caught;
    return /synthetic later promotion failure/.test(caught.message);
  });

  assert.equal(error.recoveryPath, stageRoot);
  assert.equal(readFileSync(oldPaths.plugins, "utf8"), "old:plugins\n");
  assert.equal(readFileSync(resolve(stageRoot, "plugins/foreign.txt"), "utf8"), "foreign\n");
});

test("promoteManagedPaths retains a foreign transaction-root sibling discovered after success", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-transaction-foreign-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(stageRoot, "new:");
  let transactionRoot;
  let stagedRenames = 0;
  let error;

  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      if (to.includes("/backup/")) transactionRoot = dirname(dirname(to));
      renameSync(from, to);
      if (from.startsWith(stageRoot) && ++stagedRenames === MANAGED_REGISTRY_PATHS.length) {
        writeFileSync(resolve(transactionRoot, "foreign.txt"), "foreign\n");
      }
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(error.recoveryPath, transactionRoot);
  assert.equal(readFileSync(resolve(transactionRoot, "foreign.txt"), "utf8"), "foreign\n");
  for (const relativePath of MANAGED_REGISTRY_PATHS) {
    const publicPath = relativePath.endsWith(".json")
      ? resolve(repositoryRoot, relativePath)
      : resolve(repositoryRoot, relativePath, "marker.txt");
    assert.equal(readFileSync(publicPath, "utf8"), "new:" + relativePath + "\n");
  }
});

test("promoteManagedPaths rejects a staged artifact changed after its target was backed up", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-staged-mutation-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  const oldPaths = seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(stageRoot, "new:");
  let error;

  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      renameSync(from, to);
      if (from === resolve(repositoryRoot, "plugins")) {
        writeFileSync(resolve(stageRoot, "plugins/marker.txt"), "changed staged plugins\n");
      }
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(error.recoveryPath, stageRoot);
  assert.equal(readFileSync(oldPaths.plugins, "utf8"), "old:plugins\n");
  assert.equal(
    readFileSync(resolve(stageRoot, "plugins/marker.txt"), "utf8"),
    "changed staged plugins\n",
  );
});

test("promoteManagedPaths retains a replaced source root before its first validation", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-source-replacement-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  const oldPaths = seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(stageRoot, "new:");
  let replaced = false;
  let error;

  assert.throws(() => promoteManagedPaths({ repositoryRoot, stageRoot }, {
    beforeSourceValidation({ phase, relativePath, source }) {
      if (replaced || phase !== "before-backup" || relativePath !== "plugins") return;
      replaced = true;
      rmSync(source, { recursive: true });
      mkdirSync(source);
      writeFileSync(resolve(source, "foreign.txt"), "foreign replacement\n");
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(replaced, true);
  assert.equal(error.recoveryPath, stageRoot);
  assert.equal(
    readFileSync(resolve(stageRoot, "plugins/foreign.txt"), "utf8"),
    "foreign replacement\n",
  );
  assert.equal(readFileSync(oldPaths.plugins, "utf8"), "old:plugins\n");
});

test("promoteManagedPaths audits promoted directory contents before reporting success", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-public-mutation-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  const oldPaths = seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(stageRoot, "new:");
  let error;

  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      renameSync(from, to);
      if (from === resolve(stageRoot, "plugins")) {
        mkdirSync(resolve(repositoryRoot, "plugins/unexpected"));
        writeFileSync(resolve(repositoryRoot, "plugins/unexpected/foreign.txt"), "foreign\n");
      }
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(error.recoveryPath, stageRoot);
  assert.equal(readFileSync(oldPaths.plugins, "utf8"), "old:plugins\n");
  assert.equal(
    readFileSync(resolve(stageRoot, "plugins/unexpected/foreign.txt"), "utf8"),
    "foreign\n",
  );
});

test("promoteManagedPaths never restores or deletes a backup with changed modes", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-backup-mode-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(stageRoot, "new:");
  let changedBackup;
  let transactionRoot;
  let error;

  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      renameSync(from, to);
      if (!changedBackup && from === resolve(repositoryRoot, "plugins")) {
        transactionRoot = dirname(dirname(to));
        changedBackup = resolve(to, "marker.txt");
        chmodSync(changedBackup, 0o600);
      }
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(error.recoveryPath, transactionRoot);
  assert.equal(error.additionalRecoveryPaths.includes(stageRoot), true);
  assert.equal(existsSync(resolve(repositoryRoot, "plugins")), false);
  assert.equal(readFileSync(changedBackup, "utf8"), "old:plugins\n");
  assert.equal(statSync(changedBackup).mode & 0o777, 0o600);
  assert.equal(readFileSync(resolve(stageRoot, "plugins/marker.txt"), "utf8"), "new:plugins\n");
});

test("promoteManagedPaths retains an unexpected sibling in its backup directory", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-promote-backup-sibling-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  const stageRoot = resolve(parent, "stage");
  seedManagedArtifacts(repositoryRoot, "old:");
  seedManagedArtifacts(stageRoot, "new:");
  let transactionRoot;
  let foreignPath;
  let error;

  assert.throws(() => promoteManagedPaths({
    repositoryRoot,
    stageRoot,
    rename(from, to) {
      renameSync(from, to);
      if (from === resolve(repositoryRoot, "plugins")) {
        transactionRoot = dirname(dirname(to));
        foreignPath = resolve(transactionRoot, "backup/foreign.txt");
        writeFileSync(foreignPath, "foreign backup sibling\n");
      }
    },
  }), (caught) => {
    error = caught;
    return caught instanceof AggregateError;
  });

  assert.equal(error.recoveryPath, transactionRoot);
  assert.equal(readFileSync(foreignPath, "utf8"), "foreign backup sibling\n");
  for (const relativePath of MANAGED_REGISTRY_PATHS) {
    const publicPath = relativePath.endsWith(".json")
      ? resolve(repositoryRoot, relativePath)
      : resolve(repositoryRoot, relativePath, "marker.txt");
    assert.equal(readFileSync(publicPath, "utf8"), "new:" + relativePath + "\n");
  }
});
