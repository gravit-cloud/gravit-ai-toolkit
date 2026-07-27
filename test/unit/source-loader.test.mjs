import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageSource } from "../../scripts/lib/source-loader.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = resolve(repositoryRoot, "test/fixtures/skill-only-source");

test("stages a complete local source", (context) => {
  const sandbox = mkdtempSync(resolve(tmpdir(), "registry-repository-"));
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(sandbox, { recursive: true, force: true }));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  mkdirSync(resolve(sandbox, "source/plugin/skills/parent"), { recursive: true });
  writeFileSync(resolve(sandbox, "source/README.md"), "# Complete source\n");
  writeFileSync(resolve(sandbox, "source/plugin/skills/parent/SKILL.md"), "# Parent\n");

  const sourceRoot = stageSource({
    plugin: {
      name: "local",
      source: { type: "local", path: "source", root: "plugin" },
    },
    repositoryRoot: sandbox,
    destinationRoot,
  });

  assert.equal(existsSync(resolve(sourceRoot, "skills/parent/SKILL.md")), true);
  assert.equal(existsSync(resolve(destinationRoot, "local/README.md")), true);
});

test("GitHub staging fetches the repository root at the SHA", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  const calls = [];

  const sourceRoot = stageSource({
    plugin: {
      name: "remote",
      source: {
        type: "github",
        repo: "owner/repository",
        ref: "v1.0.0",
        sha: "0123456789abcdef0123456789abcdef01234567",
        root: ".",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub(input) {
      calls.push(input);
      cpSync(fixture, input.destination, { recursive: true });
      writeFileSync(resolve(input.destination, "README.md"), "# Repository root\n");
    },
  });

  assert.deepEqual(calls.map(({ repo, sha }) => ({ repo, sha })), [{
    repo: "owner/repository",
    sha: "0123456789abcdef0123456789abcdef01234567",
  }]);
  assert.equal(calls[0].destination, resolve(destinationRoot, "remote"));
  assert.equal(sourceRoot, realpathSync(resolve(destinationRoot, "remote")));
  assert.equal(existsSync(resolve(sourceRoot, "README.md")), true);
  assert.equal(existsSync(resolve(sourceRoot, "skills/parent/guide.md")), true);
});

test("rejects a local source symlink that escapes the repository", (context) => {
  const sandbox = mkdtempSync(resolve(tmpdir(), "registry-repository-"));
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(sandbox, { recursive: true, force: true }));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  mkdirSync(resolve(sandbox, "sources"));
  symlinkSync(fixture, resolve(sandbox, "sources/escaped"), "dir");

  assert.throws(() => stageSource({
    plugin: {
      name: "escaped",
      source: { type: "local", path: "sources/escaped", root: "." },
    },
    repositoryRoot: sandbox,
    destinationRoot,
  }), /local plugin source escapes source root/);
});

test("rejects a local source path that lexically escapes the repository", (context) => {
  const sandbox = mkdtempSync(resolve(tmpdir(), "registry-repository-"));
  const repository = resolve(sandbox, "repository");
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(sandbox, { recursive: true, force: true }));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  mkdirSync(repository);
  mkdirSync(resolve(sandbox, "outside"));

  assert.throws(() => stageSource({
    plugin: {
      name: "escaped",
      source: { type: "local", path: "../outside", root: "." },
    },
    repositoryRoot: repository,
    destinationRoot,
  }), /local plugin source escapes source root/);
  assert.equal(existsSync(resolve(destinationRoot, "escaped")), false);
});

test("rejects and removes a configured root outside its staged source", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));

  assert.throws(() => stageSource({
    plugin: {
      name: "remote",
      source: {
        type: "github",
        repo: "owner/repository",
        sha: "0123456789abcdef0123456789abcdef01234567",
        root: "../outside",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub({ destination }) {
      writeFileSync(resolve(destination, "partial.txt"), "partial\n");
    },
  }), /plugin source root escapes source root/);
  assert.equal(existsSync(resolve(destinationRoot, "remote")), false);
});

