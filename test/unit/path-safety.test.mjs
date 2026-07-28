import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalPath } from "../../scripts/lib/path-safety.mjs";

test("canonicalPath resolves relative and absolute dangling symlink chains", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-canonical-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const canonicalRoot = realpathSync(root);
  const missingAbsoluteTarget = resolve(root, "targets/absolute");
  symlinkSync(missingAbsoluteTarget, resolve(root, "absolute-link"));
  symlinkSync("absolute-link", resolve(root, "relative-chain"));
  symlinkSync("targets/relative", resolve(root, "relative-link"));

  assert.equal(
    canonicalPath(resolve(root, "relative-chain/nested/file.md")),
    resolve(canonicalRoot, "targets/absolute/nested/file.md"),
  );
  assert.equal(
    canonicalPath(resolve(root, "relative-link/nested/file.md")),
    resolve(canonicalRoot, "targets/relative/nested/file.md"),
  );
});

test("canonicalPath fails closed on a dangling symlink loop", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-canonical-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync("loop-b", resolve(root, "loop-a"));
  symlinkSync("loop-a", resolve(root, "loop-b"));

  assert.throws(
    () => canonicalPath(resolve(root, "loop-a/nested")),
    /cannot resolve canonical path.*symbolic link loop/i,
  );
});
