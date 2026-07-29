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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { removeUndefined, stableJson, writeJson } from "../../scripts/lib/json.mjs";
import { sha256, treeHash } from "../../scripts/lib/hash.mjs";
import { withAtomicOutput } from "../../scripts/lib/atomic-output.mjs";

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

test("absent-only atomic promotion preserves errors and cannot clobber a concurrent tree", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-atomic-race-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const finalRoot = resolve(parent, "output");

  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      writeFileSync(resolve(stage, "new.txt"), "new\n");
    },
  }, {
    renameSync() {
      throw new Error("synthetic absent promotion failure");
    },
  }), /synthetic absent promotion failure/);
  assert.equal(existsSync(finalRoot), false);
  assert.deepEqual(readdirSync(parent), []);

  let raceError;
  assert.throws(() => withAtomicOutput({
    finalRoot,
    replaceExisting: false,
    build(stage) {
      writeFileSync(resolve(stage, "new.txt"), "new\n");
    },
  }, {
    renameSync(source, destination) {
      mkdirSync(finalRoot);
      writeFileSync(resolve(finalRoot, "concurrent.txt"), "concurrent\n");
      renameSync(source, destination);
    },
  }), (error) => {
    raceError = error;
    return ["EEXIST", "ENOTEMPTY"].includes(error.code);
  });
  assert.equal(["EEXIST", "ENOTEMPTY"].includes(raceError.code), true);
  assert.equal(readFileSync(resolve(finalRoot, "concurrent.txt"), "utf8"), "concurrent\n");
  assert.equal(existsSync(resolve(finalRoot, "new.txt")), false);
  assert.deepEqual(readdirSync(parent), ["output"]);
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
