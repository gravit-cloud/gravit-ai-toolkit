import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stableJson, writeJson } from "../../scripts/lib/json.mjs";
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
