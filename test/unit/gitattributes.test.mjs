import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function runGit(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function repository(context, prefix) {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const initialized = runGit(root, ["init", "--quiet"]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const attributes = readFileSync(resolve(repositoryRoot, ".gitattributes"));
  writeFileSync(resolve(root, ".gitattributes"), attributes);
  return root;
}

test("generated plugin vendor bytes bypass whitespace errors without weakening maintained files", (context) => {
  const generatedRoot = repository(context, "registry-attributes-generated-");
  const generatedPath = resolve(generatedRoot, "plugins/vendor/payload.md");
  mkdirSync(dirname(generatedPath), { recursive: true });
  const vendorBytes = Buffer.from(" \tvendor trailing  \r\n\r\n", "utf8");
  writeFileSync(generatedPath, vendorBytes);
  assert.equal(runGit(generatedRoot, ["add", ".gitattributes", "plugins/vendor/payload.md"]).status, 0);
  const generatedCheck = runGit(generatedRoot, ["diff", "--cached", "--check"]);
  assert.equal(generatedCheck.status, 0, generatedCheck.stdout + generatedCheck.stderr);
  assert.deepEqual(readFileSync(generatedPath), vendorBytes);

  const maintainedRoot = repository(context, "registry-attributes-maintained-");
  const maintainedPath = resolve(maintainedRoot, "scripts/maintained.mjs");
  mkdirSync(dirname(maintainedPath), { recursive: true });
  writeFileSync(maintainedPath, "export const maintained = true;  \n");
  assert.equal(runGit(maintainedRoot, ["add", ".gitattributes", "scripts/maintained.mjs"]).status, 0);
  const maintainedCheck = runGit(maintainedRoot, ["diff", "--cached", "--check"]);
  assert.notEqual(maintainedCheck.status, 0);
  assert.match(maintainedCheck.stdout, /scripts\/maintained\.mjs:1: trailing whitespace/);

  const policy = readFileSync(resolve(repositoryRoot, ".gitattributes"), "utf8");
  assert.doesNotMatch(policy, /(?:^|\s)(?:binary|-diff)(?:\s|$)/m);
});
