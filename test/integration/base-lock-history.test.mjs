import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolkitRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extractScript = resolve(toolkitRoot, "scripts/extract-base-lock.mjs");
const exactEmptyBase = '{"plugins":{}}\n';

test("allows the exact empty base only when lock history never existed", (context) => {
  const fixture = gitFixture(context);
  const outputPath = resolve(fixture.runnerTemp, "gravit-base-lock.json");

  const result = extract(fixture, outputPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(outputPath, "utf8"), exactEmptyBase);
});

test("extracts the exact regular lock blob from the merge base", (context) => {
  const lock = '{"plugins":{"azure":{"distributionVersion":"1.0.0-gravit.1"}}}\n';
  const fixture = gitFixture(context, { lock });
  const outputPath = resolve(fixture.runnerTemp, "gravit-base-lock.json");

  const result = extract(fixture, outputPath);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(outputPath, "utf8"), lock);
});

test("fails closed when the lock existed in merge-base ancestry and was deleted", (context) => {
  const fixture = gitFixture(context, { lock: '{"plugins":{}}\n' });
  unlinkSync(resolve(fixture.repositoryRoot, "registry/lock.json"));
  commitAll(fixture.repositoryRoot, "delete lock");
  fixture.baseSha = git(fixture.repositoryRoot, ["rev-parse", "HEAD"]).stdout.trim();
  advanceHead(fixture.repositoryRoot, "after-delete.txt");
  const outputPath = resolve(fixture.runnerTemp, "gravit-base-lock.json");

  const result = extract(fixture, outputPath);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /registry\/lock\.json existed in merge-base history and is now absent/);
  assert.equal(existsSync(outputPath), false);
});

test("rejects malformed command lines before consulting Git or writing output", (context) => {
  const root = temporaryRoot(context);
  const runnerTemp = resolve(root, "runner-temp");
  mkdirSync(runnerTemp);
  const outputPath = resolve(runnerTemp, "gravit-base-lock.json");
  const cases = [
    [],
    ["--base-sha"],
    ["--unknown", "value", "--output", outputPath],
    ["--base-sha", "a".repeat(40), "--output", outputPath, "extra"],
    ["--output", outputPath, "--base-sha", "a".repeat(40)],
  ];

  for (const args of cases) {
    const result = spawnExtract({
      args,
      cwd: root,
      runnerTemp,
    });
    assert.equal(result.status, 1, `${args.join(" ")}\n${result.stderr}`);
    assert.match(result.stderr, /usage: node scripts\/extract-base-lock\.mjs --base-sha <full-sha> --output <path>/);
    assert.doesNotMatch(result.stderr, /not a git repository/);
    assert.equal(existsSync(outputPath), false);
  }
});

test("rejects abbreviated and unresolved object IDs with bounded diagnostics", (context) => {
  const fixture = gitFixture(context);
  const outputPath = resolve(fixture.runnerTemp, "gravit-base-lock.json");
  for (const baseSha of ["abc123", "0".repeat(fixture.baseSha.length)]) {
    const result = spawnExtract({
      args: ["--base-sha", baseSha, "--output", outputPath],
      cwd: fixture.repositoryRoot,
      runnerTemp: fixture.runnerTemp,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.length < 1_024, true, result.stderr.length);
    assert.equal(existsSync(outputPath), false);
  }
});

test("requires a fresh direct RUNNER_TEMP output and never overwrites it", (context) => {
  const fixture = gitFixture(context);
  const outputPath = resolve(fixture.runnerTemp, "gravit-base-lock.json");
  writeFileSync(outputPath, "owned\n", { mode: 0o600 });

  const existing = extract(fixture, outputPath);

  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /output must not already exist/);
  assert.equal(readFileSync(outputPath, "utf8"), "owned\n");

  const outsidePath = resolve(dirname(fixture.runnerTemp), "outside.json");
  const outside = extract(fixture, outsidePath);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /output must be the direct RUNNER_TEMP base-lock path/);
  assert.equal(existsSync(outsidePath), false);
});

test("reads base lock bytes inertly and rejects non-regular tree modes", (context) => {
  const root = temporaryRoot(context);
  const marker = resolve(root, "executed");
  const inert = gitFixture(context, {
    root: resolve(root, "inert"),
    lock: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")\n`,
  });
  const inertOutput = resolve(inert.runnerTemp, "gravit-base-lock.json");

  const extracted = extract(inert, inertOutput);
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.equal(existsSync(marker), false);
  assert.match(readFileSync(inertOutput, "utf8"), /^require\(/);

  const executable = gitFixture(context, {
    root: resolve(root, "executable"),
    lock: '{"plugins":{}}\n',
    executableLock: true,
  });
  const executableOutput = resolve(executable.runnerTemp, "gravit-base-lock.json");
  const rejected = extract(executable, executableOutput);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /merge-base registry lock must be a regular non-executable file/);
  assert.equal(existsSync(executableOutput), false);
});

function gitFixture(context, {
  executableLock = false,
  lock,
  root = temporaryRoot(context),
} = {}) {
  const repositoryRoot = resolve(root, "repository");
  const runnerTemp = resolve(root, "runner-temp");
  mkdirSync(repositoryRoot, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  gitOk(repositoryRoot, ["init"]);
  gitOk(repositoryRoot, ["config", "user.name", "Registry Test"]);
  gitOk(repositoryRoot, ["config", "user.email", "registry-test@example.invalid"]);
  writeFileSync(resolve(repositoryRoot, "README.md"), "fixture\n");
  commitAll(repositoryRoot, "initial");
  if (lock !== undefined) {
    mkdirSync(resolve(repositoryRoot, "registry"));
    writeFileSync(resolve(repositoryRoot, "registry/lock.json"), lock);
    if (executableLock) {
      chmodSync(resolve(repositoryRoot, "registry/lock.json"), 0o755);
    }
    commitAll(repositoryRoot, "add lock");
  }
  const baseSha = git(repositoryRoot, ["rev-parse", "HEAD"]).stdout.trim();
  advanceHead(repositoryRoot, "current.txt");
  return {
    repositoryRoot,
    runnerTemp,
    baseSha,
  };
}

function advanceHead(repositoryRoot, name) {
  writeFileSync(resolve(repositoryRoot, name), "current\n");
  commitAll(repositoryRoot, `add ${name}`);
}

function commitAll(repositoryRoot, message) {
  gitOk(repositoryRoot, ["add", "--all"]);
  gitOk(repositoryRoot, ["commit", "-m", message]);
}

function git(repositoryRoot, args) {
  return spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
  });
}

function gitOk(repositoryRoot, args) {
  const result = git(repositoryRoot, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function extract(fixture, outputPath) {
  return spawnExtract({
    args: ["--base-sha", fixture.baseSha, "--output", outputPath],
    cwd: fixture.repositoryRoot,
    runnerTemp: fixture.runnerTemp,
  });
}

function spawnExtract({ args, cwd, runnerTemp }) {
  return spawnSync(process.execPath, [extractScript, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, RUNNER_TEMP: runnerTemp },
    shell: false,
    timeout: 10_000,
  });
}

function temporaryRoot(context) {
  const root = mkdtempSync(resolve(tmpdir(), "registry-lock-history-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