test("rejects and removes a staged root symlink that escapes", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  const outside = mkdtempSync(resolve(tmpdir(), "registry-outside-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  context.after(() => rmSync(outside, { recursive: true, force: true }));

  assert.throws(() => stageSource({
    plugin: {
      name: "remote",
      source: {
        type: "github",
        repo: "owner/repository",
        sha: "0123456789abcdef0123456789abcdef01234567",
        root: "plugin",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub({ destination }) {
      symlinkSync(outside, resolve(destination, "plugin"), "dir");
    },
  }), /plugin source root escapes source root/);
  assert.equal(existsSync(resolve(destinationRoot, "remote")), false);
});

test("removes a partial stage when GitHub fetching fails", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));

  assert.throws(() => stageSource({
    plugin: {
      name: "remote",
      source: {
        type: "github",
        repo: "owner/repository",
        sha: "0123456789abcdef0123456789abcdef01234567",
        root: ".",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub({ destination }) {
      writeFileSync(resolve(destination, "partial.txt"), "partial\n");
      throw new Error("synthetic fetch failure");
    },
  }), /synthetic fetch failure/);
  assert.equal(existsSync(resolve(destinationRoot, "remote")), false);
});

test("does not merge a source into an existing stage", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  const existingStage = resolve(destinationRoot, "local");
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  mkdirSync(existingStage);
  writeFileSync(resolve(existingStage, "owned.txt"), "keep\n");

  assert.throws(() => stageSource({
    plugin: {
      name: "local",
      source: { type: "local", path: "test/fixtures/skill-only-source", root: "." },
    },
    repositoryRoot,
    destinationRoot,
  }), /plugin staging destination already exists/);
  assert.equal(readFileSync(resolve(existingStage, "owned.txt"), "utf8"), "keep\n");
  assert.equal(existsSync(resolve(existingStage, "skills")), false);
});

test("rejects a mutable GitHub selector before fetching", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  let fetched = false;

  assert.throws(() => stageSource({
    plugin: {
      name: "remote",
      source: {
        type: "github",
        repo: "owner/repository",
        sha: "main",
        root: ".",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub() {
      fetched = true;
    },
  }), /GitHub source SHA must be an exact 40-character lowercase commit/);
  assert.equal(fetched, false);
  assert.equal(existsSync(resolve(destinationRoot, "remote")), false);
});

test("rejects a staged source symlink that escapes its destination", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  const outside = mkdtempSync(resolve(tmpdir(), "registry-outside-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(resolve(outside, "owned.txt"), "outside\n");

  assert.throws(() => stageSource({
    plugin: {
      name: "remote",
      source: {
        type: "github",
        repo: "owner/repository",
        sha: "0123456789abcdef0123456789abcdef01234567",
        root: ".",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub({ destination }) {
      rmSync(destination, { recursive: true, force: true });
      symlinkSync(outside, destination, "dir");
    },
  }), /plugin staging destination escapes source root/);
  assert.equal(lstatSync(resolve(destinationRoot, "remote")).isSymbolicLink(), true);
  assert.equal(readFileSync(resolve(outside, "owned.txt"), "utf8"), "outside\n");
});

test("requires the configured source root to be a directory", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));

  assert.throws(() => stageSource({
    plugin: {
      name: "remote",
      source: {
        type: "github",
        repo: "owner/repository",
        sha: "0123456789abcdef0123456789abcdef01234567",
        root: "README.md",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub({ destination }) {
      writeFileSync(resolve(destination, "README.md"), "# Not a root directory\n");
    },
  }), /plugin source root must be a directory/);
  assert.equal(existsSync(resolve(destinationRoot, "remote")), false);
});

test("rejects ambiguous GitHub repository syntax before fetching", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  let fetched = false;

  assert.throws(() => stageSource({
    plugin: {
      name: "remote",
      source: {
        type: "github",
        repo: "owner/repository#main",
        sha: "0123456789abcdef0123456789abcdef01234567",
        root: ".",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub() {
      fetched = true;
    },
  }), /GitHub source repository must be an owner\/repository pair/);
  assert.equal(fetched, false);
  assert.equal(existsSync(resolve(destinationRoot, "remote")), false);
});

test("rejects an unsupported source type before fetching", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  let fetched = false;

  assert.throws(() => stageSource({
    plugin: {
      name: "unsupported",
      source: {
        type: "gitlab",
        repo: "owner/repository#main",
        sha: "main",
        root: ".",
      },
    },
    repositoryRoot,
    destinationRoot,
    fetchGitHub({ destination }) {
      fetched = true;
      mkdirSync(destination);
    },
  }), /unsupported plugin source type: gitlab/);
  assert.equal(fetched, false);
  assert.equal(existsSync(resolve(destinationRoot, "unsupported")), false);
});

test("a concurrent second staging call cannot enter the first claim", (context) => {
  const destinationRoot = mkdtempSync(resolve(tmpdir(), "registry-source-"));
  context.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  const plugin = {
    name: "remote",
    source: {
      type: "github",
      repo: "owner/repository",
      sha: "0123456789abcdef0123456789abcdef01234567",
      root: ".",
    },
  };
  let secondFetched = false;

  const sourceRoot = stageSource({
    plugin,
    repositoryRoot,
    destinationRoot,
    fetchGitHub({ destination }) {
      assert.throws(() => stageSource({
        plugin,
        repositoryRoot,
        destinationRoot,
        fetchGitHub() {
          secondFetched = true;
        },
      }), /plugin staging destination already exists/);
      cpSync(fixture, destination, { recursive: true });
    },
  });

  assert.equal(secondFetched, false);
  assert.equal(existsSync(resolve(sourceRoot, "skills/parent/SKILL.md")), true);
});
